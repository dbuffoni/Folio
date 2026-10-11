/** Platform-independent key chord. `mod` is Ctrl on Linux/Windows and ⌘ on macOS (SPEC §7.6). */
export interface Chord {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}
/** The fields of a DOM KeyboardEvent the keymap needs (kept structural so there is no DOM dependency). */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Parses "Mod+Shift+S", "F4", "Del", "Mod+=". */
export function parseChord(text: string): Chord {
  const parts = text.split('+').map((p) => p.trim());
  // "Mod+=" and "Mod++" keep their last character as the key.
  const key = text.endsWith('+') ? '+' : parts[parts.length - 1]!;
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  const names: Record<string, string> = { del: 'Delete', esc: 'Escape', space: ' ', enter: 'Enter', tab: 'Tab' };
  return { key: names[key.toLowerCase()] ?? (key.length === 1 ? key.toLowerCase() : key), mod: mods.has('mod'), shift: mods.has('shift'), alt: mods.has('alt') };
}

export function chordOfEvent(e: KeyEventLike, isMac: boolean): Chord {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return { key, mod: isMac ? e.metaKey : e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
}
export function sameChord(a: Chord, b: Chord): boolean {
  // Shift is implied by characters such as "+" or "?", so it is not compared for those.
  const shiftMatters = !(a.key.length === 1 && !/[a-z0-9]/.test(a.key));
  return a.key === b.key && !!a.mod === !!b.mod && !!a.alt === !!b.alt && (!shiftMatters || !!a.shift === !!b.shift);
}
/** "Ctrl+Shift+S" / "⌘⇧S" for tooltips and the palette. */
export function formatChord(text: string, isMac: boolean): string {
  const c = parseChord(text);
  const key = c.key === ' ' ? 'Space' : c.key === 'Delete' ? 'Del' : c.key === 'Escape' ? 'Esc' : c.key.length === 1 ? c.key.toUpperCase() : c.key;
  if (isMac) return `${c.mod ? '⌘' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${key}`;
  return [c.mod ? 'Ctrl' : '', c.alt ? 'Alt' : '', c.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

/** Shortcuts the browser or OS owns; a command may not claim them (SPEC §7.6). */
export const RESERVED = ['Mod+Q', 'Mod+N', 'Mod+T', 'Mod+R', 'Mod+L', 'Mod+Tab', 'Alt+F4', 'F11', 'F12'];
