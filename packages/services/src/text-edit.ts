import { InvalidArgumentError, UnsupportedFeatureError, containsPoint, inflate, type Command, type Msg } from '@folio/core';
import type { ObjId, PageIndex, PageInfo, Point, TextEditFont, TextLayer, TextLine, TextRun, TextSpec, TextStyle } from '@folio/ports';
import { checkpointCommand, inverseCommand, label } from './commands.ts';

export interface EditableLine {
  index: number;
  line: TextLine;
  /** Font and size of the first run, for the hover tooltip and the floating badge. */
  fontName: string;
  fontSize: number;
  /** Text to seed the inline editor with (runs joined, gaps turned into spaces). */
  text: string;
  /** Why the line cannot be edited, as a message key; undefined when it can. */
  blocked?: Msg;
}
export interface LineEditResult {
  page: PageIndex;
  objId: ObjId;
  text: string;
  font: TextEditFont;
  width: number;
  /** Points available for the line before it runs into the margin or the next object. */
  available: number;
  overflow: boolean;
  /** Size factor that would make the text fit, when ≥ 0.85 (FR-EDT-04 allows at most 15 % shrink). */
  shrinkFactor?: number;
  missingGlyphs: boolean;
}

/** Runs of a line joined the way a reader sees them: a visible gap between two objects is a space. */
export function joinRuns(runs: TextRun[]): string {
  let out = '';
  runs.forEach((r, k) => {
    const prev = runs[k - 1];
    if (prev) {
      const gap = r.rect.x - (prev.rect.x + prev.rect.width);
      if (gap > prev.fontSize * 0.18 && !/\s$/.test(out) && !/^\s/.test(r.text)) out += ' ';
    }
    out += r.text;
  });
  return out.replace(/[\r\n]+/g, '');
}

/** Line-level text editing (FR-EDT-01…04, 06, 08). Honest about what cannot be done. */
export class TextEditService {
  /** Lines of a page as the Edit text tool sees them. Throws for scanned pages (FR-EDT-08). */
  lines(layer: TextLayer): EditableLine[] {
    if (layer.isScanned || (layer.lines.length === 0 && layer.isScanned)) throw new UnsupportedFeatureError('scannedText');
    return layer.lines.map((line, index) => {
      const runs = line.runs.map((i) => layer.runs[i]!);
      const first = runs[0]!;
      let blocked: Msg | undefined;
      if (Math.abs(first.angle) >= 0.5) blocked = { key: 'edit.blocked.rotated' };
      else if (runs.some((r) => r.objId === undefined)) blocked = { key: 'edit.blocked.nested' };
      else if (!line.editable) blocked = { key: 'edit.blocked.other' };
      return { index, line, fontName: first.font.name, fontSize: first.fontSize, text: joinRuns(runs), blocked };
    });
  }
  /** The line under the pointer, with a little slack so thin text is easy to hit. */
  lineAt(lines: EditableLine[], p: Point): EditableLine | undefined {
    return lines.find((l) => containsPoint(inflate(l.line.rect, 1.5, 2), p));
  }
  /** Caret position (character offset in the seeded text) for a click inside the line. */
  caretAt(layer: TextLayer, target: EditableLine, p: Point): number {
    const runs = target.line.runs.map((i) => layer.runs[i]!);
    let offset = 0;
    let seeded = '';
    for (let k = 0; k < runs.length; k++) {
      const r = runs[k]!;
      const before = joinRuns(runs.slice(0, k + 1)).length - r.text.replace(/[\r\n]+/g, '').length;
      for (let c = 0; c < r.charCount; c++) {
        const box = layer.chars[r.charStart + c]!.rect;
        if (box.width > 0 && p.x < box.x + box.width / 2) return before + c;
      }
      offset = before + r.text.replace(/[\r\n]+/g, '').length;
      seeded = joinRuns(runs.slice(0, k + 1));
    }
    return Math.min(offset, seeded.length);
  }

  /**
   * Space the edited line may use: up to the next object on the same baseline, or to the page's
   * right margin (the larger of 36 pt and the page's own smallest right gap is not known, so 36 pt).
   */
  availableWidth(layer: TextLayer, line: TextLine, page: PageInfo): number {
    const lineRight = line.rect.x + line.rect.width;
    let limit = page.cropBox.x + page.cropBox.width - 36;
    for (const other of layer.lines) {
      if (other === line) continue;
      const sameRow = other.rect.y < line.rect.y + line.rect.height && other.rect.y + other.rect.height > line.rect.y;
      if (sameRow && other.rect.x >= lineRight - 0.5) limit = Math.min(limit, other.rect.x - 2);
    }
    return Math.max(line.rect.width, limit - line.rect.x);
  }

