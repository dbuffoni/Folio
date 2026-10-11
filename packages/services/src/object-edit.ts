import { InvalidArgumentError, center, containsPoint, containsRect, invert, multiply, rectToRect, rotation, type Command } from '@folio/core';
import type { Color, ImageCodec, ImageSpec, Matrix, ObjId, PageIndex, PageObject, PdfDocument, Point, RasterImage, Rect } from '@folio/ports';
import { checkpointCommand, inverseCommand, label } from './commands.ts';

/** Median colour of the pixels along the border of a region: the page "paper" colour around content. */
export function sampleBackground(img: RasterImage, region: { x: number; y: number; width: number; height: number }): Color {
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(img.width - 1, Math.ceil(region.x + region.width));
  const y1 = Math.min(img.height - 1, Math.ceil(region.y + region.height));
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  const take = (x: number, y: number): void => {
    const o = (y * img.width + x) * 4;
    r.push(img.data[o]!);
    g.push(img.data[o + 1]!);
    b.push(img.data[o + 2]!);
  };
  for (let x = x0; x <= x1; x++) {
    take(x, y0);
    take(x, y1);
  }
  for (let y = y0; y <= y1; y++) {
    take(x0, y);
    take(x1, y);
  }
  const median = (v: number[]): number => v.sort((a, c) => a - c)[v.length >> 1] ?? 255;
  return { r: median(r), g: median(g), b: median(b) };
}

/** Image objects and whiteout (FR-EDT-05, FR-EDT-07). */
export class ObjectEditService {
  constructor(private readonly images: ImageCodec) {}

  async imagesOn(doc: PdfDocument, page: PageIndex): Promise<PageObject[]> {
    return (await doc.listObjects(page)).filter((o) => o.type === 'image');
  }
  /** Topmost image under a point. */
  imageAt(objects: PageObject[], p: Point): PageObject | undefined {
    return [...objects].reverse().find((o) => o.type === 'image' && containsPoint(o.bounds, p));
  }

  /** Decodes a picked/pasted/dropped file into what the engine embeds (JPEG data is kept as is). */
  async prepare(bytes: Uint8Array): Promise<{ image: ImageSpec['image']; width: number; height: number }> {
    let d;
    try {
      d = await this.images.decode(bytes);
    } catch (e) {
      throw new InvalidArgumentError('That file is not a supported image', { reason: 'badImage', detail: String(e) });
    }
    return { image: d.format === 'jpeg' ? { jpeg: bytes, width: d.width, height: d.height } : { width: d.width, height: d.height, data: d.data }, width: d.width, height: d.height };
  }

  /** Insert a new image as page content. */
  insert(page: PageIndex, spec: ImageSpec): Command<ObjId> {
    let created: ObjId | undefined;
    return inverseCommand(
      label('cmd.insertImage'),
      'content',
      async ({ doc }) => (created = await doc.addImage(page, spec)),
      async ({ doc }) => {
        if (created) await doc.removeObject(page, created);
      },
      { kind: 'pages', pages: [page] },
    );
  }

