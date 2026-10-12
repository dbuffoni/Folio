/** Which Unicode code points a TrueType font has glyphs for (cmap formats 4 and 12). */
export function cmapCoverage(font: Uint8Array): (codePoint: number) => boolean {
  const v = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const none = (): boolean => false;
  try {
    const tables = v.getUint16(4);
    let cmap = -1;
    for (let k = 0; k < tables; k++) {
      const rec = 12 + k * 16;
      const tag = String.fromCharCode(font[rec]!, font[rec + 1]!, font[rec + 2]!, font[rec + 3]!);
      if (tag === 'cmap') cmap = v.getUint32(rec + 8);
    }
    if (cmap < 0) return none;
    const subtables = v.getUint16(cmap + 2);
    let best: { offset: number; format: number } | null = null;
    for (let k = 0; k < subtables; k++) {
      const rec = cmap + 4 + k * 8;
      const platform = v.getUint16(rec);
      const encoding = v.getUint16(rec + 2);
      const offset = cmap + v.getUint32(rec + 4);
      const format = v.getUint16(offset);
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
      if (unicode && (format === 12 || format === 4) && (!best || format > best.format)) best = { offset, format };
    }
    if (!best) return none;
    const o = best.offset;
    if (best.format === 12) {
      const groups = v.getUint32(o + 12);
      return (cp) => {
        let lo = 0;
        let hi = groups - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const g = o + 16 + mid * 12;
          if (cp < v.getUint32(g)) hi = mid - 1;
          else if (cp > v.getUint32(g + 4)) lo = mid + 1;
          else return v.getUint32(g + 8) + (cp - v.getUint32(g)) !== 0;
        }
        return false;
      };
    }
    const segX2 = v.getUint16(o + 6);
    const seg = segX2 / 2;
    const ends = o + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    return (cp) => {
      if (cp > 0xffff) return false;
      for (let s = 0; s < seg; s++) {
        if (cp > v.getUint16(ends + s * 2)) continue;
        if (cp < v.getUint16(starts + s * 2)) return false;
        const delta = v.getInt16(deltas + s * 2);
        const range = v.getUint16(ranges + s * 2);
        if (range === 0) return ((cp + delta) & 0xffff) !== 0;
        const at = ranges + s * 2 + range + (cp - v.getUint16(starts + s * 2)) * 2;
        const glyph = v.getUint16(at);
        return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
      }
      return false;
    };
  } catch {
    return none;
  }
}

/** Characters the PDF standard 14 fonts (WinAnsi) can show: used when no font data is bundled. */
export function winAnsiCovers(cp: number): boolean {
  if (cp < 0x100) return true;
  return '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.includes(String.fromCodePoint(cp));
}
