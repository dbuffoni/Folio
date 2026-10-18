// Hidden-data inspection and removal (FR-SEC-12). PDFium has no API for XMP streams, thumbnails or
// action dictionaries, so this runs pdf-lib over the saved bytes (SPEC §8.7: pdf-lib is the structural
// helper where PDFium lacks API, and the hand-over happens on saved bytes, never two writers at once).
// After unlinking, every object no longer reachable from the catalog is dropped and the file is written
// from scratch, so earlier revisions of an incrementally saved file cannot survive.
import type { HiddenDataOptions } from '@folio/ports';
import type { PDFContext, PDFDict, PDFObject, PDFRef } from 'pdf-lib';

type Lib = typeof import('pdf-lib');

export interface HiddenCounts {
  info: boolean;
  xmp: boolean;
  thumbnails: number;
  scripts: number;
  annotationAuthors: number;
  attachments: number;
}

const ALL: HiddenDataOptions = { info: true, xmp: true, thumbnails: true, scripts: true, annotationAuthors: true, attachments: true };

export async function scanHiddenData(bytes: Uint8Array): Promise<Omit<HiddenCounts, 'info' | 'attachments'>> {
  const lib = await import('pdf-lib');
  const pdf = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const found = walk(lib, pdf.context, ALL, false);
  return { xmp: found.xmp, thumbnails: found.thumbnails, scripts: found.scripts, annotationAuthors: found.annotationAuthors };
}

export async function scrubHiddenData(bytes: Uint8Array, opts: HiddenDataOptions): Promise<{ bytes: Uint8Array; removed: HiddenCounts }> {
  const lib = await import('pdf-lib');
  const pdf = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const removed = walk(lib, pdf.context, opts, true);
  dropUnreachable(lib, pdf.context);
  return { bytes: await pdf.save({ useObjectStreams: false }), removed };
}

function walk(lib: Lib, ctx: PDFContext, opts: HiddenDataOptions, mutate: boolean): HiddenCounts {
  const { PDFDict, PDFName, PDFStream } = lib;
  const N = (s: string) => PDFName.of(s);
  const out: HiddenCounts = { info: false, xmp: false, thumbnails: 0, scripts: 0, annotationAuthors: 0, attachments: 0 };
  const name = (d: PDFDict, key: string): string | undefined => {
    const v = d.lookup(N(key));
    return v instanceof PDFName ? v.decodeText() : undefined;
  };
  const isJs = (v: PDFObject | undefined): boolean => v instanceof PDFDict && name(v, 'S') === 'JavaScript';

  const catalog = ctx.lookup(ctx.trailerInfo.Root);
  const catalogDict = catalog instanceof PDFDict ? catalog : undefined;

  if (opts.info && ctx.trailerInfo.Info) {
    out.info = true;
    if (mutate) {
      const ref = ctx.trailerInfo.Info as PDFRef;
      delete ctx.trailerInfo.Info;
      ctx.delete(ref);
    }
  }

  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : undefined;
    if (!d) continue;

    if (opts.xmp && d.has(N('Metadata')) && d.lookup(N('Metadata')) instanceof PDFStream) {
      out.xmp = true;
      if (mutate) d.delete(N('Metadata'));
    }
    if (opts.thumbnails && d.has(N('Thumb'))) {
      out.thumbnails++;
      if (mutate) d.delete(N('Thumb'));
    }
    if (opts.scripts) {
      if (isJs(d.lookup(N('A')))) {
        out.scripts++;
        if (mutate) d.delete(N('A'));
      }
      const aa = d.lookup(N('AA'));
      if (aa instanceof PDFDict) {
        const wholesale = d === catalogDict || name(d, 'Type') === 'Page';
        for (const key of aa.keys()) {
          if (wholesale || isJs(aa.lookup(key))) {
            out.scripts++;
            if (mutate) aa.delete(key);
          }
        }
        if (mutate && aa.keys().length === 0) d.delete(N('AA'));
      }
    }
    if (opts.annotationAuthors && d.has(N('T')) && d.has(N('Subtype')) && d.has(N('Rect')) && name(d, 'Subtype') !== 'Widget') {
      out.annotationAuthors++;
      if (mutate) d.delete(N('T'));
    }
    if (opts.attachments && name(d, 'Subtype') === 'FileAttachment' && d.has(N('Rect'))) {
      out.attachments++;
      if (mutate) detachAnnotation(lib, ctx, obj);
    }
  }

  if (catalogDict) {
    if (opts.scripts) {
      const open = catalogDict.lookup(N('OpenAction'));
      // A plain destination (array) is navigation, not hidden behaviour: only actions go.
      if (open instanceof PDFDict) {
        out.scripts++;
        if (mutate) catalogDict.delete(N('OpenAction'));
      }
      const names = catalogDict.lookup(N('Names'));
      if (names instanceof PDFDict && names.has(N('JavaScript'))) {
        out.scripts += Math.max(1, treeSize(lib, names.lookup(N('JavaScript'))));
        if (mutate) names.delete(N('JavaScript'));
      }
    }
    if (opts.attachments) {
      const names = catalogDict.lookup(N('Names'));
      if (names instanceof PDFDict && names.has(N('EmbeddedFiles'))) {
        out.attachments += treeSize(lib, names.lookup(N('EmbeddedFiles')));
        if (mutate) names.delete(N('EmbeddedFiles'));
      }
      if (mutate && catalogDict.has(N('AF'))) catalogDict.delete(N('AF'));
    }
  }
  return out;
}

/** Number of leaf entries of a name tree. */
function treeSize(lib: Lib, node: PDFObject | undefined, depth = 0): number {
  const { PDFArray, PDFDict, PDFName } = lib;
  if (!(node instanceof PDFDict) || depth > 16) return 0;
  const names = node.lookup(PDFName.of('Names'));
  let n = names instanceof PDFArray ? Math.floor(names.size() / 2) : 0;
  const kids = node.lookup(PDFName.of('Kids'));
  if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) n += treeSize(lib, kids.lookup(i), depth + 1);
  return n;
}

/** Takes a file-attachment annotation out of every page /Annots array that lists it. */
function detachAnnotation(lib: Lib, ctx: PDFContext, annot: PDFObject): void {
  const { PDFArray, PDFDict, PDFName } = lib;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const annots = obj.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) if (annots.lookup(i) === annot) annots.remove(i);
  }
}

/** Drops every indirect object that cannot be reached from the trailer any more. */
function dropUnreachable(lib: Lib, ctx: PDFContext): void {
  const { PDFArray, PDFDict, PDFRef, PDFStream } = lib;
  const seen = new Set<string>();
  const stack: PDFObject[] = ctx.trailerInfo.Root ? [ctx.trailerInfo.Root] : [];
  if (ctx.trailerInfo.Info) stack.push(ctx.trailerInfo.Info);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      const key = o.tag;
      if (seen.has(key)) continue;
      seen.add(key);
      const target = ctx.lookup(o);
      if (target) stack.push(target);
    } else if (o instanceof PDFDict) {
      for (const v of o.values()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i) as PDFObject);
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}
