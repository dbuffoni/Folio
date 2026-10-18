// Appends changed and new objects to a PDF as one incremental update (ISO 32000-1 §7.5.6), so every
// earlier revision, and every signature over it, stays byte-for-byte intact.
import type { PDFDocument, PDFObject, PDFRef } from 'pdf-lib';

const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);

/** Tail information of the file being extended. */
export interface Tail {
  /** Offset of the last cross-reference section. */
  startxref: number;
  /** The last cross-reference section is a stream (PDF 1.5) rather than a table. */
  xrefStream: boolean;
  size: number;
}

export class DamagedPdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DamagedPdfError';
  }
}

export function readTail(bytes: Uint8Array): Tail {
  const tailText = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const m = [...tailText.matchAll(/startxref\s+(\d+)\s*%%EOF/g)].pop();
  if (!m) throw new DamagedPdfError('startxref not found');
  const startxref = Number(m[1]);
  const at = new TextDecoder('latin1').decode(bytes.subarray(startxref, startxref + 64));
  if (/^xref\b/.test(at)) {
    const body = new TextDecoder('latin1').decode(
      bytes.subarray(startxref, Math.min(bytes.length, startxref + 65536)),
    );
    const sz = /trailer[\s\S]*?\/Size\s+(\d+)/.exec(body);
    if (!sz) throw new DamagedPdfError('trailer not found');
    return { startxref, xrefStream: false, size: Number(sz[1]) };
  }
  if (/^\d+\s+\d+\s+obj\b/.test(at)) {
    const body = new TextDecoder('latin1').decode(bytes.subarray(startxref, startxref + 2048));
    const sz = /\/Size\s+(\d+)/.exec(body);
    if (!sz || !/\/XRef\b/.test(body)) throw new DamagedPdfError('cross-reference stream not found');
    return { startxref, xrefStream: true, size: Number(sz[1]) };
  }
  throw new DamagedPdfError('startxref does not point to a cross-reference section');
}

/** Output of `build`: the new file and where the pieces landed, so callers can patch placeholders in place. */
export interface Appended {
  bytes: Uint8Array;
  /** Absolute offset of the first byte of every object body (after "N G obj\n"). */
  bodyOffset: Map<number, number>;
}

/**
 * Serialises `objects` (ref → object, streams included) after `original`. `serialize` renders one object
 * to its bytes; this lets callers hand-write the few objects whose byte layout matters.
 */
export function appendUpdate(
  original: Uint8Array,
  tail: Tail,
  doc: PDFDocument,
  objects: Map<PDFRef, PDFObject | Uint8Array>,
): Appended {
  const chunks: Uint8Array[] = [];
  let pos = original.length;
  const push = (b: Uint8Array | string): void => {
    const u = typeof b === 'string' ? latin1(b) : b;
    chunks.push(u);
    pos += u.length;
  };
  const lastByte = original[original.length - 1];
  if (lastByte !== 10 && lastByte !== 13) push('\n');

  const entries: Array<{ num: number; gen: number; offset: number }> = [];
  const bodyOffset = new Map<number, number>();
  const sorted = [...objects.entries()].sort((a, b) => a[0].objectNumber - b[0].objectNumber);
  for (const [ref, obj] of sorted) {
    entries.push({ num: ref.objectNumber, gen: ref.generationNumber, offset: pos });
    push(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
    bodyOffset.set(ref.objectNumber, pos);
    if (obj instanceof Uint8Array) push(obj);
    else push(renderObject(obj));
    push('\nendobj\n');
  }

  const ctx = doc.context;
  const size = Math.max(tail.size, ctx.largestObjectNumber + 1, ...entries.map((e) => e.num + 1));
  const trailerEntries: string[] = [];
  const root = ctx.trailerInfo.Root;
  if (!root) throw new DamagedPdfError('no document catalog');
  trailerEntries.push(`/Root ${root.toString()}`);
  if (ctx.trailerInfo.Info) trailerEntries.push(`/Info ${ctx.trailerInfo.Info.toString()}`);
  if (ctx.trailerInfo.ID) trailerEntries.push(`/ID ${ctx.trailerInfo.ID.toString()}`);
  trailerEntries.push(`/Prev ${tail.startxref}`);

  // Consecutive object numbers share one subsection.
  const runs: Array<typeof entries> = [];
  for (const e of entries) {
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1]!.num + 1 === e.num) run.push(e);
    else runs.push([e]);
  }
  const xrefOffset = pos;
  if (!tail.xrefStream) {
    push('xref\n');
    for (const run of runs) {
      push(`${run[0]!.num} ${run.length}\n`);
      for (const e of run)
        push(`${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n \n`);
    }
    push(`trailer\n<< /Size ${size} ${trailerEntries.join(' ')} >>\n`);
  } else {
    // The stream describes itself too, so it takes the next free number.
    const selfNum = size;
    const all = [...entries, { num: selfNum, gen: 0, offset: xrefOffset }];
    const rows = new Uint8Array(all.length * 7);
    const view = new DataView(rows.buffer);
    all.forEach((e, i) => {
      rows[i * 7] = 1;
      view.setUint32(i * 7 + 1, e.offset);
      view.setUint16(i * 7 + 5, e.gen);
    });
    const allRuns: Array<typeof all> = [];
    for (const e of all) {
      const run = allRuns[allRuns.length - 1];
      if (run && run[run.length - 1]!.num + 1 === e.num) run.push(e);
      else allRuns.push([e]);
    }
    const index = allRuns.map((r) => `${r[0]!.num} ${r.length}`).join(' ');
    push(
      `${selfNum} 0 obj\n<< /Type /XRef /Size ${selfNum + 1} /W [1 4 2] /Index [${index}] ${trailerEntries.join(' ')} /Length ${rows.length} >>\nstream\n`,
    );
    push(rows);
    push('\nendstream\nendobj\n');
  }
  push(`startxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(pos);
  out.set(original, 0);
  let at = original.length;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return { bytes: out, bodyOffset };
}

/** pdf-lib objects print as PDF syntax; streams carry their dictionary and raw contents. */
function renderObject(obj: PDFObject): Uint8Array {
  const asStream = obj as unknown as { dict?: { toString(): string }; getContents?: () => Uint8Array };
  if (asStream.dict && typeof asStream.getContents === 'function') {
    const body = asStream.getContents();
    const dict = asStream.dict.toString().replace(/\/Length\s+\d+(?:\s+\d+\s+R)?/, `/Length ${body.length}`);
    const head = latin1(
      `${dict.includes('/Length') ? dict : dict.replace(/>>\s*$/, `/Length ${body.length} >>`)}\nstream\n`,
    );
    const tailBytes = latin1('\nendstream');
    const out = new Uint8Array(head.length + body.length + tailBytes.length);
    out.set(head, 0);
    out.set(body, head.length);
    out.set(tailBytes, head.length + body.length);
    return out;
  }
  return latin1(obj.toString());
}
