import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { FolioError, History } from '@folio/core';
import type { PdfDocument } from '@folio/ports';
import {
  FIXTURE_PASSWORD, FakeClock, FakeFileService, ManualTicker, MemoryStorage, NodeCrypto, NodeImageCodec, decodePng, fixture, inkRatio, pdfcpuFormFields,
  pdfinfo, pdftotext, sampleJpeg, samplePng, sharedEngine,
} from '@folio/testkit';
import { DocumentService, fingerprintOf } from './document.ts';
import { ExportService, exportPixelSize } from './export.ts';
import { ImageToPdfService, layoutImagePage, DEFAULT_IMAGE_PAGE } from './image-to-pdf.ts';
import { MergeService, sortSources } from './merge.ts';
import { RecoveryScheduler, RecoveryService } from './recovery.ts';
import { SplitService, cutsForEveryN, expandTemplate, planFiles, planSplit } from './split.ts';
import { markers } from './testing.ts';

const codeOf = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    return e instanceof FolioError ? `${e.code}${e.params.reason ? `:${e.params.reason}` : ''}` : String(e);
  }
};
const images = new NodeImageCodec();

describe('DocumentService', () => {
  const setup = async () => {
    const engine = await sharedEngine();
    const files = new FakeFileService();
    return { engine, files, svc: new DocumentService({ engine, files, crypto: new NodeCrypto() }) };
  };

  it('opens from a file reference with a stable fingerprint @FR-APP-01', async () => {
    const { files, svc } = await setup();
    const bytes = await fixture('invoice');
    const a = await svc.open(files.put('/docs/invoice.pdf', bytes));
    const b = await svc.open(files.put('/elsewhere/renamed.pdf', bytes));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}-\d+$/);
    expect(a.byteSize).toBe(bytes.length);
    expect(a.meta.title).toBe('Invoice 2026-014');
    expect(await fingerprintOf(await fixture('text'), new NodeCrypto())).not.toBe(a.fingerprint);
    expect(await codeOf(svc.open(files.ref('/missing.pdf')))).toBe('io');
    a.doc.dispose();
    b.doc.dispose();
  });

  it('prompts for a password and never stores it @FR-APP-12', async () => {
    const { files, svc } = await setup();
    const ref = files.put('/docs/secret.pdf', await fixture('encrypted'));
    expect(await codeOf(svc.open(ref))).toBe('passwordRequired');
    expect(await codeOf(svc.open(ref, { password: 'wrong' }))).toBe('wrongPassword');
    const opened = await svc.open(ref, { password: FIXTURE_PASSWORD });
    expect(opened.meta.isEncrypted).toBe(true);
    // The service keeps no state at all between calls: nothing can retain the password.
    expect(Object.keys(svc)).toEqual(['deps']);
    opened.doc.dispose();
  });

  it('opens damaged files in recovery mode and rejects non-PDFs @FR-APP-13', async () => {
    const { files, svc } = await setup();
    const opened = await svc.open(files.put('/d.pdf', await fixture('damaged')));
    expect(opened.meta.wasRepaired).toBe(true);
    opened.doc.dispose();
    expect(await codeOf(svc.open(files.put('/g.pdf', await fixture('garbage'))))).toBe('invalidPdf');
  });

  it('saves atomically with a .bak of the original, after verifying the output @FR-APP-04', async () => {
    const { files, svc } = await setup();
    const original = await fixture('text');
    const ref = files.put('/docs/a.pdf', original);
    const { doc } = await svc.open(ref);
    await doc.rotatePages([0], 90);
    const res = await svc.save(doc, ref, { backup: true });
    expect(files.writes).toEqual([{ path: '/docs/a.pdf', atomic: true, backup: true }]);
    expect(Buffer.from(files.get('/docs/a.pdf.bak')!).equals(Buffer.from(original))).toBe(true);
    const saved = files.get('/docs/a.pdf')!;
    expect(saved.length).toBe(res.byteSize);
    await expect(saved).toBeValidPdf();
    await svc.save(doc, files.ref('/docs/b.pdf'), { backup: false });
    expect(files.get('/docs/b.pdf.bak')).toBeUndefined();
    await svc.exportCopy(doc, files.ref('/docs/copy.pdf'));
    expect(files.writes.at(-1)).toEqual({ path: '/docs/copy.pdf', atomic: true, backup: false });
    files.failWrites = true;
    expect(await codeOf(svc.save(doc, ref))).toBe('io');
    expect(Buffer.from(files.get('/docs/a.pdf')!).equals(Buffer.from(saved))).toBe(true);
    doc.dispose();
  });

  it('warns about existing signatures and keeps the signed bytes with incremental save @FR-APP-11', async () => {
    const { files, svc } = await setup();
    const original = await fixture('signed');
    const ref = files.put('/s.pdf', original);
    const { doc, meta } = await svc.open(ref);
    expect(svc.savePolicy(meta)).toEqual({ warnSignatures: true, incrementalRecommended: true });
    await doc.upsertAnnotation(0, { type: 'text', rect: { x: 300, y: 600, width: 20, height: 20 }, contents: 'note' });
    await svc.save(doc, ref, { incremental: true, backup: false });
    const saved = files.get('/s.pdf')!;
    expect(Buffer.from(saved.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
    expect(saved.length).toBeGreaterThan(original.length);
    doc.dispose();
    const plain = await svc.open(files.put('/t.pdf', await fixture('text')));
    expect(svc.savePolicy(plain.meta)).toEqual({ warnSignatures: false, incrementalRecommended: false });
    plain.doc.dispose();
  });

  it('edits metadata with undo and removes all metadata @FR-SEC-04', async () => {
    const { engine, files, svc } = await setup();
    const { doc, meta } = await svc.open(files.put('/t.pdf', await fixture('text')));
    const history = new History({ doc, engine });
    await history.execute(svc.setMetadata(meta, { title: 'Renamed', keywords: 'x' }));
    expect(await doc.getMeta()).toMatchObject({ title: 'Renamed', keywords: 'x', author: 'Folio testkit' });
    await history.undo();
    expect(await doc.getMeta()).toMatchObject({ title: 'Text document', keywords: 'fixture folio' });
    await history.execute(svc.removeAllMetadata());
    const info = await pdfinfo(await doc.save());
    expect([info.title, info.author, info.subject, info.keywords, info.producer]).toEqual(['', '', '', '', '']);
    await history.undo();
    expect((await doc.getMeta()).title).toBe('Text document');
    doc.dispose();
  });

  it('describes a document for the properties dialog @FR-VIEW-11', async () => {
    const { files, svc } = await setup();
    const { doc, byteSize } = await svc.open(files.put('/m.pdf', await fixture('mixed-sizes')));
    const p = await svc.properties(doc, byteSize);
    expect(p).toMatchObject({ pageCount: 4, byteSize });
    expect(p.pageSizes.map((s) => [s.name, s.landscape, s.count])).toEqual([['A4', false, 1], ['Letter', true, 1], ['A5', false, 1], [undefined, true, 1]]);
    expect(p.fonts).toEqual([{ name: 'Helvetica', embedded: false, subset: false }]);
    expect(p.meta.pdfVersion).toMatch(/^1\./);
    doc.dispose();
    const sub = await svc.open(files.put('/s.pdf', await fixture('subset-font')));
    expect((await svc.properties(sub.doc)).fonts[0]).toMatchObject({ embedded: true, subset: true });
    sub.doc.dispose();
  });
});

