import { InvalidArgumentError } from './errors.ts';

/**
 * Parses a 1-based page range expression such as "1-3,7,10-" into 0-based page indexes.
 * Order and duplicates are preserved ("3,1,1" → [2,0,0]); "5-3" counts down. Empty input = all pages.
 */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const text = input.trim();
  if (text === '') return Array.from({ length: pageCount }, (_, i) => i);
  const out: number[] = [];
  for (const rawPart of text.split(/[,;]/)) {
    const part = rawPart.trim();
    if (part === '') throw new InvalidArgumentError('Empty range', { input });
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!m || (m[1] === undefined && m[3] === undefined)) throw new InvalidArgumentError(`Invalid range "${part}"`, { part });
    const hasDash = m[2] !== undefined;
    const from = m[1] !== undefined ? Number(m[1]) : 1;
    const to = m[3] !== undefined ? Number(m[3]) : hasDash ? pageCount : from;
    if (from < 1 || to < 1 || from > pageCount || to > pageCount) {
      throw new InvalidArgumentError(`Page out of range in "${part}"`, { part, pageCount });
    }
    const step = from <= to ? 1 : -1;
    for (let p = from; step > 0 ? p <= to : p >= to; p += step) out.push(p - 1);
  }
  return out;
}

/** Formats 0-based indexes as a compact 1-based expression: [0,1,2,6] → "1-3,7". */
export function formatPageRanges(pages: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < pages.length) {
    const start = pages[i]!;
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    const end = pages[j]!;
    parts.push(start === end ? String(start + 1) : `${start + 1}-${end + 1}`);
    i = j + 1;
  }
  return parts.join(',');
}

export function isValidPageRanges(input: string, pageCount: number): boolean {
  try {
    parsePageRanges(input, pageCount);
    return true;
  } catch {
    return false;
  }
}
