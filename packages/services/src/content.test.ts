import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { FolioError, History } from '@folio/core';
import type { Annotation, FreeTextAnnotation, StampAnnotation } from '@folio/ports';
import { FakeClock, NodeImageCodec, decodePng, fixture, flatFormDoc, inkRatio, meanColor, mutoolDraw, pdfcpuFormFields, pdffonts, pdftoppm, pdftotext, qpdfQdf, samplePng, sharedEngine, signaturePng } from '@folio/testkit';
import { AnnotationService, alignRects, constrainBox, constrainLine, distributeRects, moveAnnotation, resizeAnnotation, snapRect } from './annotation.ts';
import { FormService, clampToField, currentValue, detectAreas, formatFieldValue, nextStop, tabOrder } from './form.ts';
import { NavigationService } from './navigation.ts';
import { ObjectEditService, sampleBackground } from './object-edit.ts';
import { RenderService, cappedScale, tilesFor } from './render.ts';
import { SignatureService, contentBounds, placeAt, removeBackground, resizeLocked, simplify, svgToVector, vectorFromStrokes, vectorToSvg, type HandwritingFont } from './signature.ts';
import { BUILTIN_STAMPS, StampService, nudge, stampNaturalSize } from './stamp.ts';
import { TextEditService, fontBadge, joinRuns } from './text-edit.ts';
import { TextService, stepMatch } from './text.ts';
import { openFixture, shape } from './testing.ts';

const codeOf = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    return e instanceof FolioError ? `${e.code}${e.params.reason ? `:${e.params.reason}` : ''}${e.params.feature ? `:${e.params.feature}` : ''}` : String(e);
  }
};
const images = new NodeImageCodec();
let seq = 0;
const clock = new FakeClock();
const annots = (): AnnotationService => new AnnotationService({ author: () => 'Marta', now: () => clock.now(), newId: () => `t-${++seq}` });
const fontFile = (name: HandwritingFont): Promise<Uint8Array> => readFile(new URL(`../../../assets/fonts/handwriting/${name}.ttf`, import.meta.url));

describe('TextService', () => {
  it('selects by drag, word and line, and copies the text @FR-VIEW-03', async () => {
    const { doc } = await openFixture('invoice');
    const svc = new TextService(doc);
    const layer = await svc.layer(0);
    expect(await svc.layer(0)).toBe(layer);
    const run = layer.runs.find((r) => r.text.startsWith('Payment within'))!;
    const at = svc.charAt(layer, { x: run.rect.x + 60, y: run.rect.y + 4 });
    expect(at).toBeGreaterThan(run.charStart);
    const word = svc.wordAt(layer, at);
    expect(svc.text(layer, word)).toBe('within');
    expect(svc.text(layer, svc.lineAt(layer, at))).toBe('Payment within 30 days. Thank you for your business.');
    const total = layer.runs.find((r) => r.text.startsWith('Total due'))!;
    const range = svc.rangeBetween(0, total.charStart + 8, run.charStart);
    expect(svc.text(layer, range)).toMatch(/^Payment|e: 1,620\.00 EUR\nP$/);
    expect(svc.rects(layer, range).length).toBe(2);
    expect(svc.quads(layer, word)[0]!.p1.y).toBeGreaterThan(svc.quads(layer, word)[0]!.p3.y);
    expect(svc.bounds(layer, word).width).toBeGreaterThan(20);
    expect(svc.charAt(layer, { x: 5, y: 5 })).toBe(-1);
    svc.invalidate([0]);
    expect(await svc.layer(0)).not.toBe(layer);
    doc.dispose();
  });
  it('searches the whole document progressively with a limit, and steps through matches @FR-VIEW-04', async () => {
    const { doc } = await openFixture('text-25');
    const svc = new TextService(doc);
    const seen: number[] = [];
    const hits = await svc.search({ text: 'marker' }, { onPage: (p, h) => h.length && seen.push(p) });
    expect(hits.length).toBe(25);
    expect(seen.length).toBe(25);
    expect((await svc.search({ text: 'Page 2' })).map((h) => h.page)).toEqual([1, 19, 20, 21, 22, 23, 24]);
    expect((await svc.search({ text: 'marker' }, { limit: 3 })).length).toBe(3);
    expect(await svc.search({ text: '' })).toEqual([]);
    const ac = new AbortController();
    ac.abort();
    expect(await codeOf(svc.search({ text: 'x' }, { signal: ac.signal }))).toBe('cancelled');
    expect([stepMatch(3, 2, 1), stepMatch(3, 0, -1), stepMatch(0, 0, 1)]).toEqual([0, 2, -1]);
    doc.dispose();
  });
});

describe('RenderService', () => {
  it('caches renders within a memory budget and drops them on invalidation @FR-VIEW-01', async () => {
    const { doc } = await openFixture('text');
    const svc = new RenderService(doc, { cacheBytes: 2 * 153 * 198 * 4 + 159 * 206 * 4 });
    const a = await svc.render({ page: 0, scale: 0.25 });
    expect(await svc.render({ page: 0, scale: 0.25 })).toBe(a);
    expect(svc.peek({ page: 0, scale: 0.25 })).toBe(a);
    await svc.render({ page: 1, scale: 0.25 });
    await svc.render({ page: 2, scale: 0.25 });
    await svc.render({ page: 0, scale: 0.26 });
    expect(svc.cachedCount).toBe(3);
    expect(svc.cacheBytes).toBeLessThanOrEqual(3 * 160 * 206 * 4);
    svc.invalidate([1]);
    expect(svc.peek({ page: 1, scale: 0.25 })).toBeUndefined();
    svc.invalidate();
    expect([svc.cachedCount, svc.cacheBytes]).toEqual([0, 0]);
    doc.dispose();
  });
  it('renders visible pages before nearby pages and thumbnails, and drops cancelled work @FR-VIEW-01 @FR-ORG-01', async () => {
    const { doc } = await openFixture('text-25');
    const svc = new RenderService(doc);
    const order: string[] = [];
    const ac = new AbortController();
    const jobs = [
      svc.render({ page: 5, scale: 0.2, priority: 'thumbnail' }).then(() => order.push('running')),
      svc.render({ page: 6, scale: 0.2, priority: 'thumbnail' }).then(() => order.push('thumb')),
      svc.render({ page: 3, scale: 0.2, priority: 'near' }).then(() => order.push('near')),
      svc.render({ page: 4, scale: 0.2, priority: 'visible', signal: ac.signal }).then(() => order.push('cancelled'), (e: FolioError) => order.push(`x:${e.code}`)),
      svc.render({ page: 2, scale: 0.2, priority: 'visible' }).then(() => order.push('visible')),
    ];
    ac.abort();
    await Promise.all(jobs);
    // The first job was already running when the others were queued; after it, priority decides.
    expect(order).toEqual(['running', 'x:cancelled', 'visible', 'near', 'thumb']);
    const thumb = await svc.thumbnail(0, 120);
    expect(thumb.width).toBe(120);
    expect((await svc.thumbnail(0, 999)).width).toBe(200);
    doc.dispose();
  });
  it('caps bitmap size and computes tiles @FR-VIEW-01', () => {
    expect(cappedScale({ width: 612, height: 792 }, 8)).toBe(8);
    expect(cappedScale({ width: 612, height: 792 }, 20) * 792).toBeCloseTo(8192, 5);
    const tiles = tilesFor({ width: 2500, height: 3000 }, { x: 900, y: 1000, width: 800, height: 600 });
    expect(tiles).toEqual([{ x: 0, y: 0, width: 1024, height: 1024 }, { x: 1024, y: 0, width: 1024, height: 1024 }, { x: 0, y: 1024, width: 1024, height: 1024 }, { x: 1024, y: 1024, width: 1024, height: 1024 }]);
    expect(tilesFor({ width: 1500, height: 500 }, { x: 0, y: 0, width: 1500, height: 500 }).map((t) => t.width)).toEqual([1024, 476]);
  });
});

