// Digital signing of a PDF (FR-SIG-02, FR-SIG-03): a signature dictionary with /ByteRange and a
// fixed-size /Contents placeholder is appended as an incremental update, the byte ranges are hashed,
// and the CMS SignedData is written into the placeholder (PAdES baseline B-B, adbe.pkcs7.detached).
import type {
  PDFDict as PDFDictT,
  PDFDocument as PDFDocumentT,
  PDFObject,
  PDFRef as PDFRefT,
} from 'pdf-lib';
import type { Rect } from '@folio/ports';
import { certDer, toHex, type SigningIdentity } from './certs.ts';
import { signDetached } from './cms.ts';
import { embedValidationData } from './dss.ts';
import { checkChainRevocation } from './revocation.ts';
import { addTimestamp, requestTimestamp, type BinaryTransport, type TimestampTransport } from './timestamp.ts';
import { appendUpdate, DamagedPdfError, readTail } from './incremental.ts';
import { SigningError } from './errors.ts';
export { SigningError };


export interface SignatureAppearance {
  /** Rectangle in PDF user space on `page`. */
  rect: Rect;
  page: number;
  /** Lines of text, drawn left to right (signer, date, reason, location …). */
  lines?: string[];
  /** Optional artwork (PNG or JPEG) drawn on the left half. */
  image?: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' };
}

export interface SignOptions {
  identity: SigningIdentity;
  /** Existing empty signature field to fill; otherwise a new field is created. */
  fieldName?: string;
  /** Visible appearance for a new field or an existing one; absent = invisible signature. */
  appearance?: SignatureAppearance;
  reason?: string;
  location?: string;
  contactInfo?: string;
  signingTime?: Date;
  /** Extra room reserved in /Contents, e.g. for a timestamp token (bytes). */
  reserve?: number;
  /** Adds an RFC 3161 token from this authority (PAdES-T). Nothing is sent when absent. */
  timestamp?: { url: string; transport: TimestampTransport };
  /** Looks up OCSP/CRL for the chain and stores the answers in /DSS (PAdES-B-LT). Nothing is sent when absent. */
  validationData?: BinaryTransport;
  /** Checks the chain for revocation and refuses a revoked one, without embedding the answers (FR-SIG-06). */
  revocationCheck?: BinaryTransport;
}

export interface SignatureField {
  name: string;
  page: number;
  rect: Rect;
  signed: boolean;
}

async function load(bytes: Uint8Array): Promise<PDFDocumentT> {
  const { PDFDocument, EncryptedPDFError } = await import('pdf-lib');
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError || /encrypted/i.test(String((e as Error)?.message)))
      throw new SigningError('encrypted', 'Encrypted files cannot be signed');
    throw new SigningError('damaged', e instanceof Error ? e.message : 'The file could not be read');
  }
}

/** Every signature field of the file with its page, rectangle and whether it already holds a signature. */
export async function listSignatureFields(bytes: Uint8Array): Promise<SignatureField[]> {
  return scanSignatureFields(await load(bytes));
}

async function scanSignatureFields(doc: PDFDocumentT): Promise<SignatureField[]> {
  const { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFHexString, PDFString } = await import('pdf-lib');
  const n = PDFName.of;
  const out: SignatureField[] = [];
  const pages = doc.getPages();
  const pageOf = new Map(pages.map((p, i) => [p.ref.toString(), i] as const));
  const text = (v: unknown): string =>
    v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
  for (const page of pages) {
    const annots = page.node.lookupMaybe(n('Annots'), PDFArray);
    if (!annots) continue;
    for (let k = 0; k < annots.size(); k++) {
      const w = annots.lookupMaybe(k, PDFDict);
      if (!w || w.lookup(n('Subtype')) !== n('Widget')) continue;
      let ft: unknown;
      let name = '';
      let signed = false;
      let cur: PDFDictT | undefined = w;
      for (let g = 0; cur && g < 32; g++) {
        ft ??= cur.lookup(n('FT'));
        const t = text(cur.lookup(n('T')));
        if (t) name = name ? `${t}.${name}` : t;
        if (cur.lookup(n('V')) instanceof PDFDict) signed = true;
        cur = cur.lookupMaybe(n('Parent'), PDFDict);
      }
      if (ft !== n('Sig')) continue;
      const rect = w.lookupMaybe(n('Rect'), PDFArray);
      const r = rect
        ? Array.from({ length: 4 }, (_, i) =>
            (rect.lookup(i, PDFNumber) as { asNumber(): number }).asNumber(),
          )
        : [0, 0, 0, 0];
      const pRef = w.get(n('P'));
      out.push({
        name,
        page:
          (pRef instanceof PDFRef ? pageOf.get(pRef.toString()) : undefined) ??
          pageOf.get(page.ref.toString()) ??
          0,
        rect: {
          x: Math.min(r[0]!, r[2]!),
          y: Math.min(r[1]!, r[3]!),
          width: Math.abs(r[2]! - r[0]!),
          height: Math.abs(r[3]! - r[1]!),
        },
        signed,
      });
    }
  }
  return out;
}

