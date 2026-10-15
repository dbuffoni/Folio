// Lossless size pass (FR-OPT-07): rewrite with object streams and a compressed cross-reference
// stream, and give every uncompressed stream maximum Flate. Works on saved bytes, like formrepair.ts
// (SPEC §8.7: pdf-lib is the structural helper; PDFium never writes the same file at the same time).

import type { PDFDict as PDFDictT, PDFRawStream as PDFRawStreamT } from 'pdf-lib';

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const body = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** Streams shorter than this are not worth a filter entry. */
const MIN_STREAM = 96;

export async function compact(input: Uint8Array): Promise<Uint8Array> {
  const { PDFDocument, PDFName, PDFRawStream, PDFStream, PDFContentStream, PDFArray, PDFDict, PDFRef, decodePDFRawStream } =
    await import('pdf-lib');
  const pdf = await PDFDocument.load(input, { updateMetadata: false });
  // Replaced images stay listed in the page's /XObject resources although no content draws them any
  // more. Entries a page's content never names with `Do` are removed (images only).
  const groups = new Map<string, { xobjects: PDFDictT; used: Set<string>; safe: boolean }>();
  for (const page of pdf.getPages()) {
    const resRef = page.node.get(PDFName.of('Resources'));
    const res = page.node.lookupMaybe(PDFName.of('Resources'), PDFDict);
    const xobjects = res?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!res || !xobjects) continue;
    const key = resRef instanceof PDFRef ? resRef.toString() : `${page.ref.toString()}/res`;
    const group = groups.get(key) ?? { xobjects, used: new Set<string>(), safe: true };
    groups.set(key, group);
    const contents = page.node.lookup(PDFName.of('Contents'));
    const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, k) => contents.lookup(k)) : [contents];
    for (const c of streams) {
      try {
        const bytes = c instanceof PDFRawStream ? decodePDFRawStream(c).decode() : c instanceof PDFContentStream ? c.getContents() : undefined;
        if (!bytes) {
          group.safe = false;
          continue;
        }
        const text = new TextDecoder('latin1').decode(bytes);
        for (const m of text.matchAll(/\/([^\s/<>[\]()]+)\s+Do\b/g)) group.used.add(m[1]!);
      } catch {
        group.safe = false;
      }
    }
  }
  for (const { xobjects, used, safe } of groups.values()) {
    if (!safe) continue;
    const entries = xobjects.entries() as Array<[import('pdf-lib').PDFName, import('pdf-lib').PDFObject]>;
    // A form that has no resources of its own draws with the page's: keep everything then.
    const needsPage = entries.some(([, v]) => {
      const x = pdf.context.lookup(v);
      return x instanceof PDFStream && x.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Form') && !x.dict.has(PDFName.of('Resources'));
    });
    if (needsPage) continue;
    for (const [name, v] of entries) {
      const x = pdf.context.lookup(v);
      const isImage = x instanceof PDFStream && x.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image');
      if (isImage && !used.has(name.decodeText())) xobjects.delete(name);
    }
  }
  // Drop objects nothing points to (replaced images, orphaned page content): PDFium keeps them in its
  // object table and writes them again.
  const reachable = new Set<string>();
  const queue: unknown[] = [pdf.context.trailerInfo.Root, pdf.context.trailerInfo.Info, pdf.context.trailerInfo.Encrypt];
  while (queue.length) {
    const item = queue.pop();
    if (item instanceof PDFRef) {
      if (reachable.has(item.toString())) continue;
      reachable.add(item.toString());
      queue.push(pdf.context.lookup(item));
    } else if (item instanceof PDFStream) {
      queue.push(item.dict);
    } else if (item instanceof PDFDict) {
      for (const [, v] of item.entries()) queue.push(v);
    } else if (item instanceof PDFArray) {
      for (let k = 0; k < item.size(); k++) queue.push(item.get(k));
    }
  }
  for (const [ref] of [...pdf.context.enumerateIndirectObjects()]) if (!reachable.has(ref.toString())) pdf.context.delete(ref);
  const filter = PDFName.of('Filter');
  for (const [ref, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    const existing = obj.dict.lookup(filter);
    if (existing instanceof PDFName || (existing instanceof PDFArray && existing.size() > 0)) continue;
    // XRef and object streams are written by pdf-lib itself.
    const type = obj.dict.lookup(PDFName.of('Type'));
    if (type === PDFName.of('XRef') || type === PDFName.of('ObjStm')) continue;
    const bytes = obj instanceof PDFRawStream ? obj.contents : obj instanceof PDFContentStream ? obj.getContents() : undefined;
    if (!bytes || bytes.length < MIN_STREAM) continue;
    const packed = await deflate(bytes);
    if (packed.length >= bytes.length) continue;
    pdf.context.assign(ref, PDFRawStream.of(obj.dict.clone(), packed));
    const dict = (pdf.context.lookup(ref) as PDFRawStreamT).dict;
    dict.set(filter, PDFName.of('FlateDecode'));
    dict.delete(PDFName.of('DecodeParms'));
  }
  return pdf.save({ useObjectStreams: true, updateFieldAppearances: false });
}