  /**
   * Replaces the text of one line (FR-EDT-02). The first object receives the whole new text; the
   * line's other objects are removed from the content stream. One undo step restores the page exactly.
   */
  editLine(page: PageIndex, layer: TextLayer, target: EditableLine, newText: string, pageInfo: PageInfo, style?: TextStyle): Command<LineEditResult> {
    if (target.blocked) throw new UnsupportedFeatureError(target.blocked.key);
    const text = newText.replace(/[\r\n]+/g, ' ');
    if (text.trim() === '') throw new InvalidArgumentError('Use Delete to remove a line', { reason: 'emptyText' });
    const runs = target.line.runs.map((i) => layer.runs[i]!);
    const ids = [...new Set(runs.map((r) => r.objId!))];
    const available = this.availableWidth(layer, target.line, pageInfo);
    return checkpointCommand(
      label('cmd.editText'),
      'content',
      async ({ doc }) => {
        // Highest indexes first so the first object's index stays valid.
        const index = (id: ObjId): number => Number(id.slice(1));
        for (const id of ids.slice(1).sort((a, b) => index(b) - index(a))) await doc.removeObject(page, id);
        const removedBefore = ids.slice(1).filter((id) => index(id) < index(ids[0]!)).length;
        const firstId = `o${index(ids[0]!) - removedBefore}`;
        const res = await doc.replaceTextRun(page, firstId, text, style);
        const overflow = res.width > available + 0.5;
        const factor = available / res.width;
        return {
          page,
          objId: res.objId,
          text,
          font: res.font,
          width: res.width,
          available,
          overflow,
          shrinkFactor: overflow && factor >= 0.85 ? Math.floor(factor * 1000) / 1000 : undefined,
          missingGlyphs: res.warnings.includes('missingGlyph'),
        };
      },
      { kind: 'pages', pages: [page] },
    );
  }

  /** "Shrink to fit" after an overflowing edit: re-applies the text at a smaller size (≤ 15 %). */
  shrinkToFit(result: LineEditResult, currentSize: number): Command<void> {
    if (!result.shrinkFactor) throw new InvalidArgumentError('The text cannot be shrunk enough to fit', { reason: 'cannotShrink' });
    const fontSize = currentSize * result.shrinkFactor;
    const family = result.font.kind === 'substituted' ? (/(Serif)/.test(result.font.to) ? 'serif' : /Mono/.test(result.font.to) ? 'mono' : 'sans') : undefined;
    return checkpointCommand(
      label('cmd.shrinkText'),
      'content',
      async ({ doc }) => void (await doc.replaceTextRun(result.page, result.objId, result.text, family ? { fontSize, fontFamily: family } : { fontSize })),
      { kind: 'pages', pages: [result.page] },
    );
  }

  /** Remove a whole line (true object removal). */
  deleteLine(page: PageIndex, layer: TextLayer, target: EditableLine): Command<void> {
    if (target.blocked) throw new UnsupportedFeatureError(target.blocked.key);
    const ids = [...new Set(target.line.runs.map((i) => layer.runs[i]!.objId!))].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    return checkpointCommand(label('cmd.deleteText'), 'content', async ({ doc }) => {
      for (const id of ids) await doc.removeObject(page, id);
    }, { kind: 'pages', pages: [page] });
  }

  /** Add text as page content (FR-EDT-06, "Add as page content" selected). */
  addText(page: PageIndex, spec: TextSpec): Command<ObjId> {
    if (spec.text.trim() === '') throw new InvalidArgumentError('Type some text first', { reason: 'emptyText' });
    let created: ObjId | undefined;
    return inverseCommand(
      label('cmd.addText'),
      'content',
      async ({ doc }) => (created = await doc.addText(page, spec)),
      async ({ doc }) => {
        if (created) await doc.removeObject(page, created);
      },
      { kind: 'pages', pages: [page] },
    );
  }
}

/** Badge text parts for the inline editor: "Arial 11pt" or "Arial → Liberation Sans" (amber). */
export function fontBadge(font: TextEditFont, size: number): { text: string; substituted: boolean } {
  return font.kind === 'reused' ? { text: `${font.fontName} ${Math.round(size * 10) / 10}pt`, substituted: false } : { text: `${font.from || '?'} → ${font.to}`, substituted: true };
}
