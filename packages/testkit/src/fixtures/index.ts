import { qpdfEncrypt } from '../oracles.ts';
import * as b from './builders.ts';

export * from './builders.ts';
export { PERSON } from './people.ts';

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
  invoice: { description: 'Invoice with a typo, table and coloured text', build: b.invoiceDoc, expectValid: true },
  'subset-font': { description: 'Embedded subset CID TrueType font', build: b.subsetFontDoc, expectValid: true },
  'multi-column': { description: 'Two text columns', build: b.multiColumnDoc, expectValid: true },
  'rotated-pages': { description: 'Pages with /Rotate 0/90/180/270', build: b.rotatedPagesDoc, expectValid: true },
  'mixed-sizes': { description: 'A4, Letter landscape, A5, custom', build: b.mixedSizesDoc, expectValid: true },
  'rotated-text': { description: 'Text drawn at 30°', build: b.rotatedTextDoc, expectValid: true },
  unicode: { description: 'Greek, Cyrillic, Hebrew (RTL), Polish', build: b.unicodeDoc, expectValid: true },
  bookmarks: { description: 'Two-level outline', build: b.bookmarksDoc, expectValid: true },
  links: { description: 'Internal, web, JavaScript and launch links', build: b.linksDoc, expectValid: true },
  acroform: { description: 'AcroForm with all Release 1 field types', build: () => b.acroFormDoc(), expectValid: true },
  'acroform-prefilled': { description: 'Same form with values', build: () => b.acroFormDoc({ prefilled: true }), expectValid: true },
  'acroform-2': { description: 'Second form with a colliding field name', build: b.acroFormDoc2, expectValid: true },
  xfa: { description: 'AcroForm declaring an XFA packet', build: b.xfaDoc, expectValid: true },
  'flat-form': { description: 'Non-fillable form (lines, boxes, underscores, comb, checkbox)', build: async () => (await b.flatFormDoc()).pdf, expectValid: true },
  scan: { description: 'Image-only pages', build: () => b.scanDoc(), expectValid: true },
  images: { description: 'Text plus PNG and JPEG image objects', build: b.imagesDoc, expectValid: true },
  annotated: { description: 'Annotations written by another tool', build: b.annotatedDoc, expectValid: true },
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
