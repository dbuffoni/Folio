import { InvalidArgumentError, parsePageRanges, splitExt, throwIfAborted } from '@folio/core';
import type { PageIndex, PdfDocument, PdfEngine } from '@folio/ports';

export type SplitMode = { kind: 'ranges'; ranges: string[] } | { kind: 'everyN'; n: number } | { kind: 'single' } | { kind: 'cuts'; after: PageIndex[] };

export interface SplitPart {
  /** 1-based position among the output files. */
  n: number;
  pages: PageIndex[];
  /** 1-based first and last page of the part (for names and the preview list). */
  from: number;
  to: number;
}
export interface PlannedFile extends SplitPart {
  name: string;
  /** The planned name already exists in the output folder. */
  conflict: boolean;
}
export type ConflictPolicy = 'ask' | 'overwrite' | 'autoNumber';
export const DEFAULT_TEMPLATE = '{name}_{n}';

/** Which pages go into which output file (FR-MRG-04). */
export function planSplit(pageCount: number, mode: SplitMode): SplitPart[] {
  if (pageCount < 1) throw new InvalidArgumentError('The document has no pages');
  let groups: PageIndex[][];
  switch (mode.kind) {
    case 'ranges':
      groups = mode.ranges.filter((r) => r.trim() !== '').map((r) => parsePageRanges(r, pageCount));
      if (groups.length === 0) throw new InvalidArgumentError('Add at least one page range', { reason: 'noRanges' });
      break;
    case 'everyN': {
      if (!Number.isInteger(mode.n) || mode.n < 1) throw new InvalidArgumentError('Pages per file must be a whole number of at least 1', { reason: 'badN' });
      groups = [];
      for (let p = 0; p < pageCount; p += mode.n) groups.push(Array.from({ length: Math.min(mode.n, pageCount - p) }, (_, k) => p + k));
      break;
    }
    case 'single':
      groups = Array.from({ length: pageCount }, (_, p) => [p]);
      break;
    case 'cuts': {
      // Scissors between pages: `after` lists the pages after which a cut is made.
      const cuts = [...new Set(mode.after)].filter((p) => p >= 0 && p < pageCount - 1).sort((a, b) => a - b);
      groups = [];
      let start = 0;
      for (const c of [...cuts, pageCount - 1]) {
        groups.push(Array.from({ length: c - start + 1 }, (_, k) => start + k));
        start = c + 1;
      }
      break;
    }
  }
  return groups.map((pages, k) => ({ n: k + 1, pages, from: Math.min(...pages) + 1, to: Math.max(...pages) + 1 }));
}

/** Cut positions equivalent to an every-N split (keeps the thumbnail strip and the mode in sync). */
export function cutsForEveryN(pageCount: number, n: number): PageIndex[] {
  const out: PageIndex[] = [];
  for (let p = n - 1; p < pageCount - 1; p += n) out.push(p);
  return out;
}

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
/** Expands `{name}`, `{n}`, `{from}`, `{to}` (FR-MRG-05). `{n}` is zero-padded to the width of the part count. */
export function expandTemplate(template: string, baseName: string, part: SplitPart, total: number): string {
  const t = template.trim() || DEFAULT_TEMPLATE;
  const unknown = t.match(/\{[^}]*\}/g)?.filter((tok) => !['{name}', '{n}', '{from}', '{to}'].includes(tok));
  if (unknown?.length) throw new InvalidArgumentError(`Unknown token ${unknown[0]}`, { token: unknown[0]!, reason: 'badToken' });
  const pad = String(total).length;
  const name = t
    .replaceAll('{name}', baseName)
    .replaceAll('{n}', String(part.n).padStart(pad, '0'))
    .replaceAll('{from}', String(part.from))
    .replaceAll('{to}', String(part.to))
    .replace(ILLEGAL, '_')
    .trim();
  if (name === '' || name === '.' || name === '..') throw new InvalidArgumentError('The name template produces an empty file name', { reason: 'emptyName' });
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

/**
 * Names for every part, with conflicts resolved per policy (FR-MRG-05):
 * autoNumber appends " (2)", " (3)"… until free; overwrite and ask keep the name and flag `conflict`.
 */
export async function planFiles(parts: SplitPart[], opts: { template: string; sourceName: string; policy: ConflictPolicy; exists: (name: string) => Promise<boolean> }): Promise<PlannedFile[]> {
  const base = splitExt(opts.sourceName)[0];
  const taken = new Set<string>();
  const out: PlannedFile[] = [];
  for (const part of parts) {
    let name = expandTemplate(opts.template, base, part, parts.length);
    const clash = async (n: string): Promise<boolean> => taken.has(n.toLowerCase()) || (await opts.exists(n));
    let conflict = await clash(name);
    // Two parts with the same name can never both be written, whatever the policy.
    if (conflict && (opts.policy === 'autoNumber' || taken.has(name.toLowerCase()))) {
      const [stem, ext] = splitExt(name);
      for (let k = 2; await clash(name); k++) name = `${stem} (${k})${ext}`;
      conflict = false;
    }
    taken.add(name.toLowerCase());
    out.push({ ...part, name, conflict });
  }
  return out;
}

export interface SplitResult {
  written: string[];
  skipped: string[];
}

export class SplitService {
  constructor(private readonly engine: PdfEngine) {}

  /**
   * Writes each planned file through `sink`. Files still flagged `conflict` are written only when
   * `overwrite` says so (policy 'overwrite' passes () => true; 'ask' passes the user's answer).
   */
  async execute(
    doc: PdfDocument,
    files: PlannedFile[],
    sink: (name: string, bytes: Uint8Array) => Promise<void>,
    opts: { overwrite?: (name: string) => boolean | Promise<boolean>; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<SplitResult> {
    const result: SplitResult = { written: [], skipped: [] };
    for (let k = 0; k < files.length; k++) {
      throwIfAborted(opts.signal);
      const file = files[k]!;
      if (file.conflict && !(await (opts.overwrite?.(file.name) ?? false))) {
        result.skipped.push(file.name);
      } else {
        const part = await this.engine.merge([{ doc, pages: file.pages }]);
        try {
          await sink(file.name, await part.save());
        } finally {
          part.dispose();
        }
        result.written.push(file.name);
      }
      opts.onProgress?.(k + 1, files.length);
    }
    return result;
  }
}