  /** Applies a matrix to an object; consecutive transforms of the same object coalesce (drags). */
  transform(page: PageIndex, id: ObjId, m: Matrix, labelKey = 'cmd.moveImage'): Command<void> {
    const make = (matrix: Matrix): Command<void> & { transform: { page: PageIndex; id: ObjId; matrix: Matrix } } =>
      Object.assign(
        inverseCommand(
          label(labelKey),
          'content',
          ({ doc }) => doc.transformObject(page, id, matrix),
          ({ doc }) => doc.transformObject(page, id, invert(matrix)),
          { kind: 'pages', pages: [page] },
          (later) => {
            const t = (later as { transform?: { page: PageIndex; id: ObjId; matrix: Matrix } }).transform;
            return t && t.page === page && t.id === id ? make(multiply(matrix, t.matrix)) : null;
          },
        ),
        { transform: { page, id, matrix } },
      );
    return make(m);
  }
  move(page: PageIndex, obj: PageObject, dx: number, dy: number): Command<void> {
    return this.transform(page, obj.id, [1, 0, 0, 1, dx, dy]);
  }
  /** Resize to a new bounding box (pass an aspect-locked rect to keep proportions). */
  resize(page: PageIndex, obj: PageObject, to: Rect): Command<void> {
    if (!(to.width > 1 && to.height > 1)) throw new InvalidArgumentError('Too small');
    return this.transform(page, obj.id, rectToRect(obj.bounds, to), 'cmd.resizeImage');
  }
  /** Rotate around the centre of the object's bounds, degrees counter-clockwise. */
  rotate(page: PageIndex, obj: PageObject, degrees: number): Command<void> {
    return this.transform(page, obj.id, rotation(degrees, center(obj.bounds)), 'cmd.rotateImage');
  }

  delete(page: PageIndex, id: ObjId): Command<void> {
    return checkpointCommand(label('cmd.deleteImage'), 'content', ({ doc }) => doc.removeObject(page, id), { kind: 'pages', pages: [page] });
  }
  /** Swap the picture, keeping position and size. */
  replace(page: PageIndex, id: ObjId, image: ImageSpec['image']): Command<void> {
    return checkpointCommand(label('cmd.replaceImage'), 'content', ({ doc }) => doc.replaceImage(page, id, image), { kind: 'pages', pages: [page] });
  }
  /** Extract-to-file: the embedded picture at its native resolution, as PNG. */
  async extract(doc: PdfDocument, page: PageIndex, id: ObjId): Promise<Uint8Array> {
    return this.images.encode(await doc.getImage(page, id), 'png');
  }

  /** Page colour around an area, for the whiteout eyedropper default. `scale` is pixels per point of `render`. */
  async backgroundAt(doc: PdfDocument, page: PageIndex, area: Rect): Promise<Color> {
    const info = await doc.getPageInfo(page);
    if (info.rotation !== 0) return { r: 255, g: 255, b: 255 };
    const pad = 3;
    const rect = { x: Math.max(0, Math.floor(area.x - pad)), y: Math.max(0, Math.floor(info.size.height - area.y - area.height - pad)), width: Math.ceil(area.width + 2 * pad), height: Math.ceil(area.height + 2 * pad) };
    const img = await doc.render(page, { scale: 1, rect, annotations: false, forms: false });
    return sampleBackground(img, { x: 0, y: 0, width: img.width, height: img.height });
  }

  /**
   * Whiteout / cover (FR-EDT-05): a filled rectangle over content. This only hides: it is not a
   * secure redaction. With `removeUnder`, objects fully inside the rectangle are truly removed first.
   */
  whiteout(page: PageIndex, rect: Rect, color: Color, opts: { removeUnder?: boolean; objects?: PageObject[] } = {}): Command<{ removed: number }> {
    if (!(rect.width > 0.5 && rect.height > 0.5)) throw new InvalidArgumentError('Draw a rectangle first');
    const under = opts.removeUnder ? (opts.objects ?? []).filter((o) => containsRect(rect, o.bounds, 0.5)) : [];
    if (under.length === 0) {
      let created: ObjId | undefined;
      return inverseCommand(
        label('cmd.whiteout'),
        'content',
        async ({ doc }) => {
          created = await doc.addRect(page, { rect, fill: color });
          return { removed: 0 };
        },
        async ({ doc }) => {
          if (created) await doc.removeObject(page, created);
        },
        { kind: 'pages', pages: [page] },
      );
    }
    return checkpointCommand(
      label('cmd.whiteout'),
      'content',
      async ({ doc }) => {
        for (const o of [...under].sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)))) await doc.removeObject(page, o.id);
        await doc.addRect(page, { rect, fill: color });
        return { removed: under.length };
      },
      { kind: 'pages', pages: [page] },
    );
  }
}