const WIN_ANSI_SAFE = /[^\x20-\x7e\xa0-\xff]/g;
const pdfText = (s: string): string => s.replace(WIN_ANSI_SAFE, '?').replace(/([\\()])/g, '\\$1');

function pdfDate(d: Date): string {
  const p = (x: number, w = 2) => String(x).padStart(w, '0');
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hexText(s: string): string {
  // UTF-16BE with BOM, as PDF text strings require for anything outside PDFDocEncoding.
  let out = 'FEFF';
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, '0');
  return `<${out}>`;
}

/** Builds the signed file. */
export async function signPdf(input: Uint8Array, opts: SignOptions): Promise<Uint8Array> {
  const { PDFArray, PDFDict, PDFName, PDFRef, PDFNumber, PDFHexString } =
    await import('pdf-lib');
  const n = PDFName.of;
  const doc = await load(input);
  let tail;
  try {
    tail = readTail(input);
  } catch (e) {
    throw new SigningError(
      'damaged',
      e instanceof DamagedPdfError ? e.message : 'The file ends unexpectedly',
    );
  }
  const ctx = doc.context;
  // The previous cross-reference stream (and free entries) own numbers pdf-lib never saw.
  ctx.largestObjectNumber = Math.max(ctx.largestObjectNumber, tail.size - 1);
  const baseLargest = ctx.largestObjectNumber;
  const changed = new Map<PDFRefT, PDFObject>();
  const noteChanged = (ref: PDFRefT, obj: PDFObject) => changed.set(ref, obj);
  const pages = doc.getPages();
  const signingTime = opts.signingTime ?? new Date();
  const signerName = opts.identity.info.commonName;

  // --- field and widget ------------------------------------------------------------------------------
  const sigRef = ctx.nextRef();
  let widgetRef: PDFRefT;
  let widgetDict: PDFDictT;
  let isNew = false;

  const catalog = doc.catalog;
  let acroRef = catalog.get(n('AcroForm'));
  let acro = catalog.lookupMaybe(n('AcroForm'), PDFDict);
  let catalogChanged = false;
  if (!acro) {
    acro = ctx.obj({ Fields: [] });
    acroRef = ctx.register(acro);
    catalog.set(n('AcroForm'), acroRef);
    catalogChanged = true;
  }
  let fields = acro.lookupMaybe(n('Fields'), PDFArray);
  if (!fields) {
    fields = ctx.obj([]);
    acro.set(n('Fields'), fields);
  }

  let pageIndex = opts.appearance?.page ?? 0;
  if (opts.fieldName) {
    const existing = await findField(doc, opts.fieldName);
    if (!existing) throw new SigningError('field-not-found', `No signature field named ${opts.fieldName}`);
    if (existing.signed) throw new SigningError('field-signed', 'The field already holds a signature');
    widgetRef = existing.widgetRef;
    widgetDict = existing.widget;
    // The value lives on the field dictionary (the widget itself when they are merged).
    existing.field.set(n('V'), sigRef);
    noteChanged(existing.fieldRef, existing.field);
    if (existing.widgetRef !== existing.fieldRef) noteChanged(widgetRef, widgetDict);
    pageIndex = existing.page;
  } else {
    isNew = true;
    if (pageIndex < 0 || pageIndex >= pages.length)
      throw new SigningError('bad-page', 'The page does not exist');
    const page = pages[pageIndex]!;
    const rect = opts.appearance?.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    widgetDict = ctx.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFHexString.fromText(await freeFieldName(doc)),
      V: sigRef,
      Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
      F: 132,
      P: page.ref,
    });
    widgetRef = ctx.register(widgetDict);
    fields.push(widgetRef);
    let annots = page.node.lookupMaybe(n('Annots'), PDFArray);
    if (!annots) {
      annots = ctx.obj([]);
      page.node.set(n('Annots'), annots);
    }
    annots.push(widgetRef);
    noteChanged(widgetRef, widgetDict);
    noteChanged(page.ref, page.node);
    const annotsRef = page.node.get(n('Annots'));
    if (annotsRef instanceof PDFRef) noteChanged(annotsRef, annots);
  }
  acro.set(n('SigFlags'), PDFNumber.of(3));
  const acroRefResolved = acroRef instanceof PDFRef ? acroRef : undefined;
  if (acroRefResolved) noteChanged(acroRefResolved, acro);
  if (catalogChanged || !acroRefResolved) noteChanged(ctx.trailerInfo.Root as PDFRefT, catalog);
  const fieldsRef = acro.get(n('Fields'));
  if (fieldsRef instanceof PDFRef) noteChanged(fieldsRef, fields);

  // --- appearance (covered by the digest, so it is built before signing) -----------------------------
  if (opts.appearance && opts.appearance.rect.width > 0 && opts.appearance.rect.height > 0) {
    const app = opts.appearance;
    const w = app.rect.width;
    const h = app.rect.height;
    const lines = app.lines ?? [signerName];
    let imageName: string | undefined;
    let imageRef: PDFRefT | undefined;
    let iw = 0;
    let ih = 0;
    if (app.image) {
      let img;
      try {
        img =
          app.image.mime === 'image/png'
            ? await doc.embedPng(app.image.bytes)
            : await doc.embedJpg(app.image.bytes);
        await img.embed();
      } catch (e) {
        // pdf-lib rejects some broken images with a bare string.
        throw new SigningError('bad-image', e instanceof Error ? e.message : String(e));
      }
      imageRef = img.ref;
      imageName = 'Img0';
      const ratio = img.width / img.height;
      iw = Math.min(w / 2 - 4, (h - 4) * ratio);
      ih = iw / ratio;
    }
    const textX = imageName ? w / 2 + 2 : 4;
    const size = Math.max(6, Math.min(11, (h - 6) / Math.max(lines.length, 1) / 1.25));
    let content = `q 0.97 0.97 0.97 rg 0 0 ${w} ${h} re f Q\nq 0.4 0.4 0.4 RG 0.75 w 0.375 0.375 ${w - 0.75} ${h - 0.75} re S Q\n`;
    if (imageName) content += `q ${iw} 0 0 ${ih} 4 ${(h - ih) / 2} cm /${imageName} Do Q\n`;
    content += 'BT /F0 ' + size + ' Tf 0.1 0.1 0.1 rg\n';
    lines.forEach((line, i) => {
      content += `1 0 0 1 ${textX} ${h - 4 - size * (i + 1) * 1.2 + size * 0.2} Tm (${pdfText(line)}) Tj\n`;
    });
    content += 'ET\n';
    const font = ctx.register(
      ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }),
    );
    const resources: Record<string, unknown> = { Font: { F0: font } };
    if (imageRef && imageName) resources.XObject = { [imageName]: imageRef };
    const stream = ctx.stream(new TextEncoder().encode(content), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, w, h],
      Resources: ctx.obj(resources as never),
    });
    const apRef = ctx.register(stream);
    widgetDict.set(n('AP'), ctx.obj({ N: apRef }));
    if (!isNew) noteChanged(widgetRef, widgetDict);
  }

  // --- the update, with placeholders -----------------------------------------------------------------
  let placeholder = 8192 + (opts.reserve ?? 0) + (opts.timestamp ? 8192 : 0);
  for (let attempt = 0; attempt < 4; attempt++) {
    const sigBody = new TextEncoder().encode(
      `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 0000000000 0000000000 0000000000] /Contents <${'0'.repeat(placeholder * 2)}> /M (${pdfDate(signingTime)}) /Name ${hexText(signerName)}` +
        (opts.reason ? ` /Reason ${hexText(opts.reason)}` : '') +
        (opts.location ? ` /Location ${hexText(opts.location)}` : '') +
        (opts.contactInfo ? ` /ContactInfo ${hexText(opts.contactInfo)}` : '') +
        ' >>',
    );
    const objects = new Map<PDFRefT, PDFObject | Uint8Array>(changed);
    for (const [ref, obj] of ctx.enumerateIndirectObjects())
      if (ref.objectNumber > baseLargest && ref !== sigRef) objects.set(ref, obj);
    objects.set(sigRef, sigBody);
    const { bytes, bodyOffset } = appendUpdate(input, tail, doc, objects);

    const bodyAt = bodyOffset.get(sigRef.objectNumber)!;
    const text = new TextDecoder('latin1').decode(bytes.subarray(bodyAt, bodyAt + sigBody.length));
    const contentsStart = bodyAt + text.indexOf('/Contents <') + '/Contents '.length; // offset of "<"
    const contentsEnd = contentsStart + 1 + placeholder * 2 + 1;
    const range = [0, contentsStart, contentsEnd, bytes.length - contentsEnd];
    const rangeAt = bodyAt + text.indexOf('[0 0000000000');
    const rangeText = `[0 ${String(range[1]).padStart(10, '0')} ${String(range[2]).padStart(10, '0')} ${String(range[3]).padStart(10, '0')}]`;
    bytes.set(new TextEncoder().encode(rangeText), rangeAt);

    const signedData = new Uint8Array(range[1]! + range[3]!);
    signedData.set(bytes.subarray(0, range[1]!), 0);
    signedData.set(bytes.subarray(range[2]!), range[1]!);
    let cms = await signDetached(signedData, opts.identity, { signingTime });
    if (opts.timestamp) cms = addTimestamp(cms, await requestTimestamp(opts.timestamp.transport, opts.timestamp.url, cms));
    if (cms.length > placeholder) {
      placeholder = Math.ceil((cms.length + 512) / 1024) * 1024;
      continue;
    }
    bytes.set(new TextEncoder().encode(toHex(cms).padEnd(placeholder * 2, '0')), contentsStart + 1);
    const transport = opts.validationData ?? opts.revocationCheck;
    if (!transport) return bytes;
    const check = await checkChainRevocation(opts.identity.certificates, transport);
    if (check.state === 'revoked') throw new SigningError('revoked', 'The signing certificate or one above it has been revoked');
    if (!opts.validationData) return bytes;
    return embedValidationData(bytes, { certs: opts.identity.certificates.map(certDer), ocsps: check.ocsps, crls: check.crls, signatureContents: cms });
  }
  throw new SigningError('too-large', 'The signature does not fit its placeholder');
}