describe('MergeService', () => {
  const svc = async () => new MergeService({ engine: await sharedEngine(), images });

  it('merges files in list order with per-file ranges and leaves sources untouched @FR-MRG-01', async () => {
    const a = await fixture('text');
    const b = await fixture('text-25');
    const before = Buffer.from(a).toString('base64');
    const progress: number[] = [];
    const out = await (await svc()).merge([{ name: 'b.pdf', bytes: b, range: '24-,1' }, { name: 'a.pdf', bytes: a }], {}, undefined, (d) => progress.push(d));
    expect(await markers(out)).toEqual([24, 25, 1, 1, 2, 3]);
    expect(progress).toEqual([1, 2]);
    expect(Buffer.from(a).toString('base64')).toBe(before);
    const bytes = await out.save();
    await expect(bytes).toBeValidPdf();
    await expect(bytes).toHavePageCount(6);
    out.dispose();
  });

  it('adds one bookmark per source file and nests the source outline @FR-MRG-02', async () => {
    const out = await (await svc()).merge([
      { name: 'Report.pdf', bytes: await fixture('text') },
      { name: 'Book.final.pdf', bytes: await fixture('bookmarks'), range: '2-5' },
      { name: 'photo.png', bytes: samplePng() },
    ]);
    const outline = await out.getOutline();
    expect(outline.map((n) => [n.title, n.target])).toEqual([
      ['Report', expect.objectContaining({ page: 0 })],
      ['Book.final', expect.objectContaining({ page: 3 })],
      ['photo', expect.objectContaining({ page: 7 })],
    ]);
    // Chapter 1 (page 1) was not included: it survives as a group pointing at its first included child.
    expect(outline[1]!.children.map((c) => [c.title, (c.target as { page: number }).page])).toEqual([['Chapter 1', 3], ['Chapter 2', 5], ['Appendix – Ünïcode', 6]]);
    expect(outline[1]!.children[0]!.children[0]).toMatchObject({ title: 'Section 1.1', target: { page: 3 } });
    const none = await (await svc()).merge([{ name: 'a.pdf', bytes: await fixture('bookmarks') }], { bookmarks: false });
    expect(await none.getOutline()).toEqual([]);
    out.dispose();
    none.dispose();
  });

  it('keeps form fields working and renames collisions; or flattens them on request @FR-MRG-02', async () => {
    const sources = [
      { name: 'one.pdf', bytes: await fixture('acroform-prefilled') },
      { name: 'two.pdf', bytes: await fixture('acroform-2') },
    ];
    const out = await (await svc()).merge(sources);
    const names = (await out.listFormFields()).map((f) => f.name);
    expect(names).toContain('person.name');
    expect(names).toContain('person_2.name');
    expect(names).toContain('email');
    await out.setFieldValue('person_2.name', 'Second Person');
    const bytes = await out.save();
    await expect(bytes).toBeValidPdf();
    const rows = Object.fromEntries((await pdfcpuFormFields(bytes)).map((r) => [r.name, r.value]));
    expect(rows).toMatchObject({ 'person.name': 'Marta Esempio', 'person_2.name': 'Second Person', country: 'Italy' });
    out.dispose();
    const flat = await (await svc()).merge(sources, { keepFormFields: false });
    expect(await flat.listFormFields()).toEqual([]);
    expect(await pdftotext(await flat.save())).toContain('Marta Esempio');
    flat.dispose();
  });

  it('accepts images as pages @FR-MRG-03', async () => {
    const out = await (await svc()).merge([{ name: 'a.pdf', bytes: await fixture('text') }, { name: 'scan.JPG', bytes: sampleJpeg(200, 100) }], { image: { pageSize: 'image', margin: 0, dpi: 72 } });
    expect(out.pageCount).toBe(4);
    expect((await out.getPageInfo(3)).size).toEqual({ width: 200, height: 100 });
    expect((await out.listObjects(3)).map((o) => o.type)).toEqual(['image']);
    out.dispose();
  });

  it('inspects sources: counts, ranges, passwords, corrupt and empty files @FR-MRG-01 @FR-MRG-06', async () => {
    const s = await svc();
    expect(await s.inspect({ name: 'a.pdf', bytes: await fixture('text-25'), range: '1-3,7,10-' })).toEqual({ name: 'a.pdf', kind: 'pdf', pageCount: 20, totalPages: 25 });
    expect((await s.inspect({ name: 'a.pdf', bytes: await fixture('text'), range: '9' })).problem).toBe('badRange');
    expect((await s.inspect({ name: 'e.pdf', bytes: await fixture('encrypted') })).problem).toBe('passwordRequired');
    expect((await s.inspect({ name: 'e.pdf', bytes: await fixture('encrypted'), password: 'x' })).problem).toBe('wrongPassword');
    expect(await s.inspect({ name: 'e.pdf', bytes: await fixture('encrypted'), password: FIXTURE_PASSWORD })).toEqual({ name: 'e.pdf', kind: 'pdf', pageCount: 1, totalPages: 1 });
    expect((await s.inspect({ name: 'g.pdf', bytes: await fixture('garbage') })).problem).toBe('invalid');
    expect((await s.inspect({ name: 'g.png', bytes: await fixture('garbage') })).problem).toBe('invalid');
    expect(await s.inspect({ name: 'p.png', bytes: samplePng() })).toMatchObject({ kind: 'image', pageCount: 1 });
    const empty = await (await sharedEngine()).create();
    expect((await s.inspect({ name: 'z.pdf', bytes: await empty.save() })).problem).toBe('empty');
    empty.dispose();
    expect(await codeOf(s.merge([]))).toBe('invalidArgument');
    expect(await codeOf(s.merge([{ name: 'e.pdf', bytes: await fixture('encrypted') }]))).toBe('passwordRequired');
    const merged = await s.merge([{ name: 'e.pdf', bytes: await fixture('encrypted'), password: FIXTURE_PASSWORD }, { name: 't.pdf', bytes: await fixture('text') }]);
    expect(merged.pageCount).toBe(4);
    merged.dispose();
    const ac = new AbortController();
    ac.abort();
    expect(await codeOf(s.merge([{ name: 'a.pdf', bytes: await fixture('text') }], {}, ac.signal))).toBe('cancelled');
  });

  it('sorts the file list by name (natural order) or date @FR-MRG-01', () => {
    const items = [{ name: 'scan10.pdf', modified: 1 }, { name: 'Scan2.pdf', modified: 3 }, { name: 'a.pdf', modified: 2 }];
    expect(sortSources(items, 'name').map((i) => i.name)).toEqual(['a.pdf', 'Scan2.pdf', 'scan10.pdf']);
    expect(sortSources(items, 'date').map((i) => i.name)).toEqual(['scan10.pdf', 'a.pdf', 'Scan2.pdf']);
  });
});