describe('NavigationService', () => {
  it('flattens the outline with collapse state @FR-VIEW-02', async () => {
    const { doc } = await openFixture('bookmarks');
    const nav = new NavigationService(doc);
    const outline = await nav.outline();
    expect(nav.flatten(outline).map((i) => [i.title, i.depth, i.page, i.hasChildren])).toEqual([['Chapter 1', 0, 0, true], ['Section 1.1', 1, 1, false], ['Chapter 2', 0, 3, false], ['Appendix – Ünïcode', 0, 4, false]]);
    expect(nav.flatten(outline, new Set(['0'])).map((i) => i.title)).toEqual(['Chapter 1', 'Chapter 2', 'Appendix – Ünïcode']);
    doc.dispose();
  });
  it('follows internal links, asks before external ones and blocks active content @FR-VIEW-05 @FR-SEC-05', async () => {
    const { doc } = await openFixture('links');
    const nav = new NavigationService(doc);
    const links = await nav.links(0);
    const at = (y: number) => nav.resolve(nav.linkAt(links, { x: 100, y })?.target);
    expect(at(610)).toMatchObject({ kind: 'goto', page: 2 });
    expect(at(580)).toEqual({ kind: 'confirmExternal', uri: 'https://example.com/docs?a=1', host: 'example.com' });
    expect(at(550).kind).toBe('blocked');
    expect(at(520)).toEqual({ kind: 'blocked', reason: 'launch' });
    expect(at(490)).toEqual({ kind: 'blocked', reason: 'javascript' });
    expect(nav.linkAt(links, { x: 400, y: 400 })).toBeUndefined();
    expect(nav.resolve(undefined)).toEqual({ kind: 'blocked', reason: 'none' });
    expect(nav.resolve({ kind: 'page', page: 99 })).toEqual({ kind: 'blocked', reason: 'missingPage' });
    expect(nav.resolve({ kind: 'uri', uri: 'file:///etc/passwd' })).toEqual({ kind: 'blocked', reason: 'scheme' });
    expect(nav.resolve({ kind: 'uri', uri: 'not a url' })).toEqual({ kind: 'blocked', reason: 'malformed' });
    expect(nav.resolve({ kind: 'uri', uri: 'mailto:a@example.com' })).toMatchObject({ kind: 'confirmExternal', host: 'a@example.com' });
    doc.dispose();
  });
});

