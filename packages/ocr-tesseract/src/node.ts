// Node entry: language data from the @tesseract.js-data packages on disk (tests, folio-cli).
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { OcrEngine, RasterImage } from '@folio/ports';
import { TesseractOcrEngine } from './index.ts';

const require = createRequire(import.meta.url);

/** `eng` → bytes of `@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz`. */
export async function bundledLanguageData(code: string): Promise<Uint8Array> {
  const pkg = dirname(require.resolve(`@tesseract.js-data/${code}/package.json`));
  return new Uint8Array(await readFile(join(pkg, '4.0.0_best_int', `${code}.traineddata.gz`)));
}

export function createNodeOcrEngine(
  encode: (image: RasterImage) => Promise<Uint8Array>,
  languageData: (code: string) => Promise<Uint8Array> = bundledLanguageData,
): OcrEngine {
  let dir: Promise<string> | undefined;
  const opts: { cachePath?: string } = {};
  return new TesseractOcrEngine({
    languageData,
    encode,
    get cachePath() {
      return opts.cachePath;
    },
    async stageLanguage(code, data) {
      dir ??= mkdtemp(join(tmpdir(), 'folio-ocr-'));
      opts.cachePath = await dir;
      await writeFile(join(opts.cachePath, `${code}.traineddata`), data);
    },
  });
}