describe('SplitService', () => {
  it('plans by ranges, every N pages, single pages and cut points @FR-MRG-04', () => {
    expect(planSplit(25, { kind: 'everyN', n: 10 }).map((p) => [p.n, p.from, p.to, p.pages.length])).toEqual([[1, 1, 10, 10], [2, 11, 20, 10], [3, 21, 25, 5]]);
    expect(planSplit(3, { kind: 'single' }).map((p) => p.pages)).toEqual([[0], [1], [2]]);
    expect(planSplit(10, { kind: 'ranges', ranges: ['1-3', '', '7,9-'] }).map((p) => [p.from, p.to, p.pages])).toEqual([[1, 3, [0, 1, 2]], [7, 10, [6, 8, 9]]]);
    expect(planSplit(6, { kind: 'cuts', after: [1, 3, 3, 9] }).map((p) => p.pages)).toEqual([[0, 1], [2, 3], [4, 5]]);
    expect(planSplit(6, { kind: 'cuts', after: [] }).map((p) => p.pages.length)).toEqual([6]);
    expect(cutsForEveryN(25, 10)).toEqual([9, 19]);
    expect(planSplit(25, { kind: 'cuts', after: cutsForEveryN(25, 10) })).toEqual(planSplit(25, { kind: 'everyN', n: 10 }));
  });
  it('rejects invalid plans with a reason @FR-MRG-04', async () => {
    expect(await codeOf(() => planSplit(5, { kind: 'everyN', n: 0 }))).toBe('invalidArgument:badN');
    expect(await codeOf(() => planSplit(5, { kind: 'everyN', n: 1.5 }))).toBe('invalidArgument:badN');
    expect(await codeOf(() => planSplit(5, { kind: 'ranges', ranges: [' '] }))).toBe('invalidArgument:noRanges');
    expect(await codeOf(() => planSplit(5, { kind: 'ranges', ranges: ['9'] }))).toBe('invalidArgument');
  });
  it('expands the naming template tokens and sanitises names @FR-MRG-05', async () => {
    const part = { n: 2, pages: [10, 11], from: 11, to: 12 };
    expect(expandTemplate('{name}_{n}', 'report', part, 3)).toBe('report_2.pdf');
    expect(expandTemplate('{name}_{n}', 'report', part, 12)).toBe('report_02.pdf');
    expect(expandTemplate('{name} p{from}-{to}.PDF', 'report', part, 3)).toBe('report p11-12.PDF');
    expect(expandTemplate('', 'r', part, 3)).toBe('r_2.pdf');
    expect(expandTemplate('a/b:{n}', 'r', part, 3)).toBe('a_b_2.pdf');
    expect(await codeOf(() => expandTemplate('{name}_{page}', 'r', part, 3))).toBe('invalidArgument:badToken');
  });
  it('handles name conflicts by policy: auto-number, overwrite, ask @FR-MRG-05', async () => {
    const parts = planSplit(25, { kind: 'everyN', n: 10 });
    const existing = new Set(['big_1.pdf', 'big_1 (2).pdf']);
    const exists = async (n: string) => existing.has(n);
    const auto = await planFiles(parts, { template: '{name}_{n}', sourceName: 'big.pdf', policy: 'autoNumber', exists });
    expect(auto.map((f) => [f.name, f.conflict])).toEqual([['big_1 (3).pdf', false], ['big_2.pdf', false], ['big_3.pdf', false]]);
    const ask = await planFiles(parts, { template: '{name}_{n}', sourceName: 'big.pdf', policy: 'ask', exists });
    expect(ask.map((f) => [f.name, f.conflict])).toEqual([['big_1.pdf', true], ['big_2.pdf', false], ['big_3.pdf', false]]);
    // A template without {n} would give every part the same name: later parts are numbered regardless of policy.
    const same = await planFiles(parts, { template: 'out', sourceName: 'big.pdf', policy: 'overwrite', exists: async () => false });
    expect(same.map((f) => f.name)).toEqual(['out.pdf', 'out (2).pdf', 'out (3).pdf']);
  });
  it('writes the planned files with progress and cancel; the preview matches the result @FR-MRG-06', async () => {
    const engine = await sharedEngine();
    const doc = await engine.open(await fixture('text-25'));
    const files = new FakeFileService();
    files.put('/out/Twenty_2.pdf', new Uint8Array([1]));
    const folder = files.ref('/out');
    const plan = await planFiles(planSplit(doc.pageCount, { kind: 'everyN', n: 10 }), { template: '{name}_{n}', sourceName: 'Twenty.pdf', policy: 'ask', exists: (n) => files.exists(folder, n) });
    expect(plan.map((f) => [f.name, f.from, f.to, f.conflict])).toEqual([['Twenty_1.pdf', 1, 10, false], ['Twenty_2.pdf', 11, 20, true], ['Twenty_3.pdf', 21, 25, false]]);
    const progress: number[] = [];
    const svc = new SplitService(engine);
    const sink = async (name: string, bytes: Uint8Array) => void (await files.writeInFolder(folder, name, bytes));
    const res = await svc.execute(doc, plan, sink, { overwrite: () => false, onProgress: (d) => progress.push(d) });
    expect(res).toEqual({ written: ['Twenty_1.pdf', 'Twenty_3.pdf'], skipped: ['Twenty_2.pdf'] });
    expect(progress).toEqual([1, 2, 3]);
    expect(files.get('/out/Twenty_2.pdf')!.length).toBe(1);
    await expect(files.get('/out/Twenty_1.pdf')!).toHavePageCount(10);
    await expect(files.get('/out/Twenty_3.pdf')!).toHavePageCount(5);
    await expect(files.get('/out/Twenty_3.pdf')!).toBeValidPdf();
    expect(await pdftotext(files.get('/out/Twenty_3.pdf')!, { page: 1 })).toContain('Page 21 of 25');
    await svc.execute(doc, plan, sink, { overwrite: () => true });
    await expect(files.get('/out/Twenty_2.pdf')!).toHavePageCount(10);
    const ac = new AbortController();
    let n = 0;
    expect(await codeOf(svc.execute(doc, plan, sink, { overwrite: () => true, signal: ac.signal, onProgress: () => ++n === 1 && ac.abort() }))).toBe('cancelled');
    expect(doc.pageCount).toBe(25);
    doc.dispose();
  });
});

