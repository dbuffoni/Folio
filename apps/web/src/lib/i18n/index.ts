// Message lookup with ICU-style parameters and plurals (SPEC §7.8). English only in Release 1:
// adding a language means adding one JSON file and registering it here.
import type { Msg } from '@folio/core';
import en from './messages/en.json';

const catalogs: Record<string, Record<string, string>> = { en };
let active = catalogs.en!;
let rules = new Intl.PluralRules('en');
let numbers = new Intl.NumberFormat('en');

export function setLocale(locale: string): void {
  const lang = locale.split('-')[0]!;
  active = catalogs[lang] ?? catalogs.en!;
  const tag = catalogs[lang] ? locale : 'en';
  rules = new Intl.PluralRules(tag);
  numbers = new Intl.NumberFormat(tag);
}

type Params = Record<string, string | number | undefined>;

/** `{name}` and `{count, plural, one {…} other {… # …}}`; nested braces inside plural arms are supported one level deep. */
export function format(template: string, params: Params = {}): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{', i);
    if (open < 0) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    let depth = 0;
    let close = open;
    for (; close < template.length; close++) {
      if (template[close] === '{') depth++;
      else if (template[close] === '}' && --depth === 0) break;
    }
    const body = template.slice(open + 1, close);
    const plural = /^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/.exec(body);
    if (plural) {
      const value = Number(params[plural[1]!] ?? 0);
      const arms: Record<string, string> = {};
      for (const m of plural[2]!.matchAll(/(=\d+|\w+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) arms[m[1]!] = m[2]!;
      const arm = arms[`=${value}`] ?? arms[rules.select(value)] ?? arms.other ?? '';
      out += format(arm.replace(/#/g, numbers.format(value)), params);
    } else {
      const v = params[body.trim()];
      out += v === undefined ? `{${body}}` : String(v);
    }
    i = close + 1;
  }
  return out;
}

/** Translates a key. Unknown keys are returned as they are, which makes gaps easy to spot in tests. */
export function t(key: string, params?: Params): string {
  const template = active[key];
  return template === undefined ? key : format(template, params);
}
export const tm = (m: Msg): string => t(m.key, m.params);
export const hasKey = (key: string): boolean => key in active;
export const allKeys = (): string[] => Object.keys(active);
