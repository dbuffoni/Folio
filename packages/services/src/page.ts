import { InvalidArgumentError, PAGE_SIZES, rotatedSize, type Command, type PageSizeName } from '@folio/core';
import type { PageIndex, PdfDocument, PdfEngine, Size } from '@folio/ports';
import { checkpointCommand, inverseCommand, label } from './commands.ts';

const unique = (pages: readonly PageIndex[]): PageIndex[] => [...new Set(pages)].sort((a, b) => a - b);
function assertPages(doc: PdfDocument, pages: readonly PageIndex[]): void {
  if (pages.length === 0) throw new InvalidArgumentError('No pages selected');
  for (const p of pages) {
    if (!Number.isInteger(p) || p < 0 || p >= doc.pageCount) throw new InvalidArgumentError(`Page ${p + 1} does not exist`, { page: p + 1 });
  }
}

/**
 * Order of pages after moving `pages` (kept in ascending order) so the block is inserted before
 * the page currently at `before` (0…count). Pure function shared by commands and drag previews.
 */
export function reorderedIndexes(count: number, pages: readonly PageIndex[], before: number): PageIndex[] {
  const moving = unique(pages);
  const set = new Set(moving);
  const rest = Array.from({ length: count }, (_, i) => i).filter((i) => !set.has(i));
  const at = rest.filter((i) => i < before).length;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/** Applies an arbitrary permutation (`order[k]` = old index of the page that ends at k). */
async function applyOrder(doc: PdfDocument, order: readonly PageIndex[]): Promise<void> {
  const current = Array.from({ length: doc.pageCount }, (_, i) => i);
  for (let target = 0; target < order.length; target++) {
    const at = current.indexOf(order[target]!);
    if (at === target) continue;
    await doc.movePages([at], target);
    current.splice(target, 0, current.splice(at, 1)[0]!);
  }
}
function inverseOrder(order: readonly PageIndex[]): PageIndex[] {
  const inv: PageIndex[] = [];
  order.forEach((old, now) => (inv[old] = now));
  return inv;
}

export type BlankSize = { kind: 'neighbour' } | { kind: 'preset'; name: PageSizeName; landscape?: boolean } | { kind: 'custom'; size: Size };

export interface PageSummary {
  index: PageIndex;
  size: Size;
  /** Size as displayed (rotation applied). */
  displaySize: Size;
  rotation: number;
  label?: string;
  /** true when this page's size differs from the document's most common size (FR-ORG-01 badge). */
  oddSize: boolean;
}

/** Page organisation (FR-ORG-01…10). All mutations are returned as commands for the history. */
export class PageService {
  constructor(private readonly engine: PdfEngine) {}

  async summarize(doc: PdfDocument): Promise<PageSummary[]> {
    const pages: PageSummary[] = [];
    const tally = new Map<string, number>();
    for (let i = 0; i < doc.pageCount; i++) {
      const info = await doc.getPageInfo(i);
      const displaySize = rotatedSize(info.size, info.rotation);
      const key = `${Math.round(displaySize.width)}x${Math.round(displaySize.height)}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
      pages.push({ index: i, size: info.size, displaySize, rotation: info.rotation, label: info.label, oddSize: false });
    }
    const common = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const p of pages) p.oddSize = tally.size > 1 && `${Math.round(p.displaySize.width)}x${Math.round(p.displaySize.height)}` !== common;
    return pages;
  }

  /** FR-ORG-03: move the selected pages so they sit before the page currently at `before`. */
  reorder(doc: PdfDocument, pages: readonly PageIndex[], before: number): Command<PageIndex[]> {
    assertPages(doc, pages);
    if (before < 0 || before > doc.pageCount) throw new InvalidArgumentError('Invalid drop position');
    const order = reorderedIndexes(doc.pageCount, pages, before);
    const moved = unique(pages).map((p) => order.indexOf(p));
    return inverseCommand(
      label('cmd.reorderPages', { count: unique(pages).length }),
      'structural',
      async ({ doc: d }) => {
        await applyOrder(d, order);
        return moved;
      },
      async ({ doc: d }) => applyOrder(d, inverseOrder(order)),
      { kind: 'structure' },
    );
  }

  /** FR-ORG-03 keyboard reorder: shift the selection one position up or down. */
  nudge(doc: PdfDocument, pages: readonly PageIndex[], direction: -1 | 1): Command<PageIndex[]> | null {
    const sel = unique(pages);
    assertPages(doc, sel);
    if (direction < 0 && sel[0] === 0) return null;
    if (direction > 0 && sel[sel.length - 1] === doc.pageCount - 1) return null;
    return this.reorder(doc, sel, direction < 0 ? sel[0]! - 1 : sel[sel.length - 1]! + 2);
  }

  /** FR-ORG-04 */
  rotate(doc: PdfDocument, pages: readonly PageIndex[], deg: 90 | 180 | 270): Command<void> {
    const sel = unique(pages);
    assertPages(doc, sel);
    const back = (360 - deg) as 90 | 180 | 270;
    const cmd = inverseCommand(
      label('cmd.rotatePages', { count: sel.length }),
      'structural',
      ({ doc: d }) => d.rotatePages(sel, deg),
      ({ doc: d }) => d.rotatePages(sel, back),
      { kind: 'pages', pages: sel },
      (next) => {
        // Repeated quarter turns on the same pages collapse into one history entry.
        const other = (next as { rotation?: { pages: PageIndex[]; deg: number } }).rotation;
        if (!other || other.pages.join() !== sel.join()) return null;
        const total = (deg + other.deg) % 360;
        return total === 0 ? null : this.rotate(doc, sel, total as 90 | 180 | 270);
      },
    );
    return Object.assign(cmd, { rotation: { pages: sel, deg } });
  }

  /** FR-ORG-05: refuses to delete every page. */
  delete(doc: PdfDocument, pages: readonly PageIndex[]): Command<void> {
    const sel = unique(pages);
    assertPages(doc, sel);
    if (sel.length >= doc.pageCount) throw new InvalidArgumentError('A document needs at least one page', { reason: 'lastPage' });
    return checkpointCommand(label('cmd.deletePages', { count: sel.length }), 'structural', ({ doc: d }) => d.deletePages(sel), { kind: 'structure' });
  }

  /** FR-ORG-06: each selected page gets a copy right after it. Returns the indexes of the copies. */
  duplicate(doc: PdfDocument, pages: readonly PageIndex[]): Command<PageIndex[]> {
    const sel = unique(pages);
    assertPages(doc, sel);
    return checkpointCommand(
      label('cmd.duplicatePages', { count: sel.length }),
      'structural',
      async ({ doc: d }) => {
        const copies: PageIndex[] = [];
        // Back to front so earlier indexes stay valid.
        for (const p of [...sel].reverse()) await d.importPages(d, [p], p + 1);
        sel.forEach((p, k) => copies.push(p + k + 1));
        return copies;
      },
      { kind: 'structure' },
    );
  }

  /** Resolves a blank-page size request against the neighbouring page (FR-ORG-07). */
  async blankSize(doc: PdfDocument, at: PageIndex, spec: BlankSize): Promise<Size> {
    if (spec.kind === 'custom') return spec.size;
    if (spec.kind === 'preset') {
      const s = PAGE_SIZES[spec.name];
      return spec.landscape ? { width: s.height, height: s.width } : { ...s };
    }
    if (doc.pageCount === 0) return { ...PAGE_SIZES.A4 };
    const info = await doc.getPageInfo(Math.min(Math.max(at - 1, 0), doc.pageCount - 1));
    return rotatedSize(info.size, info.rotation);
  }

  /** FR-ORG-07 */
  insertBlank(doc: PdfDocument, at: PageIndex, size: Size): Command<PageIndex> {
    if (at < 0 || at > doc.pageCount) throw new InvalidArgumentError('Invalid insert position');
    if (!(size.width >= 72 && size.height >= 72 && size.width <= 14400 && size.height <= 14400)) {
      throw new InvalidArgumentError('Page size must be between 1 and 200 inches', { reason: 'pageSize' });
    }
    return inverseCommand(
      label('cmd.insertBlank'),
      'structural',
      async ({ doc: d }) => {
        await d.insertBlank(at, size);
        return at;
      },
      ({ doc: d }) => d.deletePages([at]),
      { kind: 'structure' },
    );
  }

  /** FR-ORG-08: insert `pages` of `source` before index `at`. The source must stay open until applied. */
  insertFrom(doc: PdfDocument, source: PdfDocument, pages: readonly PageIndex[], at: PageIndex): Command<PageIndex[]> {
    assertPages(source, pages);
    if (at < 0 || at > doc.pageCount) throw new InvalidArgumentError('Invalid insert position');
    const list = [...pages];
    return checkpointCommand(
      label('cmd.insertPages', { count: list.length }),
      'structural',
      async ({ doc: d }) => {
        await d.importPages(source, list, at);
        return list.map((_, k) => at + k);
      },
      { kind: 'structure' },
    );
  }

  /** FR-ORG-09: new document made of the selected pages (the source is not changed). */
  async extract(doc: PdfDocument, pages: readonly PageIndex[]): Promise<PdfDocument> {
    assertPages(doc, pages);
    return this.engine.merge([{ doc, pages: [...pages] }]);
  }

  /** FR-ORG-10: replace the selected pages with `pages` of `source`, at the position of the first one. */
  replace(doc: PdfDocument, target: readonly PageIndex[], source: PdfDocument, pages: readonly PageIndex[]): Command<PageIndex[]> {
    const sel = unique(target);
    assertPages(doc, sel);
    assertPages(source, pages);
    const list = [...pages];
    return checkpointCommand(
      label('cmd.replacePages', { count: sel.length }),
      'structural',
      async ({ doc: d }) => {
        // Insert first so the document is never empty, then remove the originals (shifted by the insert).
        const at = sel[0]!;
        await d.importPages(source, list, at);
        await d.deletePages(sel.map((p) => p + list.length));
        return list.map((_, k) => at + k);
      },
      { kind: 'structure' },
    );
  }
}

// ---- selection helpers (FR-ORG-02) -----------------------------------------------------------

export function selectRange(anchor: PageIndex, to: PageIndex): PageIndex[] {
  const [a, b] = anchor <= to ? [anchor, to] : [to, anchor];
  return Array.from({ length: b - a + 1 }, (_, k) => a + k);
}
export function selectParity(count: number, parity: 'odd' | 'even'): PageIndex[] {
  // "Odd" means page numbers 1, 3, 5… as the user sees them.
  return Array.from({ length: count }, (_, i) => i).filter((i) => (i % 2 === 0) === (parity === 'odd'));
}
export function toggle(selection: readonly PageIndex[], page: PageIndex): PageIndex[] {
  return selection.includes(page) ? selection.filter((p) => p !== page) : [...selection, page].sort((a, b) => a - b);
}
