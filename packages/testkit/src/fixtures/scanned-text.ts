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