describe('AnnotationService', () => {
  it('highlights selected text with author and timestamp; undo and redo keep the id @FR-ANN-01 @FR-ANN-08', async () => {
    const { doc, history } = await openFixture('invoice');
    const text = new TextService(doc);
    const layer = await text.layer(0);
    const run = layer.runs.find((r) => r.text.startsWith('Total due'))!;
    const svc = annots();
    const hl = svc.markup('highlight', text.quads(layer, { page: 0, start: run.charStart, end: run.charStart + run.charCount }));
    expect(hl).toMatchObject({ opacity: 0.5, color: { r: 255, g: 213, b: 74 } });
    const ref = await history.execute(svc.add(0, hl));
    let list = await doc.listAnnotations(0);
    expect(list[0]).toMatchObject({ id: ref.id, type: 'highlight', author: 'Marta', modified: 'D:20261011090000Z', created: 'D:20261011090000Z' });
    await history.undo();
    expect(await doc.listAnnotations(0)).toEqual([]);
    await history.redo();
    list = await doc.listAnnotations(0);
    expect(list[0]!.id).toBe(ref.id);
    for (const type of ['underline', 'strikeout', 'squiggly'] as const) expect(svc.markup(type, hl.quads).opacity).toBe(1);
    expect(await codeOf(() => svc.markup('highlight', []))).toBe('invalidArgument:noSelection');
    const bytes = await doc.save();
    await expect(bytes).toBeValidPdf();
    // Independent renderers show the highlight where the text is.
    const region = { x: run.rect.x, y: 792 - run.rect.y - run.rect.height, width: run.rect.width, height: run.rect.height };
    for (const img of [await pdftoppm(bytes, 1), await mutoolDraw(bytes, 1)]) {
      const c = meanColor(img, region);
      expect(c.b).toBeLessThan(c.r - 20);
    }
    doc.dispose();
  });

  it('adds notes, text boxes and shapes; edits coalesce into one undo step @FR-ANN-02 @FR-ANN-03 @FR-ANN-04 @FR-ANN-06', async () => {
    const { doc, history } = await openFixture('text');
    const svc = annots();
    const note = await history.execute(svc.add(0, svc.noteAt({ x: 300, y: 600 }, 'Check this')));
    const box: FreeTextAnnotation = { type: 'freetext', rect: { x: 72, y: 500, width: 200, height: 40 }, contents: 'Typed', fontFamily: 'serif', fontSize: 14, textColor: { r: 0, g: 0, b: 0 }, align: 'right', backgroundColor: { r: 255, g: 255, b: 220 }, borderColor: { r: 0, g: 0, b: 0 }, borderWidth: 1 };
    await history.execute(svc.addMany([{ page: 0, annotation: box }, { page: 1, annotation: { type: 'circle', rect: { x: 100, y: 100, width: 80, height: 80 }, strokeWidth: 2, strokeStyle: 'solid', color: { r: 0, g: 0, b: 255 } } }]));
    expect((await doc.listAnnotations(0)).map((a) => a.type)).toEqual(['text', 'freetext']);
    expect((await doc.listAnnotations(1)).map((a) => a.type)).toEqual(['circle']);
    const before = (await doc.listAnnotations(0))[0]!;
    expect(before).toMatchObject({ id: note.id, contents: 'Check this' });
    const steps = history.state.done.length;
    let cur = before;
    for (const dx of [5, 10, 15]) {
      const moved = moveAnnotation(before, dx, -dx);
      await history.execute(svc.update(0, cur, moved));
      cur = moved;
    }
    expect(history.state.done.length).toBe(steps + 1);
    expect((await doc.listAnnotations(0))[0]!.rect.x).toBeCloseTo(315, 0);
    await history.undo();
    expect((await doc.listAnnotations(0))[0]!.rect.x).toBeCloseTo(300, 0);
    const ft = (await doc.listAnnotations(0))[1] as FreeTextAnnotation;
    expect(ft).toMatchObject({ fontFamily: 'serif', align: 'right', backgroundColor: { r: 255, g: 255, b: 220 } });
    expect(ft.fontSize).toBeCloseTo(14, 1);
    await history.undo();
    expect([(await doc.listAnnotations(0)).length, (await doc.listAnnotations(1)).length]).toEqual([1, 0]);
    doc.dispose();
  });

  it('moves, resizes and constrains geometry @FR-ANN-04 @FR-ANN-06', () => {
    const line: Annotation = { type: 'line', rect: { x: 10, y: 10, width: 100, height: 50 }, start: { x: 10, y: 10 }, end: { x: 110, y: 60 }, startEnding: 'none', endEnding: 'openArrow', strokeWidth: 1, strokeStyle: 'solid' };
    expect(moveAnnotation(line, 5, 5)).toMatchObject({ rect: { x: 15, y: 15 }, start: { x: 15, y: 15 }, end: { x: 115, y: 65 } });
    expect(resizeAnnotation(line, { x: 0, y: 0, width: 200, height: 100 })).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 200, y: 100 } });
    const poly: Annotation = { type: 'polyline', rect: { x: 0, y: 0, width: 10, height: 10 }, vertices: [{ x: 0, y: 0 }, { x: 10, y: 10 }], strokeWidth: 1, strokeStyle: 'solid' };
    expect((resizeAnnotation(poly, { x: 10, y: 10, width: 20, height: 40 }) as typeof poly).vertices).toEqual([{ x: 10, y: 10 }, { x: 30, y: 50 }]);
    const snapped = constrainLine({ x: 0, y: 0 }, { x: 100, y: 8 });
    expect(snapped.y).toBeCloseTo(0, 6);
    expect(constrainLine({ x: 0, y: 0 }, { x: 50, y: 60 }).x).toBeCloseTo(constrainLine({ x: 0, y: 0 }, { x: 50, y: 60 }).y, 6);
    expect(constrainBox({ x: 10, y: 10 }, { x: 60, y: -20 })).toEqual({ x: 60, y: -40 });
  });

  it('aligns, distributes and snaps with guides @FR-ANN-06', () => {
    const rects = [{ x: 0, y: 0, width: 10, height: 10 }, { x: 30, y: 40, width: 20, height: 10 }, { x: 100, y: 5, width: 10, height: 30 }];
    expect(alignRects(rects, 'left').map((r) => r.x)).toEqual([0, 0, 0]);
    expect(alignRects(rects, 'right').map((r) => r.x)).toEqual([100, 90, 100]);
    expect(alignRects(rects, 'top').map((r) => r.y + r.height)).toEqual([50, 50, 50]);
    expect(alignRects(rects, 'middle').map((r) => r.y + r.height / 2)).toEqual([25, 25, 25]);
    expect(alignRects(rects, 'center').map((r) => r.x + r.width / 2)).toEqual([55, 55, 55]);
    expect(alignRects(rects, 'bottom').map((r) => r.y)).toEqual([0, 0, 0]);
    expect(distributeRects(rects, 'horizontal').map((r) => r.x)).toEqual([0, 45, 100]);
    expect(distributeRects(rects.slice(0, 2), 'vertical')).toEqual(rects.slice(0, 2));
    const page = { x: 0, y: 0, width: 612, height: 792 };
    expect(snapRect({ x: 98, y: 300, width: 50, height: 20 }, [{ x: 100, y: 500, width: 80, height: 20 }], page)).toEqual({ dx: 2, dy: 0, guides: [{ axis: 'x', at: 100 }] });
    expect(snapRect({ x: 280, y: 385, width: 50, height: 20 }, [], page)).toEqual({ dx: 1, dy: 1, guides: [{ axis: 'x', at: 306 }, { axis: 'y', at: 396 }] });
    expect(snapRect({ x: 200, y: 200, width: 50, height: 20 }, [], page).guides).toEqual([]);
  });

  it('respects locks, changes z-order and deletes with undo @FR-ANN-06', async () => {
    const { doc, history } = await openFixture('text');
    const svc = annots();
    const sq = (x: number): Annotation => ({ type: 'square', rect: { x, y: 300, width: 60, height: 60 }, strokeWidth: 2, strokeStyle: 'solid', color: { r: 255, g: 0, b: 0 } });
    const a = await history.execute(svc.add(0, sq(100)));
    const b = await history.execute(svc.add(0, sq(130)));
    const c = await history.execute(svc.add(0, sq(160)));
    const ids = async () => (await doc.listAnnotations(0)).map((x) => x.id);
    expect(svc.hitTest(await doc.listAnnotations(0), { x: 165, y: 330 })!.id).toBe(c.id);
    await history.execute(svc.reorder(0, (await ids()) as string[], a.id, 'front')!);
    expect(await ids()).toEqual([b.id, c.id, a.id]);
    expect(svc.hitTest(await doc.listAnnotations(0), { x: 155, y: 330 })!.id).toBe(a.id);
    await history.execute(svc.reorder(0, (await ids()) as string[], a.id, 'backward')!);
    expect(await ids()).toEqual([b.id, a.id, c.id]);
    expect(svc.reorder(0, [b.id, a.id, c.id], b.id, 'back')).toBeNull();
    await history.undo();
    await history.undo();
    expect(await ids()).toEqual([a.id, b.id, c.id]);
    const first = (await doc.listAnnotations(0))[0]!;
    await history.execute(svc.update(0, first, { ...first, locked: true }));
    const locked = (await doc.listAnnotations(0))[0]!;
    expect(await codeOf(() => svc.update(0, locked, moveAnnotation(locked, 5, 5)))).toBe('invalidArgument:locked');
    expect(await codeOf(() => svc.remove([{ page: 0, annotation: locked }]))).toBe('invalidArgument:locked');
    await history.execute(svc.update(0, locked, { ...locked, locked: false }));
    const all = (await doc.listAnnotations(0)).map((annotation) => ({ page: 0, annotation }));
    await history.execute(svc.remove(all));
    expect(await ids()).toEqual([]);
    await history.undo();
    expect(await ids()).toEqual([a.id, b.id, c.id]);
    expect(await codeOf(() => svc.remove([]))).toBe('invalidArgument');
    doc.dispose();
  });

  it('lists and filters annotations, including ones from other tools, and bulk-deletes them @FR-ANN-07 @FR-ANN-11', async () => {
    const { doc, history } = await openFixture('annotated');
    const svc = annots();
    await history.execute(svc.add(1, svc.noteAt({ x: 100, y: 100 }, 'Mine')));
    const all = await svc.list(doc);
    expect(all.map((i) => [i.page, i.annotation.type])).toEqual([[0, 'highlight'], [0, 'text'], [0, 'square'], [0, 'other'], [1, 'text']]);
    expect(svc.authors(all)).toEqual(['', 'Marta', 'Other Viewer']);
    expect((await svc.list(doc, { types: ['text'] })).length).toBe(2);
    expect((await svc.list(doc, { authors: ['Marta'] })).map((i) => i.page)).toEqual([1]);
    expect((await svc.list(doc, { pages: [0], text: 'sticky' })).map((i) => i.annotation.id)).toEqual(['other-note-1']);
    const before = await shape(doc);
    await history.execute(svc.remove(all));
    expect(await svc.list(doc)).toEqual([]);
    await history.undo();
    expect(await shape(doc)).toBe(before);
    expect((await svc.list(doc)).length).toBe(5);
    doc.dispose();
  });

  it('copies and pastes annotations as text, also into another document @FR-ANN-06', async () => {
    const one = await openFixture('text');
    const two = await openFixture('invoice');
    const svc = annots();
    await one.history.execute(svc.add(0, { type: 'square', rect: { x: 100, y: 300, width: 60, height: 40 }, strokeWidth: 2, strokeStyle: 'dashed', color: { r: 0, g: 128, b: 0 }, contents: 'box' }));
    const clip = svc.serialize(await one.doc.listAnnotations(0));
    expect(clip).not.toContain('"id"');
    const pasted = svc.deserialize(clip);
    expect(pasted[0]).toMatchObject({ type: 'square', rect: { x: 112, y: 288 }, contents: 'box', locked: false });
    await two.history.execute(svc.addMany(pasted.map((annotation) => ({ page: 0, annotation })), 'cmd.paste'));
    expect((await two.doc.listAnnotations(0))[0]).toMatchObject({ type: 'square', strokeStyle: 'dashed', color: { r: 0, g: 128, b: 0 } });
    expect(svc.deserialize('hello')).toEqual([]);
    expect(svc.deserialize('{"kind":"other"}')).toEqual([]);
    expect(svc.deserialize(JSON.stringify({ kind: 'folio/annotations', version: 1, items: [{ nope: 1 }, null] }))).toEqual([]);
    one.doc.dispose();
    two.doc.dispose();
  });
});

