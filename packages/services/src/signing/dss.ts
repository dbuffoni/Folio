// Long-term validation data (FR-SIG-08): certificates, OCSP responses and CRLs stored in the document
// security store (/DSS) as one more incremental update after the signature, so the signature can be
// validated later without the network (PAdES-B-LT).
import type { PDFArray as PDFArrayT, PDFDict as PDFDictT, PDFRef as PDFRefT } from 'pdf-lib';
import { toHex } from './certs.ts';
import { appendUpdate, readTail } from './incremental.ts';

export interface ValidationEvidence {
  certs: Uint8Array[];
  ocsps: Uint8Array[];
  crls: Uint8Array[];
  /** /Contents of the signature the data belongs to; its SHA-1 names the VRI entry. */
  signatureContents?: Uint8Array;
}

export async function embedValidationData(
  pdf: Uint8Array,
  evidence: ValidationEvidence,
): Promise<Uint8Array> {
  const { PDFDocument, PDFDict, PDFArray, PDFName } = await import('pdf-lib');
  const n = PDFName.of;
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const tail = readTail(pdf);
  const ctx = doc.context;
  ctx.largestObjectNumber = Math.max(ctx.largestObjectNumber, tail.size - 1);
  const base = ctx.largestObjectNumber;
  const changed = new Map<PDFRefT, import('pdf-lib').PDFObject>();

  const streamRefs = (list: Uint8Array[]): PDFRefT[] =>
    list.map((bytes) => ctx.register(ctx.stream(bytes, {})));
  const certRefs = streamRefs(evidence.certs);
  const ocspRefs = streamRefs(evidence.ocsps);
  const crlRefs = streamRefs(evidence.crls);

  let dss = doc.catalog.lookupMaybe(n('DSS'), PDFDict);
  const dssRef = doc.catalog.get(n('DSS'));
  const fresh = !dss;
  if (!dss) {
    dss = ctx.obj({});
    doc.catalog.set(n('DSS'), dss);
  }
  const extend = (key: string, refs: PDFRefT[]): void => {
    if (!refs.length) return;
    const existing = dss!.lookupMaybe(n(key), PDFArray) as PDFArrayT | undefined;
    if (existing) {
      for (const r of refs) existing.push(r);
      const ref = dss!.get(n(key));
      if (ref && 'objectNumber' in ref) changed.set(ref as PDFRefT, existing);
    } else dss!.set(n(key), ctx.obj(refs));
  };
  extend('Certs', certRefs);
  extend('OCSPs', ocspRefs);
  extend('CRLs', crlRefs);

  if (evidence.signatureContents) {
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest(
        'SHA-1',
        evidence.signatureContents.slice().buffer as ArrayBuffer,
      ),
    );
    const key = toHex(digest).toUpperCase();
    let vri = dss.lookupMaybe(n('VRI'), PDFDict) as PDFDictT | undefined;
    if (!vri) {
      vri = ctx.obj({});
      dss.set(n('VRI'), vri);
    }
    const entry = ctx.obj({});
    if (certRefs.length) entry.set(n('Cert'), ctx.obj(certRefs));
    if (ocspRefs.length) entry.set(n('OCSP'), ctx.obj(ocspRefs));
    if (crlRefs.length) entry.set(n('CRL'), ctx.obj(crlRefs));
    vri.set(n(key), entry);
    const vriRef = dss.get(n('VRI'));
    if (vriRef && 'objectNumber' in vriRef) changed.set(vriRef as PDFRefT, vri);
  }

  if (dssRef && 'objectNumber' in dssRef) changed.set(dssRef as PDFRefT, dss);
  else if (!fresh) changed.set(ctx.trailerInfo.Root as PDFRefT, doc.catalog);
  changed.set(ctx.trailerInfo.Root as PDFRefT, doc.catalog);

  const objects = new Map<PDFRefT, import('pdf-lib').PDFObject | Uint8Array>(changed);
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) if (ref.objectNumber > base) objects.set(ref, obj);
  return appendUpdate(pdf, tail, doc, objects).bytes;
}