describe('ImageToPdfService', () => {
  it('lays out fit, fill, original and image-sized pages @FR-MRG-03 @FR-OPT-03', () => {
    const o = DEFAULT_IMAGE_PAGE;
    const wide = layoutImagePage({ width: 2000, height: 1000 }, o);
    expect(wide.page).toEqual({ width: 841.89, height: 595.28 });
    expect(wide.rect.x).toBeCloseTo(36);
    expect(wide.rect.width).toBeCloseTo(841.89 - 72);
    expect(layoutImagePage({ width: 1000, height: 2000 }, o).page).toEqual({ width: 595.28, height: 841.89 });
    expect(layoutImagePage({ width: 2000, height: 1000 }, { ...o, orientation: 'portrait' }).page.width).toBe(595.28);
    const fill = layoutImagePage({ width: 1000, height: 1000 }, { ...o, fit: 'fill', margin: 0 });
    expect(fill.rect.height).toBeCloseTo(841.89);
    expect(fill.rect.x).toBeLessThan(0);
    const orig = layoutImagePage({ width: 192, height: 96 }, { ...o, fit: 'original' });
    expect([orig.rect.width, orig.rect.height]).toEqual([144, 72]);
    expect(layoutImagePage({ width: 192, height: 96 }, { ...o, pageSize: 'image', margin: 10 })).toEqual({ page: { width: 164, height: 92 }, rect: { x: 10, y: 10, width: 144, height: 72 } });
  });
  it('turns photos into one page each; JPEG data is embedded untouched @FR-OPT-03', async () => {
    const svc = new ImageToPdfService({ engine: await sharedEngine(), images });
    const jpg = sampleJpeg(300, 200, 4);
    const progress: number[] = [];
    const doc = await svc.create([{ name: '1.jpg', bytes: jpg }, { name: '2.png', bytes: samplePng(100, 300) }, { name: '3.jpg', bytes: sampleJpeg(80, 80) }], { margin: 18 }, undefined, (d) => progress.push(d));
    expect(doc.pageCount).toBe(3);
    expect(progress).toEqual([1, 2, 3]);
    expect((await doc.getPageInfo(0)).size.width).toBeCloseTo(841.89, 1);
    expect((await doc.getPageInfo(1)).size.width).toBeCloseTo(595.28, 1);
    const obj = (await doc.listObjects(0))[0]!;
    expect(obj).toMatchObject({ type: 'image', imageSize: { width: 300, height: 200 } });
    expect(obj.bounds.x).toBeCloseTo(18, 0);
    const bytes = await doc.save();
    await expect(bytes).toBeValidPdf();
    expect(Buffer.from(bytes).includes(Buffer.from(jpg.subarray(20, 200)))).toBe(true);
    expect(inkRatio(await doc.render(0, { scale: 0.25 }))).toBeGreaterThan(0.5);
    doc.dispose();
    expect(await codeOf(svc.create([]))).toBe('invalidArgument');
    expect(await codeOf(svc.create([{ name: 'x.png', bytes: new Uint8Array([1, 2, 3]) }]))).toBe('invalidArgument:badImage');
  });
});

