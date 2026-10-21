import { InvalidPdfError, IoError, describePageSize, toHex, type Command } from '@folio/core';
import type { CryptoService, DocMeta, EditableMeta, FileRef, FileService, HiddenDataInventory, HiddenDataOptions, HiddenDataReport, PdfDocument, PdfEngine, Size } from '@folio/ports';
import { checkpointCommand, inverseCommand, label } from './commands.ts';

export interface OpenedDocument {
  doc: PdfDocument;
  meta: DocMeta;
  /** Stable across renames: SHA-256 of the first 64 KB plus the size (SPEC §9 recent_files.fingerprint). */
  fingerprint: string;
  byteSize: number;
}
export interface SaveOptions {
  /** Append changes instead of rewriting (keeps existing digital signatures valid, FR-APP-11). */
  incremental?: boolean;
  /** Keep `<name>.bak` with the previous content (setting, default on). */
  backup?: boolean;
}
export interface DocumentProperties {
  meta: DocMeta;
  pageCount: number;
  byteSize?: number;
  /** Distinct page sizes with how many pages use each. */
  pageSizes: Array<{ size: Size; name?: string; landscape: boolean; count: number }>;
  fonts: Array<{ name: string; embedded: boolean; subset: boolean }>;
}

export async function fingerprintOf(bytes: Uint8Array, crypto: CryptoService): Promise<string> {
  const head = bytes.subarray(0, 64 * 1024);
  return `${toHex(await crypto.sha256(head))}-${bytes.length}`;
}

/** Open, save and describe documents (FR-APP-04/11/12/13, FR-SEC-04, FR-VIEW-11). */
export class DocumentService {
  constructor(private readonly deps: { engine: PdfEngine; files: FileService; crypto: CryptoService }) {}

  /** @throws PasswordRequiredError (ask and retry with `password`), InvalidPdfError, IoError */
  async open(ref: FileRef, opts: { password?: string } = {}): Promise<OpenedDocument> {
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.files.read(ref);
    } catch (e) {
      throw e instanceof IoError ? e : new IoError(`Could not read ${ref.name}`, e);
    }
    return this.openBytes(bytes, opts);
  }
  async openBytes(bytes: Uint8Array, opts: { password?: string } = {}): Promise<OpenedDocument> {
    // The password is handed to the engine and never stored by this service.
    const doc = await this.deps.engine.open(bytes, { password: opts.password });
    return { doc, meta: await doc.getMeta(), fingerprint: await fingerprintOf(bytes, this.deps.crypto), byteSize: bytes.length };
  }

  /** Whether saving should default to incremental mode, and why the user must be warned first. */
  savePolicy(meta: DocMeta): { warnSignatures: boolean; incrementalRecommended: boolean } {
    return { warnSignatures: meta.hasSignatures, incrementalRecommended: meta.hasSignatures };
  }

  /** Serialises and verifies: the bytes must reopen with the same page count and a renderable first page. */
  async serialize(doc: PdfDocument, opts: SaveOptions = {}): Promise<Uint8Array> {
    const bytes = await doc.save({ incremental: opts.incremental });
    let check: PdfDocument | undefined;
    try {
      // An incremental save of a protected file still needs its password: reuse the open document for that case.
      check = await this.deps.engine.open(bytes).catch(async (e) => {
        if ((await doc.getMeta()).isEncrypted) return undefined;
        throw e;
      });
      if (check) {
        if (check.pageCount !== doc.pageCount) throw new InvalidPdfError('Saved file has a different page count');
        if (check.pageCount > 0) await check.render(0, { scale: 0.1 });
      }
    } catch (e) {
      throw new IoError('The saved file failed verification and was not written', e);
    } finally {
      check?.dispose();
    }
    return bytes;
  }

  /** Save to `ref`: temp file + rename, optional .bak (FR-APP-04). */
  async save(doc: PdfDocument, ref: FileRef, opts: SaveOptions = {}): Promise<{ byteSize: number }> {
    const bytes = await this.serialize(doc, opts);
    try {
      await this.deps.files.write(ref, bytes, { atomic: true, backup: opts.backup ?? true });
    } catch (e) {
      throw e instanceof IoError ? e : new IoError(`Could not write ${ref.name}`, e);
    }
    return { byteSize: bytes.length };
  }

  /** Export a copy: never touches history or the document's own file. */
  async exportCopy(doc: PdfDocument, ref: FileRef): Promise<{ byteSize: number }> {
    const bytes = await this.serialize(doc);
    await this.deps.files.write(ref, bytes, { atomic: true, backup: false });
    return { byteSize: bytes.length };
  }

  async properties(doc: PdfDocument, byteSize?: number): Promise<DocumentProperties> {
    const sizes = new Map<string, DocumentProperties['pageSizes'][number]>();
    const fonts = new Map<string, DocumentProperties['fonts'][number]>();
    for (let i = 0; i < doc.pageCount; i++) {
      const info = await doc.getPageInfo(i);
      const key = `${info.size.width.toFixed(1)}x${info.size.height.toFixed(1)}`;
      const entry = sizes.get(key) ?? { size: info.size, ...describePageSize(info.size), count: 0 };
      entry.count++;
      sizes.set(key, entry);
      // Fonts are sampled from the first pages: enough for the properties dialog, cheap on big files.
      if (i < 20) {
        for (const run of (await doc.getTextLayer(i)).runs) {
          if (run.font.name) fonts.set(run.font.name, { name: run.font.name, embedded: run.font.isEmbedded, subset: run.font.isSubset });
        }
      }
    }
    return {
      meta: await doc.getMeta(),
      pageCount: doc.pageCount,
      byteSize,
      pageSizes: [...sizes.values()].sort((a, b) => b.count - a.count),
      fonts: [...fonts.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** FR-SEC-04 metadata editor. */
  setMetadata(current: DocMeta, changes: Partial<EditableMeta>): Command<void> {
    const before: Partial<EditableMeta> = {};
    for (const key of Object.keys(changes) as (keyof EditableMeta)[]) before[key] = current[key];
    return inverseCommand(
      label('cmd.editMetadata'),
      'meta',
      ({ doc }) => doc.setMetadata(changes),
      ({ doc }) => doc.setMetadata(before),
      { kind: 'meta' },
    );
  }
  /** FR-SEC-12: what the file carries that the user may not want to share. Read-only. */
  inspectHiddenData(doc: PdfDocument): Promise<HiddenDataInventory> {
    return doc.inspectHiddenData();
  }
  /** FR-SEC-12 "Remove hidden data": one undoable step; the report says what was verified as gone. */
  removeHiddenData(opts: HiddenDataOptions): Command<HiddenDataReport> {
    return checkpointCommand(label('cmd.removeHiddenData'), 'meta', ({ doc }) => doc.removeHiddenData(opts), { kind: 'all' });
  }
  /**
   * FR-SEC-13 "Remove signatures": deletes every signature field of the document (one undo step) and returns
   * how many there were. The caller rewrites the file on the next save, so no signed revision survives.
   */
  removeSignatures(): Command<number> {
    return checkpointCommand(
      label('cmd.removeSignatures'),
      'meta',
      ({ doc }) => doc.removeSignatures(),
      { kind: 'all' },
    );
  }
  /** FR-SEC-04 "Remove all metadata". */
  removeAllMetadata(): Command<void> {
    return checkpointCommand(label('cmd.removeMetadata'), 'meta', ({ doc }) => doc.clearMetadata(), { kind: 'meta' });
  }
}
