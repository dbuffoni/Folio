import { InvalidArgumentError, type Command } from '@folio/core';
import type { LinkTarget, OutlineEdit, OutlineNode, PageIndex, PdfDocument, Point } from '@folio/ports';
import { checkpointCommand, label } from './commands.ts';

export const BOOKMARK_TITLE_MAX = 512;

export type OutlinePath = number[];
const same = (a: OutlinePath, b: OutlinePath): boolean => a.length === b.length && a.every((v, k) => v === b[k]);
const startsWith = (path: OutlinePath, prefix: OutlinePath): boolean => prefix.length <= path.length && prefix.every((v, k) => v === path[k]);

/** Where the keyboard or a drop wants an entry to go, before any adjustment. */
export type MoveIntent = 'up' | 'down' | 'indent' | 'outdent';

export interface OutlineIssue {
  path: OutlinePath;
  /** The entry points at a page that no longer exists, or at nothing Folio can follow. */
  kind: 'targetRemoved';
}

/** Bookmarks: add, rename, move, nest, delete, retarget (FR-EDT-11, FR-EDT-27). */
export class OutlineService {
  /** Trimmed title, or an error the UI can show (empty, more than 512 characters). */
  validTitle(raw: string): string {
    const t = raw.trim();
    if (t === '') throw new InvalidArgumentError('Give the bookmark a name', { reason: 'emptyBookmark' });
    if ([...t].length > BOOKMARK_TITLE_MAX)
      throw new InvalidArgumentError('Bookmark names have at most 512 characters', { reason: 'longBookmark' });
    return t;
  }

  node(tree: OutlineNode[], path: OutlinePath): OutlineNode | undefined {
    let list = tree;
    let found: OutlineNode | undefined;
    for (const i of path) {
      found = list[i];
      if (!found) return undefined;
      list = found.children;
    }
    return found;
  }
  private siblings(tree: OutlineNode[], parent: OutlinePath): OutlineNode[] | undefined {
    return parent.length === 0 ? tree : this.node(tree, parent)?.children;
  }

  /** Entries whose page is gone: shown with a "Target removed" warning (FR-EDT-27). */
  issues(tree: OutlineNode[]): OutlineIssue[] {
    const out: OutlineIssue[] = [];
    const walk = (list: OutlineNode[], prefix: OutlinePath): void =>
      list.forEach((n, k) => {
        const path = [...prefix, k];
        if (n.target?.kind === 'unsupported' && n.target.reason === 'missing') out.push({ path, kind: 'targetRemoved' });
        walk(n.children, path);
      });
    walk(tree, []);
    return out;
  }

  /** Target for "Add bookmark" and "Set target to current view": the visible page, at the top-left of the view. */
  viewTarget(page: PageIndex, point?: Point, zoom?: number): LinkTarget {
    return { kind: 'page', page, ...(point ? { point } : {}), ...(zoom ? { zoom } : {}) };
  }

  /**
   * Where an entry lands for a keyboard move: Alt+↑/↓ swap with a sibling, Tab makes it the last child of
   * the previous sibling, Shift+Tab places it after its parent. Null when the move is not possible.
   */
  planMove(tree: OutlineNode[], path: OutlinePath, intent: MoveIntent): { parent: OutlinePath; index: number } | null {
    if (path.length === 0 || !this.node(tree, path)) return null;
    const parent = path.slice(0, -1);
    const at = path[path.length - 1]!;
    const sibs = this.siblings(tree, parent)!;
    switch (intent) {
      case 'up':
        return at > 0 ? { parent, index: at - 1 } : null;
      case 'down':
        return at < sibs.length - 1 ? { parent, index: at + 1 } : null;
      case 'indent':
        return at > 0 ? { parent: [...parent, at - 1], index: sibs[at - 1]!.children.length } : null;
      case 'outdent':
        return parent.length > 0 ? { parent: parent.slice(0, -1), index: parent[parent.length - 1]! + 1 } : null;
    }
  }

  /** Path of the entry after an edit, so the selection follows it. */
  pathAfterMove(from: OutlinePath, to: { parent: OutlinePath; index: number }): OutlinePath {
    return [...to.parent, to.index];
  }
  /** Drop target "before entry X" of a drag, expressed as parent and index in the tree after removal. */
  dropPosition(from: OutlinePath, before: OutlinePath | null, tree: OutlineNode[]): { parent: OutlinePath; index: number } | null {
    if (before === null) return { parent: [], index: tree.length - (from.length === 1 ? 1 : 0) };
    if (startsWith(before, from)) return null; // into itself
    const parent = before.slice(0, -1);
    let index = before[before.length - 1]!;
    // Removing the dragged entry shifts later siblings of the same list.
    const fromParent = from.slice(0, -1);
    if (same(parent, fromParent) && from[from.length - 1]! < index) index--;
    // And when the target list sits under a later sibling of the dragged entry's list.
    const adjusted = [...parent];
    const d = from.length - 1;
    if (adjusted.length > d && startsWith(adjusted, fromParent) && adjusted[d]! > from[d]!) adjusted[d]!--;
    return { parent: adjusted, index };
  }

  private edit(title: string, edit: OutlineEdit): Command<void> {
    return checkpointCommand(label(title), 'structural', ({ doc }) => doc.editOutline(edit), { kind: 'outline' });
  }
  add(parent: OutlinePath, index: number, title: string, target?: LinkTarget): Command<void> {
    return this.edit('cmd.bookmark.add', { op: 'add', parent, index, title: this.validTitle(title), target });
  }
  rename(path: OutlinePath, title: string): Command<void> {
    return this.edit('cmd.bookmark.rename', { op: 'rename', path, title: this.validTitle(title) });
  }
  remove(path: OutlinePath): Command<void> {
    return this.edit('cmd.bookmark.delete', { op: 'remove', path });
  }
  move(path: OutlinePath, to: { parent: OutlinePath; index: number }): Command<void> {
    return this.edit('cmd.bookmark.move', { op: 'move', path, parent: to.parent, index: to.index });
  }
  setTarget(path: OutlinePath, target: LinkTarget): Command<void> {
    return this.edit('cmd.bookmark.target', { op: 'setTarget', path, target });
  }

  /** How many entries a delete removes (itself plus descendants), for the confirmation. */
  subtreeSize(tree: OutlineNode[], path: OutlinePath): number {
    const n = this.node(tree, path);
    const count = (x: OutlineNode): number => 1 + x.children.reduce((s, c) => s + count(c), 0);
    return n ? count(n) : 0;
  }
  async load(doc: PdfDocument): Promise<OutlineNode[]> {
    return doc.getOutline();
  }
}
