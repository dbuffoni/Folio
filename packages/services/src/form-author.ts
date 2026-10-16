import { InvalidArgumentError, clampRect, type Command } from '@folio/core';
import type { DocMeta, FieldPatch, FieldSpec, FormField, FormFieldType, PageIndex, Rect } from '@folio/ports';
import { checkpointCommand, label } from './commands.ts';

/** Tools of the Edit form toolbar, in order (FR-FRM-08). */
export const FIELD_TOOLS = ['text', 'multiline', 'checkbox', 'radio', 'dropdown', 'listbox', 'button', 'signature'] as const;
export type FieldTool = (typeof FIELD_TOOLS)[number];

/** Smallest field a user can draw; smaller rectangles are treated as a click and sized by default. */
export const MIN_FIELD = 6;
const DEFAULT_SIZE: Record<FieldTool, { width: number; height: number }> = {
  text: { width: 160, height: 22 },
  multiline: { width: 200, height: 60 },
  checkbox: { width: 16, height: 16 },
  radio: { width: 16, height: 16 },
  dropdown: { width: 160, height: 22 },
  listbox: { width: 140, height: 70 },
  button: { width: 90, height: 26 },
  signature: { width: 200, height: 50 },
};
const BASE_NAME: Record<FieldTool, string> = {
  text: 'Text',
  multiline: 'Text',
  checkbox: 'Checkbox',
  radio: 'Group',
  dropdown: 'Dropdown',
  listbox: 'List',
  button: 'Button',
  signature: 'Signature',
};

export type AuthoringBlock = 'xfa' | 'encrypted';

/** Form authoring: create, edit, move and delete fields as undoable commands (FR-FRM-08/11/16/17). */
export class FormAuthoringService {
  /** Why the document cannot be authored, if it cannot (FR-FRM-09: XFA is shown, never edited). */
  blocked(meta: Pick<DocMeta, 'hasXfa' | 'isEncrypted'>): AuthoringBlock | null {
    return meta.hasXfa ? 'xfa' : meta.isEncrypted ? 'encrypted' : null;
  }

  /** Names a field is allowed to take: not empty, no empty parts, not used, no part of an existing group path. */
  validName(raw: string, taken: ReadonlySet<string>, own?: string): string {
    const name = raw.trim();
    if (name === '' || name.split('.').some((p) => p.trim() === ''))
      throw new InvalidArgumentError('Give the field a name', { reason: 'badFieldName' });
    if (name !== own && taken.has(name)) throw new InvalidArgumentError(`A field named "${name}" already exists`, { reason: 'fieldNameTaken', field: name });
    return name;
  }

  /** Free name derived from `base`: "Name", "Name_2", "Name_3"… */
  uniqueName(base: string, taken: ReadonlySet<string>): string {
    const clean = base.replace(/[.\s]+/g, ' ').trim() || 'Field';
    if (!taken.has(clean)) return clean;
    for (let n = 2; ; n++) if (!taken.has(`${clean}_${n}`)) return `${clean}_${n}`;
  }
  /** A new field's automatic name: the nearest label ("Name"), or `Text1`, `Checkbox2`… (FR-FRM-08). */
  autoName(tool: FieldTool, nearLabel: string | undefined, taken: ReadonlySet<string>): string {
    const words = (nearLabel ?? '')
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3);
    if (words.length) return this.uniqueName(words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(''), taken);
    for (let n = 1; ; n++) if (!taken.has(`${BASE_NAME[tool]}${n}`)) return `${BASE_NAME[tool]}${n}`;
  }

  /** The rectangle for a drag (corners in any order) or a click: default size, kept inside the page. */
  rectFor(tool: FieldTool, a: { x: number; y: number }, b: { x: number; y: number } | null, page: Rect): Rect {
    const dragged = b && Math.abs(a.x - b.x) >= MIN_FIELD && Math.abs(a.y - b.y) >= MIN_FIELD;
    const size = DEFAULT_SIZE[tool];
    const raw: Rect = dragged
      ? { x: Math.min(a.x, b!.x), y: Math.min(a.y, b!.y), width: Math.abs(a.x - b!.x), height: Math.abs(a.y - b!.y) }
      : { x: a.x - size.width / 2, y: a.y - size.height / 2, ...size };
    return clampRect(raw, page);
  }

  /** The spec of a tool: multiline is a text field with the flag. */
  spec(tool: FieldTool, name: string, page: PageIndex, rect: Rect, extra: Partial<FieldSpec> = {}): FieldSpec {
    const type: FormFieldType = tool === 'multiline' ? 'text' : tool;
    return {
      type,
      name,
      page,
      rect,
      ...(tool === 'multiline' ? { multiline: true } : {}),
      ...(tool === 'dropdown' || tool === 'listbox' ? { options: [{ label: 'Option 1', value: 'Option 1' }, { label: 'Option 2', value: 'Option 2' }] } : {}),
      ...(tool === 'button' ? { caption: 'Button' } : {}),
      ...extra,
    };
  }

  private command(title: string, apply: (doc: import('@folio/ports').PdfDocument) => Promise<unknown>): Command<void> {
    return checkpointCommand(label(title), 'form', async ({ doc }) => void (await apply(doc)), { kind: 'form' });
  }
  create(specs: FieldSpec[], title = 'cmd.createField'): Command<void> {
    if (specs.length === 0) throw new InvalidArgumentError('Nothing to create');
    return this.command(title, (doc) => doc.createFields(specs));
  }
  update(field: FormField, patch: FieldPatch): Command<void> {
    return this.command('cmd.editField', (doc) => doc.updateField(field.id, patch));
  }
  rename(field: FormField, name: string, taken: ReadonlySet<string>): Command<void> {
    // A hierarchical name is changed as a whole: the partial name of the last part is what PDFium renames.
    const fresh = this.validName(name, taken, field.name);
    if (fresh.includes('.')) throw new InvalidArgumentError('The partial name cannot contain a dot', { reason: 'badFieldName' });
    return this.command('cmd.renameField', (doc) => doc.renameField(field.id, fresh));
  }
  move(field: FormField, widget: number, rect: Rect): Command<void> {
    return this.command('cmd.moveField', (doc) => doc.setWidgetRect(field.id, widget, rect));
  }
  remove(field: FormField, widget?: number): Command<void> {
    return this.command('cmd.deleteField', (doc) => doc.removeField(field.id, widget));
  }
  /** Keyboard nudge: 1 pt, 10 pt with Shift (FR-FRM-16). */
  nudge(rect: Rect, dx: number, dy: number, shift: boolean, page: Rect): Rect {
    const step = shift ? 10 : 1;
    return clampRect({ ...rect, x: rect.x + dx * step, y: rect.y + dy * step }, page);
  }

  /** Type changes allowed between compatible kinds only: text ↔ multiline, dropdown ↔ list box. */
  compatible(field: FormField): Array<'multiline' | 'singleline' | 'dropdown' | 'listbox'> {
    if (field.type === 'text') return [field.multiline ? 'singleline' : 'multiline'];
    if (field.type === 'dropdown') return ['listbox'];
    if (field.type === 'listbox') return ['dropdown'];
    return [];
  }
  /** Signed documents warn first: any edit invalidates the signatures. */
  needsSignedWarning(meta: Pick<DocMeta, 'hasSignatures'>): boolean {
    return meta.hasSignatures;
  }
}