describe('SignatureService and StampService', () => {
  const sigs = async (): Promise<SignatureService> => new SignatureService({ engine: await sharedEngine(), images, font: fontFile });
  const stamps = (): StampService => new StampService({ now: () => new Date(2026, 9, 11), locale: () => 'en' });
  const strokes = [Array.from({ length: 40 }, (_, i) => ({ x: 20 + i * 5, y: 60 + Math.sin(i / 4) * 25 + (i % 2) * 0.2 })), [{ x: 60, y: 100 }, { x: 180, y: 96 }]];

  it('turns drawn strokes into smooth vector paths that survive storage as SVG @FR-STM-02', async () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 5, y: 0.1 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 0.5)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    const v = vectorFromStrokes(strokes, { strokeWidth: 2 });
    expect(v.paths.length).toBe(2);
    expect(v.paths[0]!.segments.length).toBeLessThan(40);
    expect(v.paths[0]!.segments.some((s) => s.op === 'C')).toBe(true);
    expect(v.width).toBeCloseTo(199, 0);
    const svg = vectorToSvg(v);
    expect(svg).toMatch(/^<svg xmlns=.*stroke-linecap="round"/);
    const back = svgToVector(svg)!;
    expect(back.paths.length).toBe(2);
    expect(back.width).toBeCloseTo(v.width, 1);
    expect(back.paths[0]!.segments[1]).toMatchObject({ op: 'C' });
    expect(svgToVector('<svg></svg>')).toBeNull();
    expect(await codeOf(() => vectorFromStrokes([[{ x: 1, y: 1 }]]))).toBe('invalidArgument:emptySignature');
    const draft = (await sigs()).fromStrokes(strokes, 'signature', { r: 29, g: 78, b: 216 });
    expect(draft).toMatchObject({ kind: 'signature', source: 'drawn', height: 48 });
    expect(draft.width / draft.height).toBeCloseTo(v.width / v.height, 2);
    expect(contentBounds(draft.raster)).not.toBeNull();
    expect(draft.raster.data[draft.raster.data.findIndex((_, i) => i % 4 === 3 && draft.raster.data[i]! > 200) - 1]).toBe(216);
  });

  it('renders a typed name in the bundled handwriting fonts @FR-STM-02', async () => {
    const svc = await sigs();
    const a = await svc.fromText('Marta Esempio', 'Caveat', 'signature');
    const b = await svc.fromText('Marta Esempio', 'GreatVibes', 'signature');
    expect(a).toMatchObject({ source: 'typed', height: 48 });
    expect(a.svg).toBeUndefined();
    expect(a.raster.width).toBeGreaterThan(a.raster.height * 2);
    expect(a.raster.width).not.toBe(b.raster.width);
    const opaque = a.raster.data.findIndex((v, i) => i % 4 === 3 && v === 255);
    expect([...a.raster.data.subarray(opaque - 3, opaque)]).toEqual([29, 78, 216]);
    expect(a.raster.data[3]).toBe(0);
    expect((await svc.fromText('ME', 'Kalam', 'initials')).height).toBe(32);
    expect(await codeOf(svc.fromText('  ', 'Caveat', 'signature'))).toBe('invalidArgument:emptySignature');
  });

  it('imports an image: removes the paper background by threshold and trims to the ink @FR-STM-02', async () => {
    const svc = await sigs();
    const draft = await svc.fromImage(signaturePng(200, 80, [250, 248, 240, 255]), 'signature', { threshold: 200 });
    expect(draft.source).toBe('image');
    expect(draft.raster.width).toBeLessThan(200);
    expect(draft.raster.height).toBeLessThan(60);
    const alphas = [...draft.raster.data].filter((_, i) => i % 4 === 3);
    expect(alphas.filter((a) => a === 0).length).toBeGreaterThan(alphas.length * 0.5);
    expect(Math.max(...alphas)).toBe(255);
    const grey = removeBackground({ width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 120, 120, 120, 255]) }, 100);
    expect([grey.data[3], grey.data[7]]).toEqual([0, 0]);
    const cropped = await svc.fromImage(signaturePng(), 'signature', { crop: { x: 0, y: 0, width: 100, height: 80 } });
    expect(cropped.raster.width).toBeLessThanOrEqual(100);
    expect(await codeOf(svc.fromImage(new Uint8Array([1, 2, 3]), 'signature'))).toBe('invalidArgument:badImage');
    expect(await codeOf(svc.fromImage(samplePng(20, 20), 'signature', { threshold: 1 }))).toBe('invalidArgument:emptySignature');
  });

  it('places a signature as a Stamp annotation other viewers show; ghost placement stays on the page @FR-STM-03 @FR-STM-08', async () => {
    const { doc, history } = await openFixture('invoice');
    const sig = (await sigs()).fromStrokes(strokes, 'signature');
    const page = { width: 612, height: 792 };
    expect(placeAt({ x: 600, y: 5 }, sig, page)).toMatchObject({ x: 612 - sig.width, y: 0 });
    const stamp = stamps().signatureAnnotation(await sigs(), sig, { x: 400, y: 200 }, page);
    expect(stamp).toMatchObject({ type: 'stamp', name: 'Signature', appearance: { kind: 'vector' } });
    expect(stamp.rect.x + stamp.rect.width / 2).toBeCloseTo(400, 5);
    const svc = annots();
    const ref = await history.execute(svc.add(0, stamp));
    const placed = (await doc.listAnnotations(0))[0] as StampAnnotation;
    expect(placed).toMatchObject({ id: ref.id, type: 'stamp', name: 'Signature', author: 'Marta' });
    // Drag, aspect-locked resize, arrow nudges.
    const bigger = resizeLocked(placed.rect, { x: placed.rect.x, y: placed.rect.y }, { x: placed.rect.x + placed.rect.width * 2, y: placed.rect.y + 10 });
    expect(bigger.width / bigger.height).toBeCloseTo(placed.rect.width / placed.rect.height, 5);
    expect(nudge(placed.rect, 'ArrowLeft', false, page).x).toBeCloseTo(placed.rect.x - 1, 5);
    expect(nudge(placed.rect, 'ArrowUp', true, page).y).toBeCloseTo(placed.rect.y + 10, 5);
    expect(nudge({ x: 0, y: 0, width: 10, height: 10 }, 'ArrowDown', true, page).y).toBe(0);
    await history.execute(svc.update(0, placed, { ...placed, rect: bigger }));
    const bytes = await doc.save();
    await expect(bytes).toBeValidPdf();
    await expect(bytes).toHaveAnnotation('stamp');
    const region = { x: bigger.x, y: 792 - bigger.y - bigger.height, width: bigger.width, height: bigger.height };
    for (const img of [await pdftoppm(bytes, 1), await mutoolDraw(bytes, 1)]) expect(inkRatio(img, region)).toBeGreaterThan(0.01);
    await history.undo();
    await history.undo();
    expect(await doc.listAnnotations(0)).toEqual([]);
    // Typed signatures are placed as images.
    const typed = await (await sigs()).fromText('Marta', 'Sacramento', 'initials');
    const st2 = stamps().signatureAnnotation(await sigs(), typed, { x: 100, y: 100 }, page);
    expect(st2).toMatchObject({ name: 'Initials', appearance: { kind: 'image' } });
    await history.execute(svc.add(0, st2));
    expect(inkRatio(await doc.render(0, { scale: 1 }), { x: st2.rect.x, y: 792 - st2.rect.y - st2.rect.height, width: st2.rect.width, height: st2.rect.height })).toBeGreaterThan(0.02);
    doc.dispose();
  });

  it('inserts today\'s date in the chosen format @FR-STM-05', async () => {
    const { doc, history } = await openFixture('text');
    const svc = stamps();
    expect([svc.dateText('iso'), svc.dateText('dmy'), svc.dateText('mdy'), svc.dateText('long')]).toEqual(['2026-10-11', '11/10/2026', '10/11/2026', 'October 11, 2026']);
    const short = svc.annotation(svc.dateStamp('iso'), { x: 300, y: 300 }, { width: 612, height: 792 });
    const long = svc.annotation(svc.dateStamp('long'), { x: 300, y: 300 }, { width: 612, height: 792 });
    expect(short).toMatchObject({ name: 'Date', contents: '2026-10-11', appearance: { kind: 'text', text: '2026-10-11', border: false } });
    expect(long.rect.width).toBeGreaterThan(short.rect.width);
    expect(short.rect.height).toBe(16);
    await history.execute(annots().add(0, short));
    expect(inkRatio(await doc.render(0, { scale: 2 }), { x: short.rect.x * 2, y: (792 - short.rect.y - short.rect.height) * 2, width: short.rect.width * 2, height: short.rect.height * 2 })).toBeGreaterThan(0.05);
    doc.dispose();
  });

  it('offers the built-in stamps and marks, and custom text, image and selection stamps @FR-STM-06 @FR-STM-07', async () => {
    const { doc, history } = await openFixture('text');
    const svc = stamps();
    expect(BUILTIN_STAMPS.map((s) => s.style?.text ?? s.mark)).toEqual(['APPROVED', 'REJECTED', 'DRAFT', 'CONFIDENTIAL', 'PAID', 'COPY', 'FINAL', 'NOT APPROVED', 'check', 'cross', 'dot']);
    expect(BUILTIN_STAMPS.every((s) => s.name.startsWith('stamp.'))).toBe(true);
    const page = { width: 612, height: 792 };
    const a = annots();
    let y = 740;
    const placed: StampAnnotation[] = [];
    for (const def of BUILTIN_STAMPS) {
      const st = svc.annotation(def, { x: 150, y }, page);
      placed.push(st);
      await history.execute(a.add(0, st));
      y -= 40;
    }
    expect(placed[0]).toMatchObject({ name: 'APPROVED', appearance: { kind: 'text', border: true, color: { g: 128 } } });
    expect(placed[8]).toMatchObject({ name: 'Check', rect: { width: 14, height: 14 } });
    expect(stampNaturalSize(BUILTIN_STAMPS[3]!).width).toBeGreaterThan(stampNaturalSize(BUILTIN_STAMPS[4]!).width);
    const custom = svc.customText('c1', 'Received', { text: ' RECEIVED ', color: { r: 29, g: 78, b: 216 }, fontFamily: 'serif', bold: true, border: true, rotation: 12 });
    expect(custom.style!.text).toBe('RECEIVED');
    const cst = svc.annotation(custom, { x: 420, y: 600 }, page);
    expect(cst).toMatchObject({ name: 'Received', rotation: 12 });
    expect(cst.rect.height).toBeGreaterThan(30);
    await history.execute(a.add(0, cst));
    const img = svc.annotation(svc.customImage('c2', 'Logo', decodePng(samplePng(90, 60))), { x: 420, y: 400 }, page);
    expect(img.rect.width / img.rect.height).toBeCloseTo(1.5, 2);
    await history.execute(a.add(0, img));
    const selection = svc.customImage('c3', 'From page', await doc.render(0, { scale: 2, rect: { x: 140, y: 130, width: 300, height: 80 } }), 'selection');
    expect(selection.kind).toBe('selection');
    await history.execute(a.add(1, svc.annotation(selection, { x: 300, y: 300 }, page)));
    const bytes = await doc.save();
    await expect(bytes).toBeValidPdf();
    const pop = await pdftoppm(bytes, 1);
    for (const st of [...placed, cst, img]) expect(inkRatio(pop, { x: st.rect.x, y: 792 - st.rect.y - st.rect.height, width: st.rect.width, height: st.rect.height })).toBeGreaterThan(0.03);
    const approved = meanColor(pop, { x: placed[0]!.rect.x, y: 792 - placed[0]!.rect.y - placed[0]!.rect.height, width: placed[0]!.rect.width, height: placed[0]!.rect.height });
    expect(approved.g).toBeGreaterThan(approved.r);
    expect((await doc.listAnnotations(0)).every((x) => x.type === 'stamp')).toBe(true);
    // Flatten-on-save option: only stamps are burned in.
    await history.execute(a.add(1, a.noteAt({ x: 50, y: 50 }, 'stay')));
    await doc.flattenAnnotations(undefined, ['stamp']);
    expect([(await doc.listAnnotations(0)).length, (await doc.listAnnotations(1)).map((x) => x.type)]).toEqual([0, ['text']]);
    doc.dispose();
  });
});