interface FoundField {
  field: PDFDictT;
  fieldRef: PDFRefT;
  widget: PDFDictT;
  widgetRef: PDFRefT;
  page: number;
  signed: boolean;
}

async function findField(doc: PDFDocumentT, name: string): Promise<FoundField | undefined> {
  const { PDFArray, PDFDict, PDFName, PDFRef, PDFHexString, PDFString } = await import('pdf-lib');
  const n = PDFName.of;
  const text = (v: unknown): string =>
    v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
  const pages = doc.getPages();
  for (let p = 0; p < pages.length; p++) {
    const annots = pages[p]!.node.lookupMaybe(n('Annots'), PDFArray);
    if (!annots) continue;
    for (let k = 0; k < annots.size(); k++) {
      const wRef = annots.get(k);
      const w = annots.lookupMaybe(k, PDFDict);
      if (!(wRef instanceof PDFRef) || !w || w.lookup(n('Subtype')) !== n('Widget')) continue;
      let full = '';
      let ft: unknown;
      let signed = false;
      let top: PDFDictT = w;
      let topRef: PDFRefT = wRef;
      let cur: PDFDictT | undefined = w;
      for (let g = 0; cur && g < 32; g++) {
        ft ??= cur.lookup(n('FT'));
        const t = text(cur.lookup(n('T')));
        if (t) full = full ? `${t}.${full}` : t;
        if (cur.lookup(n('V')) instanceof PDFDict) signed = true;
        // Value goes on the node that carries /FT (the field), else on the widget.
        if (cur.get(n('FT'))) {
          top = cur;
          const r = cur === w ? wRef : topRef;
          topRef = r;
        }
        const pr = cur.get(n('Parent'));
        const parent: PDFDictT | undefined = cur.lookupMaybe(n('Parent'), PDFDict);
        if (parent && pr instanceof PDFRef) {
          if (!cur.get(n('FT')) && !parent.get(n('FT'))) topRef = pr;
          if (parent.get(n('FT')) && !top.get(n('FT'))) {
            top = parent;
            topRef = pr;
          }
        }
        cur = parent;
      }
      if (ft !== n('Sig') || full !== name) continue;
      return { field: top, fieldRef: topRef, widget: w, widgetRef: wRef, page: p, signed };
    }
  }
  return undefined;
}

async function freeFieldName(doc: PDFDocumentT): Promise<string> {
  const taken = new Set(
    (await listSignatureFields(await doc.save({ useObjectStreams: false }))).map((f) => f.name),
  );
  for (let i = 1; ; i++) if (!taken.has(`Signature${i}`)) return `Signature${i}`;
}