describe('ExportService', () => {
  it('exports pages as PNG and JPEG at the requested DPI, with names and a zip @FR-OPT-02', async () => {
    const engine = await sharedEngine();
    const doc = await engine.open(await fixture('rotated-pages'));
    const svc = new ExportService(images);
    expect(await exportPixelSize(doc, 1, 144)).toEqual({ width: 1584, height: 1224 });
    const out = await svc.exportPages(doc, [0, 1], { format: 'png', dpi: 72 }, 'My file.pdf');
    expect(out.map((o) => [o.name, o.width, o.height])).toEqual([['My file_p1.png', 612, 792], ['My file_p2.png', 792, 612]]);
    const png = decodePng(out[0]!.bytes);
    expect([png.width, png.height]).toEqual([612, 792]);
    expect(inkRatio(png)).toBeGreaterThan(0.001);
    const jpg = await svc.exportPages(doc, [3], { format: 'jpeg', dpi: 72, quality: 0.8 }, 'x');
    expect(jpg[0]!.name).toBe('x_p4.jpg');
    expect([...jpg[0]!.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    const zip = unzipSync(svc.zip(out));
    expect(Object.keys(zip)).toEqual(['My file_p1.png', 'My file_p2.png']);
    expect(zip['My file_p1.png']!.length).toBe(out[0]!.bytes.length);
    expect(await codeOf(svc.exportPages(doc, [0], { format: 'png', dpi: 50 }, 'x'))).toBe('invalidArgument:dpi');
    expect(await codeOf(svc.exportPages(doc, [0], { format: 'png', dpi: 700 }, 'x'))).toBe('invalidArgument:dpi');
    expect(await codeOf(svc.exportPages(doc, [], { format: 'png', dpi: 72 }, 'x'))).toBe('invalidArgument');
    expect(await codeOf(svc.exportPages(doc, [0], { format: 'webp', dpi: 72 }, 'x'))).toBe('unsupportedFeature');
    const ac = new AbortController();
    ac.abort();
    expect(await codeOf(svc.exportPages(doc, [0], { format: 'png', dpi: 72 }, 'x', ac.signal))).toBe('cancelled');
    doc.dispose();
  });
  it('snapshots a page area as an image @FR-OPT-04', async () => {
    const engine = await sharedEngine();
    const doc = await engine.open(await fixture('rotated-pages'));
    const svc = new ExportService(images);
    const blue = await svc.snapshot(doc, 0, { x: 72, y: 600, width: 60, height: 30 }, 72);
    expect([blue.width, blue.height]).toEqual([60, 30]);
    expect(inkRatio(blue)).toBeGreaterThan(0.95);
    expect(blue.data[2]!).toBeGreaterThan(200);
    const rot = await svc.snapshot(doc, 1, { x: 72, y: 600, width: 60, height: 30 }, 72);
    expect([rot.width, rot.height]).toEqual([30, 60]);
    expect(inkRatio(rot)).toBeGreaterThan(0.9);
    const png = decodePng(await svc.snapshotPng(doc, 0, { x: 0, y: 0, width: 100, height: 50 }));
    expect([png.width, png.height]).toEqual([200, 100]);
    expect(await codeOf(svc.snapshot(doc, 0, { x: 0, y: 0, width: 0, height: 5 }))).toBe('invalidArgument');
    doc.dispose();
  });
  it('flattens annotations, form or both as one undoable step, or into a copy @FR-OPT-06 @FR-ANN-09 @FR-FRM-05', async () => {
    const engine = await sharedEngine();
    const doc = await engine.open(await fixture('acroform-prefilled'));
    await doc.upsertAnnotation(0, { type: 'square', rect: { x: 400, y: 100, width: 50, height: 50 }, strokeWidth: 2, strokeStyle: 'solid', color: { r: 255, g: 0, b: 0 } });
    const history = new History({ doc, engine });
    const svc = new ExportService(images);
    const copy = await svc.flattenedCopy(doc, engine);
    await expect(copy).toBeValidPdf();
    expect(await pdfcpuFormFields(copy)).toEqual([]);
    expect((await doc.listFormFields()).length).toBe(9);
    await history.execute(svc.flatten('annotations'));
    expect(await doc.listAnnotations(0)).toEqual([]);
    expect((await doc.listFormFields()).length).toBe(9);
    await history.execute(svc.flatten('form'));
    expect(await doc.listFormFields()).toEqual([]);
    expect((await doc.getTextLayer(0)).text).toContain('Marta Esempio');
    await history.undo();
    await history.undo();
    expect((await doc.listFormFields()).length).toBe(9);
    expect((await doc.listAnnotations(0)).length).toBe(1);
    await history.execute(svc.flatten('both'));
    expect([(await doc.listFormFields()).length, (await doc.listAnnotations(0)).length]).toEqual([0, 0]);
    doc.dispose();
  });
});

describe('RecoveryService', () => {
  const state = (sessionId: string, revision: number) => ({ sessionId, name: `${sessionId}.pdf`, path: `/docs/${sessionId}.pdf`, revision });
  it('writes a snapshot per dirty revision and restores it after a crash @FR-APP-06', async () => {
    const engine = await sharedEngine();
    const storage = new MemoryStorage();
    const clock = new FakeClock();
    const rec = new RecoveryService({ storage, clock });
    const doc = await engine.open(await fixture('text'));
    await doc.deletePages([0]);
    expect(await rec.snapshot(doc, state('s1', 1))).toBe(true);
    expect(await rec.snapshot(doc, state('s1', 1))).toBe(false);
    clock.advance(30_000);
    await doc.rotatePages([0], 90);
    expect(await rec.snapshot(doc, { ...state('s1', 2), view: { page: 1, zoom: 1.5 } })).toBe(true);
    expect((await storage.list('recovery/')).sort()).toEqual(['recovery/s1.json', 'recovery/s1.pdf']);
    doc.dispose(); // "crash": the session is gone, storage survives

    const next = new RecoveryService({ storage, clock });
    const pending = await next.pending();
    expect(pending).toEqual([{ sessionId: 's1', name: 's1.pdf', path: '/docs/s1.pdf', revision: 2, savedAt: '2026-10-11T09:00:30.000Z', pageCount: 2, view: { page: 1, zoom: 1.5 } }]);
    const restored: PdfDocument = await engine.open((await next.load('s1'))!);
    expect(await markers(restored)).toEqual([2, 3]);
    expect((await restored.getPageInfo(0)).rotation).toBe(90);
    restored.dispose();
    await next.discard('s1');
    expect(await next.pending()).toEqual([]);
    expect(await storage.list('recovery/')).toEqual([]);
    expect(await next.load('s1')).toBeNull();
  });
  it('ignores torn state files and clears everything on request @FR-APP-06', async () => {
    const storage = new MemoryStorage();
    const rec = new RecoveryService({ storage, clock: new FakeClock() });
    await storage.write('recovery/bad.json', new TextEncoder().encode('{not json'));
    await storage.write('recovery/orphan.json', new TextEncoder().encode(JSON.stringify({ sessionId: 'orphan', savedAt: 'x' })));
    expect(await rec.pending()).toEqual([]);
    await rec.discardAll();
    expect(await storage.list('')).toEqual([]);
  });
  it('snapshots dirty sessions on every tick of the configured interval @FR-APP-06 @FR-APP-10', async () => {
    const engine = await sharedEngine();
    const storage = new MemoryStorage();
    const rec = new RecoveryService({ storage, clock: new FakeClock() });
    const ticker = new ManualTicker();
    const a = await engine.open(await fixture('text'));
    const b = await engine.open(await fixture('invoice'));
    const sessions = [{ doc: a, dirty: true, state: state('a', 1) }, { doc: b, dirty: false, state: state('b', 0) }];
    const errors: unknown[] = [];
    const sched = new RecoveryScheduler(rec, ticker, () => sessions, (e) => errors.push(e));
    sched.start(30);
    expect(ticker.intervals).toEqual([30_000]);
    expect(await sched.tick()).toBe(1);
    expect(await sched.tick()).toBe(0);
    sessions[1]!.dirty = true;
    sessions[0]!.state = state('a', 2);
    expect(await sched.tick()).toBe(2);
    expect((await rec.pending()).map((p) => p.sessionId).sort()).toEqual(['a', 'b']);
    b.dispose();
    sessions[1]!.state = state('b', 5);
    expect(await sched.tick()).toBe(0);
    expect(errors.length).toBe(1);
    sched.start(10);
    expect(ticker.intervals).toEqual([10_000]);
    sched.stop();
    expect(ticker.intervals).toEqual([]);
    a.dispose();
  });
});