describe('FormService', () => {
  const svc = (): FormService => new FormService({ newId: () => `f-${++seq}` });

  it('walks fields in reading order with Tab and Shift+Tab @FR-FRM-02', async () => {
    const { doc } = await openFixture('acroform');
    const stops = tabOrder(await svc().fields(doc));
    expect(stops.map((s) => `${s.field.name}${s.field.widgets.length > 1 ? `#${s.widget}` : ''}`)).toEqual(['person.name', 'code', 'notes', 'agree', 'color#0', 'color#1', 'country', 'langs']);
    expect([nextStop(8, -1, 1), nextStop(8, 7, 1), nextStop(8, 0, -1), nextStop(8, -1, -1), nextStop(0, 0, 1)]).toEqual([0, 0, 7, 7, -1]);
    doc.dispose();
  });

  it('fills fields with undo; typing coalesces; values reach other tools @FR-FRM-01', async () => {
    const { doc, history } = await openFixture('acroform');
    const s = svc();
    const by = async () => Object.fromEntries((await s.fields(doc)).map((f) => [f.name, f]));
    let f = await by();
    for (const text of ['L', 'Lu', 'Luca']) await history.execute(s.fill(f['person.name']!, text));
    expect(history.state.done.length).toBe(1);
    await history.execute(s.fill(f['agree']!, true));
    await history.execute(s.fill(f['color']!, 'blue'));
    await history.execute(s.fill(f['country']!, 'Spain'));
    await history.execute(s.fill(f['langs']!, ['IT']));
    await history.execute(s.fill(f['code']!, 'ABCDEFGHI'));
    f = await by();
    expect([f['person.name']!.value, currentValue(f['agree']!), f['color']!.value, f['country']!.value, currentValue(f['langs']!), f['code']!.value]).toEqual(['Luca', true, 'blue', 'Spain', ['IT'], 'ABCDEF']);
    const bytes = await doc.save();
    await expect(bytes).toBeValidPdf();
    const rows = Object.fromEntries((await pdfcpuFormFields(bytes)).map((r) => [r.name, r.value]));
    expect(rows).toMatchObject({ 'person.name': 'Luca', agree: 'Yes', color: 'blue', country: 'Spain', langs: 'IT' });
    // Appearance streams: the typed name is visible in a renderer that does not know Folio.
    expect(inkRatio(await pdftoppm(bytes, 1), { x: 74, y: 792 - 700, width: 60, height: 18 })).toBeGreaterThan(0.03);
    while (await history.undo()) {
      /* back to start */
    }
    f = await by();
    expect([f['person.name']!.value, f['agree']!.value, f['country']!.value, f['langs']!.values]).toEqual(['', 'Off', '', []]);
    expect(await codeOf(() => s.fill(f['ref']!, 'x'))).toBe('invalidArgument:readOnly');
    expect(await codeOf(() => s.fill(f['submit']!, 'x'))).toBe('invalidArgument:readOnly');
    doc.dispose();
  });

  it('honours max length and display formats without running scripts @FR-FRM-03', () => {
    const base = { id: 'a', name: 'a', type: 'text' as const, widgets: [], readOnly: false, required: false, multiline: false, password: false, comb: false, multiSelect: false };
    expect(clampToField({ ...base, value: '', maxLength: 4 }, 'ABCDEFG')).toBe('ABCD');
    expect(clampToField({ ...base, value: '' }, 'a\nb')).toBe('a b');
    expect(clampToField({ ...base, value: '', multiline: true }, 'a\nb')).toBe('a\nb');
    expect(formatFieldValue({ ...base, value: '1234.5', format: { kind: 'number', decimals: 2 } })).toBe('1,234.50');
    expect(formatFieldValue({ ...base, value: '0.256', format: { kind: 'percent', decimals: 1 } })).toBe('25.6%');
    expect(formatFieldValue({ ...base, value: '2026-03-09', format: { kind: 'date', pattern: 'dd/mm/yyyy' } })).toBe('09/03/2026');
    expect(formatFieldValue({ ...base, value: 'abc', format: { kind: 'number', decimals: 2 } })).toBe('abc');
    expect(formatFieldValue({ ...base, value: 'x' })).toBe('x');
  });

  it('resets, clears, exports and imports form data as JSON @FR-FRM-05', async () => {
    const { doc, history } = await openFixture('acroform-prefilled');
    const s = svc();
    const fields = await s.fields(doc);
    const data = s.exportData(fields);
    expect(data).toEqual({ version: 1, fields: { 'person.name': 'Marta Esempio', code: '', notes: '', ref: 'R-0042', agree: true, color: 'red', country: 'Italy', langs: [] } });
    await history.execute(s.reset(fields)!);
    const cleared = Object.fromEntries((await s.fields(doc)).map((f) => [f.name, f.value]));
    expect(cleared).toMatchObject({ 'person.name': '', agree: 'Off', country: '', ref: 'R-0042' });
    expect(history.state.done.length).toBe(1);
    const res = s.importData(await s.fields(doc), { version: 1, fields: { ...data.fields, country: 'Atlantis', unknown: 'x', langs: ['EN', 'DE'], color: 'blue' } });
    expect(res.skipped.sort()).toEqual(['country', 'ref', 'unknown']);
    await history.execute(res.command!);
    const now = Object.fromEntries((await s.fields(doc)).map((f) => [f.name, f]));
    expect([now['person.name']!.value, now['agree']!.value, now['color']!.value, now['langs']!.values, now['country']!.value]).toEqual(['Marta Esempio', 'Yes', 'blue', ['EN', 'DE'], '']);
    await history.undo();
    expect((await s.fields(doc)).find((f) => f.name === 'person.name')!.value).toBe('');
    await history.undo();
    expect((await s.fields(doc)).find((f) => f.name === 'person.name')!.value).toBe('Marta Esempio');
    expect(s.reset([])).toBeNull();
    expect(await codeOf(() => s.importData(fields, { version: 2 }))).toBe('invalidArgument:badFormData');
    expect(await codeOf(() => s.importData(fields, 'x'))).toBe('invalidArgument:badFormData');
    await history.execute(s.clear((await s.fields(doc)).find((f) => f.name === 'person.name')!));
    await history.execute(s.flatten());
    expect(await s.fields(doc)).toEqual([]);
    await history.undo();
    expect((await s.fields(doc)).length).toBe(9);
    doc.dispose();
  });

  it('detects fillable areas on a non-fillable form with labels (precision and recall) @FR-FRM-07', async () => {
    const engine = await sharedEngine();
    const { pdf, areas: truth } = await flatFormDoc();
    const doc = await engine.open(pdf);
    const found = await svc().detect(doc, 0);
    expect(found.map((a) => a.id)).toEqual(found.map((_, k) => `p1-a${k + 1}`));
    const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a): number => {
      const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      return w > 0 && h > 0 ? (w * h) / Math.min(a.width * a.height, b.width * b.height) : 0;
    };
    const matched = truth.map((t) => found.find((f) => overlap(f.rect, t.rect) > 0.6));
    const recall = matched.filter(Boolean).length / truth.length;
    const precision = found.filter((f) => truth.some((t) => overlap(f.rect, t.rect) > 0.6)).length / found.length;
    expect(recall).toBe(1);
    expect(precision).toBeGreaterThanOrEqual(0.85);
    expect(matched.map((m) => m!.kind)).toEqual(['text', 'text', 'text', 'text', 'comb', 'checkbox']);
    expect(matched.map((m) => m!.label)).toEqual(['First name', 'Last name', 'Date of birth', 'Email', 'Tax code', 'Send me the newsletter']);
    expect(matched[4]!.cells).toBe(16);
    // A normal text page and a table with rules produce no false "fields".
    const inv = await openFixture('invoice');
    expect(detectAreas(0, await inv.doc.listObjects(0), await inv.doc.getTextLayer(0))).toEqual([]);
    inv.doc.dispose();
    doc.dispose();
  });

  it('Cover & type: click an area or a line to type; ghosts become text boxes @FR-FRM-06 @FR-FRM-07', async () => {
    const engine = await sharedEngine();
    const { pdf, areas: truth } = await flatFormDoc();
    const doc = await engine.open(pdf);
    const history = new History({ doc, engine });
    const s = svc();
    const a = annots();
    const areas = await s.detect(doc, 0);
    const layer = await doc.getTextLayer(0);
    const first = truth[0]!.rect;
    const hit = s.boxAt({ x: first.x + 30, y: first.y + 6 }, areas, layer);
    expect(hit.area!.label).toBe('First name');
    expect(hit.rect).toEqual(hit.area!.rect);
    expect(hit.fontSize).toBeLessThanOrEqual(11);
    const free = s.boxAt({ x: 450, y: 120 }, areas, layer);
    expect(free.area).toBeUndefined();
    expect(free.rect).toMatchObject({ x: 450, width: 180 });
    const onLine = s.boxAt({ x: 300, y: 735 }, areas, layer);
    expect(onLine.fontSize).toBeCloseTo(18, 0);
    await history.execute(a.addMany(areas.filter((x) => x.kind !== 'checkbox').slice(0, 2).map((area, k) => ({ page: 0, annotation: s.fromArea(area, ['Marta', 'Esempio'][k]) }))));
    const box = (await doc.listAnnotations(0))[0] as FreeTextAnnotation;
    expect(box).toMatchObject({ type: 'freetext', contents: 'Marta', borderWidth: 0 });
    expect(Math.abs(box.rect.x - first.x)).toBeLessThan(1.5);
    const bytes = await doc.save();
    await expect(bytes).toBeValidPdf();
    expect(inkRatio(await pdftoppm(bytes, 1), { x: first.x, y: 792 - first.y - first.height, width: 60, height: first.height - 3 })).toBeGreaterThan(0.02);
    await history.undo();
    expect(await doc.listAnnotations(0)).toEqual([]);
    doc.dispose();
  });

  it('reports XFA forms so the UI can explain they cannot be edited @FR-FRM-09', async () => {
    const { doc } = await openFixture('xfa');
    expect((await doc.getMeta()).hasXfa).toBe(true);
    expect((await svc().fields(doc)).length).toBe(9);
    doc.dispose();
  });
});

describe('TextEditService', () => {
  const svc = new TextEditService();

  it('describes editable lines with font and size, and finds the line and caret under the pointer @FR-EDT-01', async () => {
    const { doc } = await openFixture('invoice');
    const layer = await doc.getTextLayer(0);
    const lines = svc.lines(layer);
    const heading = lines.find((l) => l.text === 'Invoce')!;
    expect(heading).toMatchObject({ fontName: 'Helvetica-Bold', blocked: undefined });
    expect(heading.fontSize).toBeCloseTo(28, 1);
    expect(svc.lineAt(lines, { x: 100, y: 715 })).toBe(heading);
    expect(svc.lineAt(lines, { x: 300, y: 300 })).toBeUndefined();
    expect(svc.caretAt(layer, heading, { x: heading.line.rect.x + 1, y: 715 })).toBe(0);
    expect(svc.caretAt(layer, heading, { x: heading.line.rect.x + heading.line.rect.width + 5, y: 715 })).toBe(6);
    const mid = svc.caretAt(layer, heading, { x: heading.line.rect.x + heading.line.rect.width / 2, y: 715 });
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(5);
    expect(fontBadge({ kind: 'reused', fontName: 'Arial' }, 11)).toEqual({ text: 'Arial 11pt', substituted: false });
    expect(fontBadge({ kind: 'substituted', from: 'Arial', to: 'Liberation Sans' }, 11)).toEqual({ text: 'Arial → Liberation Sans', substituted: true });
    doc.dispose();
    const rot = await openFixture('rotated-text');
    const rl = svc.lines(await rot.doc.getTextLayer(0));
    expect(rl.find((l) => l.text === 'Tilted text')!.blocked).toEqual({ key: 'edit.blocked.rotated' });
    expect(await codeOf(() => svc.editLine(0, { page: 0, text: '', chars: [], runs: [], lines: [], isScanned: false }, rl.find((l) => l.text === 'Tilted text')!, 'x', { size: { width: 1, height: 1 }, rotation: 0, mediaBox: { x: 0, y: 0, width: 1, height: 1 }, cropBox: { x: 0, y: 0, width: 1, height: 1 } }))).toBe('unsupportedFeature:edit.blocked.rotated');
    rot.doc.dispose();
  });

  it('fixes a typo reusing the original font; other viewers see the new text and no old glyphs; undo restores the page bytes @FR-EDT-02', async () => {
    const { doc, history } = await openFixture('subset-font');
    const info = await doc.getPageInfo(0);
    const content = async (): Promise<string> => /stream\n([\s\S]*?)endstream/.exec((await qpdfQdf(await doc.save())).split('%% Contents for page 1')[1]!)![1]!;
    const before = await content();
    const beforeRender = await doc.render(0, { scale: 1 });
    const layer = await doc.getTextLayer(0);
    const line = svc.lines(layer).find((l) => l.text === 'Invoce')!;
    const res = await history.execute(svc.editLine(0, layer, line, 'Invoice', info));
    expect(res).toMatchObject({ font: { kind: 'reused' }, overflow: false, missingGlyphs: false, text: 'Invoice' });
    let bytes = await doc.save();
    await expect(bytes).toBeValidPdf();
    const text = await pdftotext(bytes);
    expect(text).toContain('Invoice');
    expect(text).not.toMatch(/Invoce\b/);
    expect((await pdffonts(bytes)).length).toBe(1);
    // Rest of the page is unchanged.
    const after = await doc.render(0, { scale: 1 });
    const below = { x: 0, y: 110, width: 612, height: 682 };
    expect(JSON.stringify(meanColor(after, below))).toBe(JSON.stringify(meanColor(beforeRender, below)));
    await history.undo();
    expect(await content()).toBe(before);
    // A character missing from the subset: the whole line is re-created in the nearest bundled font, and says so.
    const l2 = await doc.getTextLayer(0);
    const sub = await history.execute(svc.editLine(0, l2, svc.lines(l2).find((l) => l.text === 'Invoce')!, 'Invoice №7', info));
    expect(sub.font).toEqual({ kind: 'substituted', from: 'LiberationSerif', to: 'Liberation Serif' });
    bytes = await doc.save();
    expect(await pdftotext(bytes)).toContain('Invoice №7');
    expect((await pdffonts(bytes)).map((f) => f.subset).sort()).toEqual([false, true]);
    await history.undo();
    expect(await content()).toBe(before);
    doc.dispose();
  });

  it('applies a style to the edited line only @FR-EDT-03', async () => {
    const { doc, history } = await openFixture('invoice');
    const layer = await doc.getTextLayer(0);
    const line = svc.lines(layer).find((l) => l.text === 'No. 2026-014')!;
    await history.execute(svc.editLine(0, layer, line, 'No. 2026-014', await doc.getPageInfo(0), { fontFamily: 'serif', italic: true, fontSize: 14, color: { r: 0, g: 90, b: 160 } }));
    const runs = (await doc.getTextLayer(0)).runs;
    const edited = runs.find((r) => r.text === 'No. 2026-014')!;
    expect(edited.font.name).toMatch(/Serif.*Italic/);
    expect(edited.color).toMatchObject({ r: 0, g: 90, b: 160 });
    expect(runs.find((r) => r.text === 'Invoce')!.font.name).toBe('Helvetica-Bold');
    doc.dispose();
  });

  it('warns when the edited line overflows and can shrink it by at most 15 % @FR-EDT-04', async () => {
    const { doc, history } = await openFixture('invoice');
    const info = await doc.getPageInfo(0);
    let layer = await doc.getTextLayer(0);
    const desc = svc.lines(layer).find((l) => l.text === 'Design services')!;
    // The next column ("12") starts at x=380: that is the limit, not the page margin.
    expect(svc.availableWidth(layer, desc.line, info)).toBeCloseTo(380 - 2 - 72, 0);
    const res = await history.execute(svc.editLine(0, layer, desc, 'Design services and a very long description that keeps going on', info));
    expect(res.overflow).toBe(true);
    expect(res.shrinkFactor).toBeGreaterThanOrEqual(0.85);
    await history.execute(svc.shrinkToFit(res, desc.fontSize));
    layer = await doc.getTextLayer(0);
    const shrunk = layer.runs.find((r) => r.text.startsWith('Design services and'))!;
    expect(shrunk.fontSize).toBeLessThan(11);
    expect(shrunk.fontSize).toBeGreaterThanOrEqual(11 * 0.85 - 0.01);
    expect(shrunk.rect.x + shrunk.rect.width).toBeLessThanOrEqual(380);
    const tooLong = await history.execute(svc.editLine(0, layer, svc.lines(layer).find((l) => l.text === 'Hosting (annual)')!, 'x'.repeat(120), info));
    expect(tooLong).toMatchObject({ overflow: true, shrinkFactor: undefined });
    expect(await codeOf(() => svc.shrinkToFit(tooLong, 11))).toBe('invalidArgument:cannotShrink');
    const total = svc.lines(layer).find((l) => l.text.startsWith('Total due'))!;
    expect(svc.availableWidth(layer, total.line, info)).toBeCloseTo(612 - 36 - 380, 0);
    expect(await codeOf(() => svc.editLine(0, layer, total, '  ', info))).toBe('invalidArgument:emptyText');
    doc.dispose();
  });

  it('joins a line made of several text objects into one, and deletes lines @FR-EDT-02', async () => {
    const { doc, history, engine } = await openFixture('text');
    await doc.addText(0, { text: 'Hello', origin: { x: 72, y: 300 }, fontSize: 12 });
    await doc.addText(0, { text: 'world', origin: { x: 106, y: 300 }, fontSize: 12 });
    let layer = await doc.getTextLayer(0);
    const line = svc.lines(layer).find((l) => l.text.startsWith('Hello'))!;
    expect(line.line.runs.length).toBe(2);
    expect(line.text).toBe('Hello world');
    expect(joinRuns(line.line.runs.map((i) => layer.runs[i]!))).toBe('Hello world');
    const count = (await doc.listObjects(0)).length;
    await history.execute(svc.editLine(0, layer, line, 'Hello brave world', await doc.getPageInfo(0)));
    expect((await doc.listObjects(0)).length).toBe(count - 1);
    layer = await doc.getTextLayer(0);
    expect(layer.text).toContain('Hello brave world');
    expect(layer.text).not.toMatch(/\bworld\b.*\bworld\b/s);
    await history.execute(svc.deleteLine(0, layer, svc.lines(layer).find((l) => l.text === 'Hello brave world')!));
    expect((await doc.getTextLayer(0)).text).not.toContain('Hello');
    await history.undo();
    await history.undo();
    expect((await doc.listObjects(0)).length).toBe(count);
    void engine;
    doc.dispose();
  });

  it('adds text as page content with undo @FR-EDT-06', async () => {
    const { doc, history } = await openFixture('text');
    const id = await history.execute(svc.addText(0, { text: 'Added note', origin: { x: 72, y: 200 }, fontSize: 12, fontFamily: 'mono' }));
    expect((await doc.getTextLayer(0)).runs.find((r) => r.objId === id)!.text).toBe('Added note');
    await expect(await doc.save()).toContainText('Added note');
    await history.undo();
    expect((await doc.getTextLayer(0)).text).not.toContain('Added note');
    await history.redo();
    expect((await doc.getTextLayer(0)).text).toContain('Added note');
    expect(await codeOf(() => svc.addText(0, { text: ' ', origin: { x: 0, y: 0 } }))).toBe('invalidArgument:emptyText');
    doc.dispose();
  });

  it('explains that scanned pages have no editable text @FR-EDT-08', async () => {
    const { doc } = await openFixture('scan');
    expect(await codeOf(() => svc.lines({ page: 0, text: '', chars: [], runs: [], lines: [], isScanned: true }))).toBe('unsupportedFeature:scannedText');
    const layer = await doc.getTextLayer(0);
    expect(await codeOf(() => svc.lines(layer))).toBe('unsupportedFeature:scannedText');
    doc.dispose();
  });
});

describe('ObjectEditService', () => {
  const svc = new ObjectEditService(images);

  it('selects, moves, resizes, rotates, replaces, extracts and deletes images with undo @FR-EDT-07', async () => {
    const { doc, history } = await openFixture('images');
    let imgs = await svc.imagesOn(doc, 0);
    expect(imgs.length).toBe(2);
    const png = svc.imageAt(imgs, { x: 100, y: 600 })!;
    expect(png.imageSize).toEqual({ width: 120, height: 80 });
    expect(svc.imageAt(imgs, { x: 500, y: 100 })).toBeUndefined();
    await history.execute(svc.move(0, png, 10, -20));
    await history.execute(svc.move(0, png, 5, -5));
    expect(history.state.done.length).toBe(1);
    imgs = await svc.imagesOn(doc, 0);
    expect(imgs[0]!.bounds).toMatchObject({ x: 87, y: 535 });
    await history.execute(svc.resize(0, imgs[0]!, { x: 87, y: 535, width: 90, height: 60 }));
    expect((await svc.imagesOn(doc, 0))[0]!.bounds).toMatchObject({ width: 90, height: 60 });
    await history.execute(svc.rotate(0, (await svc.imagesOn(doc, 0))[0]!, 90));
    const rotated = (await svc.imagesOn(doc, 0))[0]!.bounds;
    expect([Math.round(rotated.width), Math.round(rotated.height)]).toEqual([60, 90]);
    await history.undo();
    await history.undo();
    await history.undo();
    expect((await svc.imagesOn(doc, 0))[0]!.bounds).toMatchObject({ x: 72, y: 560, width: 180, height: 120 });
    const extracted = decodePng(await svc.extract(doc, 0, png.id));
    expect([extracted.width, extracted.height]).toEqual([120, 80]);
    const prepared = await svc.prepare(samplePng(30, 30, 8));
    await history.execute(svc.replace(0, png.id, prepared.image));
    expect((await svc.imagesOn(doc, 0))[0]).toMatchObject({ imageSize: { width: 30, height: 30 }, bounds: { width: 180, height: 120 } });
    await history.execute(svc.delete(0, png.id));
    expect((await svc.imagesOn(doc, 0)).length).toBe(1);
    await history.undo();
    await history.undo();
    expect((await svc.imagesOn(doc, 0))[0]!.imageSize).toEqual({ width: 120, height: 80 });
    expect(await codeOf(() => svc.resize(0, png, { x: 0, y: 0, width: 0.5, height: 5 }))).toBe('invalidArgument');
    doc.dispose();
  });

  it('inserts a new image from a file, clipboard or drop as page content @FR-EDT-07', async () => {
    const { doc, history } = await openFixture('text');
    const { sampleJpeg } = await import('@folio/testkit');
    const jpg = await svc.prepare(sampleJpeg(64, 48));
    expect(jpg.image).toHaveProperty('jpeg');
    const id = await history.execute(svc.insert(0, { image: jpg.image, rect: { x: 100, y: 100, width: 128, height: 96 } }));
    expect((await svc.imagesOn(doc, 0))[0]).toMatchObject({ id, imageSize: { width: 64, height: 48 } });
    await expect(await doc.save()).toBeValidPdf();
    await history.undo();
    expect(await svc.imagesOn(doc, 0)).toEqual([]);
    expect(await codeOf(svc.prepare(new Uint8Array([9, 9])))).toBe('invalidArgument:badImage');
    doc.dispose();
  });

  it('whiteout covers content with the sampled page colour; optional true removal of covered objects @FR-EDT-05', async () => {
    const { doc, history } = await openFixture('invoice');
    const layer = await doc.getTextLayer(0);
    const run = layer.runs.find((r) => r.text.startsWith('Total due'))!;
    const area = { x: run.rect.x - 2, y: run.rect.y - 2, width: run.rect.width + 4, height: run.rect.height + 4 };
    const color = await svc.backgroundAt(doc, 0, area);
    expect(color).toEqual({ r: 255, g: 255, b: 255 });
    expect(sampleBackground({ width: 3, height: 3, data: new Uint8ClampedArray(36).map((_, i) => (i % 4 === 3 ? 255 : i < 16 || i >= 20 ? 200 : 0)) }, { x: 0, y: 0, width: 3, height: 3 })).toEqual({ r: 200, g: 200, b: 200 });
    const view = { x: area.x + 1, y: 792 - area.y - area.height + 1, width: area.width - 2, height: area.height - 2 };
    expect((await history.execute(svc.whiteout(0, area, color))).removed).toBe(0);
    expect(inkRatio(await doc.render(0, { scale: 1 }), view)).toBe(0);
    // Cover only: the text is still in the file, which is why the UI never calls this "redact".
    expect(await pdftotext(await doc.save())).toContain('Total due');
    await history.undo();
    expect(inkRatio(await doc.render(0, { scale: 1 }), view)).toBeGreaterThan(0.05);
    const res = await history.execute(svc.whiteout(0, area, color, { removeUnder: true, objects: await doc.listObjects(0) }));
    expect(res.removed).toBe(1);
    const bytes = await doc.save();
    await expect(bytes).toBeValidPdf();
    expect(await pdftotext(bytes)).not.toContain('Total due');
    expect(await pdftotext(bytes)).toContain('Design services');
    await history.undo();
    expect((await doc.getTextLayer(0)).text).toContain('Total due');
    expect(await codeOf(() => svc.whiteout(0, { x: 0, y: 0, width: 0, height: 0 }, color))).toBe('invalidArgument');
    doc.dispose();
  });
});
