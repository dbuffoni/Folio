// Node entry point: loads the WASM binary and the bundled fonts from disk.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PdfiumEngine } from './engine.ts';
import type { FontData, FontVariant } from './fonts.ts';

const FONT_DIR = fileURLToPath(new URL('../../../assets/fonts/liberation/', import.meta.url));
const FILES: Record<string, Record<FontVariant, string>> = {
  sans: { regular: 'LiberationSans-Regular', bold: 'LiberationSans-Bold', italic: 'LiberationSans-Italic', boldItalic: 'LiberationSans-BoldItalic' },
  serif: { regular: 'LiberationSerif-Regular', bold: 'LiberationSerif-Bold', italic: 'LiberationSerif-Italic', boldItalic: 'LiberationSerif-BoldItalic' },
  mono: { regular: 'LiberationMono-Regular', bold: 'LiberationMono-Bold', italic: 'LiberationMono-Italic', boldItalic: 'LiberationMono-BoldItalic' },
};

export async function loadBundledFonts(dir = FONT_DIR): Promise<FontData> {
  const out: Record<string, Record<string, Uint8Array>> = {};
  for (const [family, variants] of Object.entries(FILES)) {
    out[family] = {};
    for (const [variant, file] of Object.entries(variants)) out[family][variant] = await readFile(`${dir}${file}.ttf`);
  }
  return out as FontData;
}

export async function loadWasm(): Promise<Uint8Array> {
  const require = createRequire(import.meta.url);
  return readFile(require.resolve('@embedpdf/pdfium/pdfium.wasm'));
}

export async function createNodeEngine(opts: { fonts?: FontData | false } = {}): Promise<PdfiumEngine> {
  const fonts = opts.fonts === false ? undefined : (opts.fonts ?? (await loadBundledFonts()));
  return PdfiumEngine.create({ wasmBinary: await loadWasm(), fonts });
}
