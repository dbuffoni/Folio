import { qpdfEncrypt } from '../oracles.ts';
import * as b from './builders.ts';
import { scannedTextDoc } from './scanned-text.ts';

export * from './builders.ts';
export { PERSON } from './people.ts';
export { scannedTextDoc } from './scanned-text.ts';

export const FIXTURE_PASSWORD = 'open-sesame';
/** Password-protected copy of the invoice (AES-256, made with qpdf). */
export async function encryptedDoc(): Promise<Uint8Array> {
  return qpdfEncrypt(await b.invoiceDoc(), FIXTURE_PASSWORD);
}

export interface FixtureEntry {
  description: string;
  build: () => Promise<Uint8Array>;
  /** false for intentionally broken files: skipped by the validity sweep. */
  expectValid: boolean;
  /** Large fixtures are built only on demand. */
  heavy?: boolean;
  password?: string;
}

/** Registry used by `pnpm fixtures:build`, the validity sweep and folio-cli. */
export const FIXTURES: Record<string, FixtureEntry> = {
  text: { description: '3 pages of standard-font text', build: () => b.textDoc(), expectValid: true },
  'text-25': { description: '25 pages (split every N)', build: () => b.textDoc({ pages: 25, title: 'Twenty-five' }), expectValid: true },
  'body-sizes': { description: 'Three pages with body text at 9, 12 and 18 pt (default stamp sizes)', build: () => b.bodySizesDoc(), expectValid: true },
  invoice: { description: 'Invoice with a typo, table and coloured text', build: b.invoiceDoc, expectValid: true },
  'subset-font': { description: 'Embedded subset CID TrueType font', build: b.subsetFontDoc, expectValid: true },
  'multi-column': { description: 'Two text columns', build: b.multiColumnDoc, expectValid: true },
  'rotated-pages': { description: 'Pages with /Rotate 0/90/180/270', build: b.rotatedPagesDoc, expectValid: true },
  'mixed-sizes': { description: 'A4, Letter landscape, A5, custom', build: b.mixedSizesDoc, expectValid: true },
  'rotated-text': { description: 'Text drawn at 30°', build: b.rotatedTextDoc, expectValid: true },
  unicode: { description: 'Greek, Cyrillic, Hebrew (RTL), Polish', build: b.unicodeDoc, expectValid: true },
  bookmarks: { description: 'Two-level outline', build: b.bookmarksDoc, expectValid: true },
  'bookmarks-actions': { description: 'Outline with named, URI and JavaScript actions, style and colour', build: b.bookmarksActionsDoc, expectValid: true },
  links: { description: 'Internal, web, JavaScript and launch links', build: b.linksDoc, expectValid: true },
  acroform: { description: 'AcroForm with all Release 1 field types', build: () => b.acroFormDoc(), expectValid: true },
  'acroform-prefilled': { description: 'Same form with values', build: () => b.acroFormDoc({ prefilled: true }), expectValid: true },
  'acroform-2': { description: 'Second form with a colliding field name', build: b.acroFormDoc2, expectValid: true },
  xfa: { description: 'AcroForm declaring an XFA packet', build: b.xfaDoc, expectValid: true },
  'dotted-form': { description: 'Word-style form: labels followed by dotted leaders (…………)', build: async () => (await b.flatFormDoc([{ key: 'name', label: 'Il/la sottoscritto/a', kind: 'dots' }, { key: 'tax', label: 'codice fiscale', kind: 'dots' }, { key: 'phone', label: 'Numero di telefono', kind: 'dots' }], 'Iscrizione')).pdf, expectValid: true },
  'flat-form': { description: 'Non-fillable form (lines, boxes, underscores, comb, checkbox)', build: async () => (await b.flatFormDoc()).pdf, expectValid: true },
  scan: { description: 'Image-only pages', build: () => b.scanDoc(), expectValid: true },
  images: { description: 'Text plus PNG and JPEG image objects', build: b.imagesDoc, expectValid: true },
  annotated: { description: 'Annotations written by another tool', build: b.annotatedDoc, expectValid: true },
  'scanned-form': { description: 'Scanned paper form: image only, 5 boxes and 2 check squares', build: async () => (await b.scannedFormDoc()).pdf, expectValid: true },
  'scanned-form-90': { description: 'The same scan with /Rotate 90', build: async () => (await b.scannedFormDoc({ rotate: 90 })).pdf, expectValid: true },
  'scanned-text': { description: 'The multilingual page as a 200 dpi image only (OCR input)', build: () => scannedTextDoc(), expectValid: true },
  multilingual: { description: 'English and Italian paragraphs at 16 pt (OCR tests)', build: b.multilingualDoc, expectValid: true },
  tables: { description: 'A ruled table with a two-line cell, and an aligned table without lines', build: b.tablesDoc, expectValid: true },
  photos: { description: 'Photographs at 300 dpi (colour, grey, one with transparency) and text', build: b.photosDoc, expectValid: true },
  attachment: { description: 'Embedded file attachment', build: b.attachmentDoc, expectValid: true },
  signed: { description: 'Signature field with a dummy signature value', build: b.signedDoc, expectValid: true },
  encrypted: { description: 'AES-256 password protected', build: encryptedDoc, expectValid: true, password: FIXTURE_PASSWORD },
  damaged: { description: 'Truncated file (xref must be rebuilt)', build: b.damagedDoc, expectValid: false },
  garbage: { description: 'Not a PDF', build: async () => b.garbageBytes(), expectValid: false },
  'big-500': { description: '500 pages', build: () => b.bigDoc(500), expectValid: true, heavy: true },
};

const cache = new Map<string, Uint8Array>();
/** Builds (once per process) and returns a copy of a registered fixture. */
export async function fixture(name: keyof typeof FIXTURES | string): Promise<Uint8Array> {
  const entry = FIXTURES[name];
  if (!entry) throw new Error(`Unknown fixture "${name}"`);
  let bytes = cache.get(name);
  if (!bytes) cache.set(name, (bytes = await entry.build()));
  return bytes.slice();
}
export * from './forms-corpus.ts';
