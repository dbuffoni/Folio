// PDFium copies widget annotations when importing pages but neither copies their parent field
// dictionaries nor registers them in the destination AcroForm, so imported forms would silently stop
// being forms after saving. Pages that carry form fields are therefore imported with pdf-lib, and
// /AcroForm /Fields is rebuilt from the widgets actually present (SPEC §8.7: pdf-lib is the structural
// helper where PDFium lacks API; the hand-over happens on saved bytes, never two writers at once).
import type { PDFDict as PDFDictT, PDFRef as PDFRefT } from 'pdf-lib';

export interface RepairResult {
  bytes: Uint8Array;
  /** Fields renamed because another field already used the name: old → new fully qualified name. */
  renamed: Array<{ from: string; to: string; page: number }>;
}

/** Copies `pages` of `src` into `dest` before index `at`, keeping form fields working. */
export async function importWithForms(dest: Uint8Array, src: Uint8Array, pages: number[], at: number): Promise<RepairResult> {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.load(dest, { updateMetadata: false });
  const from = await PDFDocument.load(src, { updateMetadata: false });
  const copied = await pdf.copyPages(from, pages);
  copied.forEach((page, k) => pdf.insertPage(at + k, page));
  return repair(pdf);
}

export async function repairAcroForm(input: Uint8Array): Promise<RepairResult> {
  const { PDFDocument } = await import('pdf-lib');
  return repair(await PDFDocument.load(input, { updateMetadata: false }));
}

async function repair(pdf: import('pdf-lib').PDFDocument): Promise<RepairResult> {
  const { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFString } = await import('pdf-lib');
  const ctx = pdf.context;
  const N = (s: string) => PDFName.of(s);
  const textOf = (d: PDFDictT, key: string): string => {
    const v = d.lookup(N(key));
    return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
  };

  // Root field of every widget, in page order.
  const roots: Array<{ ref: PDFRefT; dict: PDFDictT; page: number }> = [];
  const seen = new Set<string>();
  pdf.getPages().forEach((page, pageIndex) => {
    const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
    if (!annots) return;
    for (let k = 0; k < annots.size(); k++) {
      const ref = annots.get(k);
      const dict = annots.lookupMaybe(k, PDFDict);
      if (!(ref instanceof PDFRef) || !dict || dict.lookup(N('Subtype')) !== N('Widget')) continue;
      let topRef: PDFRefT = ref;
      let top: PDFDictT = dict;
      for (let guard = 0; guard < 32; guard++) {
        const parentRef = top.get(N('Parent'));
        const parent = top.lookupMaybe(N('Parent'), PDFDict);
        if (!(parentRef instanceof PDFRef) || !parent) break;
        topRef = parentRef;
        top = parent;
      }
      if (seen.has(topRef.toString())) continue;
      seen.add(topRef.toString());
      roots.push({ ref: topRef, dict: top, page: pageIndex });
    }
  });

  // Field trees may still point at widgets of pages that were not copied: keep only what is on a page.
  const onPage = new Set<string>();
  for (const page of pdf.getPages()) {
    const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
    for (let k = 0; annots && k < annots.size(); k++) {
      const ref = annots.get(k);
      if (ref instanceof PDFRef) onPage.add(ref.toString());
    }
  }
  const prune = (dict: PDFDictT, depth: number): boolean => {
    const kids = dict.lookupMaybe(N('Kids'), PDFArray);
    if (!kids || depth > 32) return true;
    const keep: PDFRefT[] = [];
    for (let k = 0; k < kids.size(); k++) {
      const ref = kids.get(k);
      const kid = kids.lookupMaybe(k, PDFDict);
      if (!(ref instanceof PDFRef) || !kid) continue;
      const isWidget = kid.lookup(N('Subtype')) === N('Widget');
      if (isWidget && !kid.has(N('Kids')) ? onPage.has(ref.toString()) : prune(kid, depth + 1)) keep.push(ref);
    }
    dict.set(N('Kids'), ctx.obj(keep));
    return keep.length > 0;
  };
  for (const root of roots) prune(root.dict, 0);

  const renamed: RepairResult['renamed'] = [];
  const used = new Set<string>();
  for (const root of roots) {
    const name = textOf(root.dict, 'T');
    if (!name) continue;
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = `${name}_${n}`;
    used.add(unique);
    if (unique !== name) {
      root.dict.set(N('T'), PDFHexString.fromText(unique));
      renamed.push({ from: name, to: unique, page: root.page });
    }
  }

  const existing = pdf.catalog.lookupMaybe(N('AcroForm'), PDFDict);
  if (roots.length === 0) {
    if (existing) existing.set(N('Fields'), ctx.obj([]));
  } else {
    const acro = existing ?? (ctx.obj({}) as PDFDictT);
    acro.set(N('Fields'), ctx.obj(roots.map((r) => r.ref)));
    if (!acro.has(N('DA'))) acro.set(N('DA'), PDFString.of('/Helv 0 Tf 0 g'));
    const dr = acro.lookupMaybe(N('DR'), PDFDict) ?? (ctx.obj({}) as PDFDictT);
    const fonts = dr.lookupMaybe(N('Font'), PDFDict) ?? (ctx.obj({}) as PDFDictT);
    const std: Record<string, string> = { Helv: 'Helvetica', HeBo: 'Helvetica-Bold', TiRo: 'Times-Roman', Cour: 'Courier', ZaDb: 'ZapfDingbats' };
    for (const [alias, base] of Object.entries(std)) {
      if (!fonts.has(N(alias))) {
        const font: Record<string, string> = { Type: 'Font', Subtype: 'Type1', BaseFont: base };
        if (alias !== 'ZaDb') font.Encoding = 'WinAnsiEncoding';
        fonts.set(N(alias), ctx.register(ctx.obj(font)));
      }
    }
    dr.set(N('Font'), fonts);
    acro.set(N('DR'), dr);
    acro.delete(N('NeedAppearances'));
    if (!existing) pdf.catalog.set(N('AcroForm'), ctx.register(acro));
  }
  const bytes = await pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { bytes, renamed };
}
