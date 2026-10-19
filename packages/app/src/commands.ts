import type { Msg } from '@folio/core';
import { chordOfEvent, parseChord, sameChord, type KeyEventLike } from './keymap.ts';

/** Keys of the usage permissions a command can require. */
export type PermissionKey = 'print' | 'copy' | 'modify' | 'annotate' | 'fillForms' | 'assemble';

export type CommandGroup = 'file' | 'edit' | 'view' | 'mode' | 'tool' | 'pages' | 'annotate' | 'sign' | 'forms' | 'export' | 'settings' | 'help';

/** An action reachable from menus, toolbars, shortcuts and the command palette (FR-APP-09). */
export interface AppCommand<Ctx> {
  id: string;
  /** i18n key of the title. */
  title: string;
  group: CommandGroup;
  /** Lucide icon name. */
  icon?: string;
  /** Default shortcut, e.g. "Mod+Shift+S" (Appendix A). */
  shortcut?: string;
  /** Extra words the palette matches (English, lower case). */
  keywords?: string;
  /** Shortcut works while typing in a text field (Save, Undo…). Single-letter tool keys never do. */
  global?: boolean;
  /** Hidden and inactive when false. */
  when?: (ctx: Ctx) => boolean;
  /** Usage permission of the document this command needs (FR-SEC-07): shown but disabled, with the reason, when denied. */
  needs?: PermissionKey | ((ctx: Ctx) => PermissionKey | undefined);
  run: (ctx: Ctx) => void | Promise<void>;
}

export interface PaletteItem<Ctx> {
  command: AppCommand<Ctx>;
  title: string;
  score: number;
  /** i18n key of why the command is disabled; absent when it can run. */
  denied?: string;
}

/** Subsequence match with bonuses for word starts and consecutive characters; 0 = no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (q === '') return 1;
  const t = text.toLowerCase();
  if (t.includes(query.toLowerCase().trim())) return 1000 - t.indexOf(query.toLowerCase().trim()) - t.length * 0.01;
  let score = 0;
  let ti = 0;
  let streak = 0;
  const wordStart = (i: number): boolean => i === 0 || /[\s\-_/]/.test(t[i - 1]!);
  for (const ch of q) {
    // Loose matches stay anchored: the first letter opens a word and later letters are at a word start or close
    // to the previous one, so "rot" does not find "Document properties" but "ps" still finds "Open pages".
    let found = t.indexOf(ch, ti);
    while (found >= 0 && !(wordStart(found) || (ti > 0 && found - ti <= 3))) found = t.indexOf(ch, found + 1);
    if (found < 0) return 0;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 6 + (wordStart(found) ? 12 : 0) - Math.min(8, found - ti);
    ti = found + 1;
  }
  return Math.max(1, score - t.length * 0.05);
}

export class CommandRegistry<Ctx> {
  private commands = new Map<string, AppCommand<Ctx>>();

  /** The one place that decides permission-based disabling: returns the i18n key of the reason. */
  constructor(private readonly denyReason: (needs: PermissionKey, ctx: Ctx) => string | undefined = () => undefined) {}

  /** Why an available command is disabled, if it is. */
  denial(id: string, ctx: Ctx): string | undefined {
    const c = this.commands.get(id);
    const needs = typeof c?.needs === 'function' ? c.needs(ctx) : c?.needs;
    return needs ? this.denyReason(needs, ctx) : undefined;
  }

  register(...commands: AppCommand<Ctx>[]): this {
    for (const c of commands) {
      if (this.commands.has(c.id)) throw new Error(`Duplicate command id ${c.id}`);
      this.commands.set(c.id, c);
    }
    return this;
  }
  get(id: string): AppCommand<Ctx> | undefined {
    return this.commands.get(id);
  }
  all(): AppCommand<Ctx>[] {
    return [...this.commands.values()];
  }
  available(ctx: Ctx): AppCommand<Ctx>[] {
    return this.all().filter((c) => !c.when || c.when(ctx));
  }
  isEnabled(id: string, ctx: Ctx): boolean {
    const c = this.commands.get(id);
    return !!c && (!c.when || c.when(ctx)) && !this.denial(id, ctx);
  }

  /** Runs a command if it exists and is available. Returns whether it ran. */
  async run(id: string, ctx: Ctx): Promise<boolean> {
    const c = this.commands.get(id);
    if (!c || (c.when && !c.when(ctx)) || this.denial(id, ctx)) return false;
    await c.run(ctx);
    return true;
  }

  /** Command for a key press, honouring `when` and text-field focus. */
  match(e: KeyEventLike, ctx: Ctx, opts: { isMac: boolean; typing: boolean }): AppCommand<Ctx> | undefined {
    const chord = chordOfEvent(e, opts.isMac);
    return this.all().find((c) => {
      if (!c.shortcut || !sameChord(parseChord(c.shortcut), chord)) return false;
      if (opts.typing && !c.global) return false;
      return (!c.when || c.when(ctx)) && !this.denial(c.id, ctx);
    });
  }

  /** Palette search: every available command, best match first; an empty query lists them by group. */
  search(query: string, ctx: Ctx, translate: (key: string) => string, limit = 50): PaletteItem<Ctx>[] {
    const items: PaletteItem<Ctx>[] = [];
    for (const command of this.available(ctx)) {
      const title = translate(command.title);
      const score = Math.max(fuzzyScore(query, title), fuzzyScore(query, command.keywords ?? '') * 0.8, fuzzyScore(query, command.id.replace(/[.:]/g, ' ')) * 0.5);
      if (score > 0) items.push({ command, title, score, denied: this.denial(command.id, ctx) });
    }
    if (query.trim() === '') return items.slice(0, limit);
    return items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
  }

  /** Shortcuts used by more than one always-available command, and reserved ones (lint for the keymap). */
  conflicts(reserved: string[] = []): string[] {
    const seen = new Map<string, string>();
    const out: string[] = [];
    const norm = (s: string): string => JSON.stringify(parseChord(s));
    const blocked = new Set(reserved.map(norm));
    for (const c of this.all()) {
      if (!c.shortcut) continue;
      const key = norm(c.shortcut);
      if (blocked.has(key)) out.push(`${c.id}: ${c.shortcut} is reserved`);
      const other = seen.get(key);
      if (other) out.push(`${c.id} and ${other} share ${c.shortcut}`);
      else seen.set(key, c.id);
    }
    return out;
  }
}

export interface Described {
  title: Msg;
}
