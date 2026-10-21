import { PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';
import { sharedEngine } from '../engine.ts';
import { multilingualDoc } from './builders.ts';

/**
 * The multilingual page as a scan: the vector page is rendered to pixels (grey-scale JPEG-free PNG at
 * `dpi`) and placed as the only content of a new page, so the text exists only as a picture. OCR tests
 * recognise it and compare with `OCR_TEXT`.
 */
export async function scannedTextDoc(opts: { dpi?: number; rotate?: 0 | 90 | 180 | 270 } = {}): Promise<Uint8Array> {
  const dpi = opts.dpi ?? 200;
  const engine = await sharedEngine();
  const src = await engine.open(await multilingualDoc());
  const img = await src.render(0, { scale: dpi / 72 });
  src.dispose();
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date('2026-01-15T10:30:00Z'));
  doc.setModificationDate(new Date('2026-01-15T10:30:00Z'));
  const page = doc.addPage([612, 792]);
  page.drawImage(await doc.embedPng(PNG.sync.write(png)), { x: 0, y: 0, width: 612, height: 792 });
  if (opts.rotate) {
    const { degrees } = await import('pdf-lib');
    page.setRotation(degrees(opts.rotate));
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * Any document as a picture: every page is rendered to pixels at `dpi` and placed as the only content of a new
 * page of the same size, so nothing but the image remains (a scan of that document).
 */
export async function pictureOf(pdf: Uint8Array, opts: { dpi?: number; jpeg?: boolean } = {}): Promise<Uint8Array> {
  const dpi = opts.dpi ?? 150;
  const engine = await sharedEngine();
  const src = await engine.open(pdf);
  try {
    const out = await PDFDocument.create();
    out.setCreationDate(new Date('2026-01-15T10:30:00Z'));
    out.setModificationDate(new Date('2026-01-15T10:30:00Z'));
    for (let p = 0; p < src.pageCount; p++) {
      const info = await src.getPageInfo(p);
      const img = await src.render(p, { scale: dpi / 72, annotations: false, forms: false });
      const png = new PNG({ width: img.width, height: img.height });
      png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
      const page = out.addPage([info.size.width, info.size.height]);
      page.drawImage(await out.embedPng(PNG.sync.write(png)), { x: 0, y: 0, width: info.size.width, height: info.size.height });
    }
    return await out.save({ useObjectStreams: false });
  } finally {
    src.dispose();
  }
}
