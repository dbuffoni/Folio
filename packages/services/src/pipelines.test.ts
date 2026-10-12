// Failure, cancellation and invariants of the multi-step services: merge, split, render queue, recovery.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CancelledError, FolioError } from '@folio/core';
import type { PdfDocument } from '@folio/ports';
import { FakeClock, ManualTicker, MemoryStorage, fixture, sharedEngine } from '@folio/testkit';
import { MergeService, sortSources } from './merge.ts';
import { RecoveryScheduler, RecoveryService } from './recovery.ts';
import { RenderService } from './render.ts';
import {
  SplitService,
  cutsForEveryN,
  expandTemplate,
  planFiles,
  planSplit,
  type ConflictPolicy,
} from './split.ts';
import { openFixture } from './testing.ts';
import { NodeImageCodec, sampleJpeg } from '@folio/testkit';

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof FolioError
      ? `${e.code}${e.params.reason ? `:${e.params.reason}` : ''}`
      : e instanceof CancelledError
        ? 'cancelled'
        : `raw:${String(e)}`;
  }
};

describe('planSplit invariants @FR-MRG-04', () => {
  it('every-N, single and cuts partition the pages: each exactly once, in order (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 120 }),
        fc.integer({ min: 1, max: 40 }),
        fc.array(fc.integer({ min: -3, max: 130 }), { maxLength: 15 }),
        (count, n, after) => {
          const all = Array.from({ length: count }, (_, i) => i);
          for (const mode of [
            { kind: 'everyN', n } as const,
            { kind: 'single' } as const,
            { kind: 'cuts', after } as const,
          ]) {
            const parts = planSplit(count, mode);
            expect(parts.flatMap((p) => p.pages)).toEqual(all);
            expect(parts.map((p) => p.n)).toEqual(parts.map((_, i) => i + 1));
            for (const p of parts) {
              expect(p.from).toBe(p.pages[0]! + 1);
              expect(p.to).toBe(p.pages[p.pages.length - 1]! + 1);
            }
          }
          // every-N via explicit cuts is the same plan
          expect(planSplit(count, { kind: 'cuts', after: cutsForEveryN(count, n) })).toEqual(
            planSplit(count, { kind: 'everyN', n }),
          );
        },
      ),
    );
  });

  it('refuses a document without pages', () => {
    expect(() => planSplit(0, { kind: 'single' })).toThrow(/no pages/);
  });

  it('an N larger than the page count gives a single part', () => {
    expect(planSplit(3, { kind: 'everyN', n: 500 }).map((p) => p.pages)).toEqual([[0, 1, 2]]);
  });

  it('ranges may overlap and repeat pages, and reverse ranges reverse the part', () => {
    const parts = planSplit(6, { kind: 'ranges', ranges: ['1-3', '2-4', '6-5'] });
    expect(parts.map((p) => p.pages)).toEqual([
      [0, 1, 2],
      [1, 2, 3],
      [5, 4],
    ]);
    expect([parts[2]!.from, parts[2]!.to]).toEqual([5, 6]);
  });
});

describe('file names @FR-MRG-05', () => {
  const part = { n: 1, pages: [0], from: 1, to: 1 };
  it('rejects templates that collapse to nothing and neutralises path traversal', () => {
    expect(() => expandTemplate('..', 'r', part, 1)).toThrow(/empty file name/);
    expect(() => expandTemplate('.', 'r', part, 1)).toThrow(/empty file name/);
    expect(expandTemplate('../../etc/{name}', 'r', part, 1)).toBe('.._.._etc_r.pdf');
    expect(expandTemplate('a\u0000b', 'r', part, 1)).toBe('a_b.pdf');
    expect(expandTemplate('  {name}  ', 'r', part, 1)).toBe('r.pdf');
    expect(expandTemplate('{n}', 'x', { ...part, n: 7 }, 120)).toBe('007.pdf');
  });

  it('no two planned files ever share a name, whatever the policy (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 30 }),
        fc.constantFrom<ConflictPolicy>('ask', 'overwrite', 'autoNumber'),
        fc.constantFrom('out', '{name}', 'p{to}', '{name}_{n}'),
        async (count, policy, template) => {
          const parts = planSplit(count, { kind: 'single' });
          const existing = new Set(['out.pdf', 'doc_1.pdf', 'p2.pdf']);
          const plan = await planFiles(parts, {
            template,
            sourceName: 'doc.pdf',
            policy,
            exists: async (n) => existing.has(n),
          });
          const names = plan.map((p) => p.name.toLowerCase());
          expect(new Set(names).size).toBe(names.length);
          if (policy === 'autoNumber') expect(plan.some((p) => p.conflict)).toBe(false);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('SplitService.execute @FR-MRG-04 @FR-MRG-06', () => {
  it('skips conflicts unless told to overwrite and reports progress', async () => {
    const { engine, doc } = await openFixture('text');
    const svc = new SplitService(engine);
    const plan = await planFiles(planSplit(3, { kind: 'single' }), {
      template: '{name}_{n}',
      sourceName: 'a.pdf',
      policy: 'ask',
      exists: async (n) => n === 'a_2.pdf',
    });
    const written = new Map<string, Uint8Array>();
    const progress: Array<[number, number]> = [];
    const r1 = await svc.execute(doc, plan, async (n, b) => void written.set(n, b), {
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect(r1).toEqual({ written: ['a_1.pdf', 'a_3.pdf'], skipped: ['a_2.pdf'] });
    expect(progress.at(-1)).toEqual([3, 3]);
    const r2 = await svc.execute(doc, plan, async (n, b) => void written.set(n, b), {
      overwrite: async (n) => n === 'a_2.pdf',
    });
    expect(r2.skipped).toEqual([]);
    for (const bytes of written.values()) await expect(bytes).toHavePageCount(1);
    doc.dispose();
  });

  it('stops at an abort between files and keeps what was written', async () => {
    const { engine, doc } = await openFixture('text');
    const ac = new AbortController();
    const out: string[] = [];
    const plan = await planFiles(planSplit(3, { kind: 'single' }), {
      template: 'p{n}',
      sourceName: 'a.pdf',
      policy: 'autoNumber',
      exists: async () => false,
    });
    const run = new SplitService(engine).execute(
      doc,
      plan,
      async (n) => {
        out.push(n);
        ac.abort();
      },
      { signal: ac.signal },
    );
    expect(await codeOf(run)).toBe('cancelled');
    expect(out).toEqual(['p1.pdf']);
    doc.dispose();
  });

  it('propagates a sink failure and releases the part document', async () => {
    const engine = await sharedEngine();
    const { doc } = await openFixture('text');
    let live = 0;
    const counting = {
      ...engine,
      merge: async (...a: Parameters<typeof engine.merge>) => {
        const d = await engine.merge(...a);
        live++;
        return Object.assign(Object.create(d), {
          dispose: () => {
            live--;
            d.dispose();
          },
        }) as PdfDocument;
      },
    } as typeof engine;
    const plan = await planFiles(planSplit(3, { kind: 'single' }), {
      template: 'p{n}',
      sourceName: 'a.pdf',
      policy: 'autoNumber',
      exists: async () => false,
    });
    const run = new SplitService(counting).execute(doc, plan, async () => {
      throw new Error('disk full');
    });
    await expect(run).rejects.toThrow('disk full');
    expect(live).toBe(0);
    doc.dispose();
  });
});

describe('MergeService @FR-MRG-01 @FR-MRG-02', () => {
  const svc = async () => new MergeService({ engine: await sharedEngine(), images: new NodeImageCodec() });

  it('sorts by natural name, and by modified date with name as tie-break', () => {
    const items = [
      { name: 'file10.pdf', modified: 3 },
      { name: 'file2.pdf', modified: 3 },
      { name: 'File1.pdf', modified: 9 },
      { name: 'old.pdf' },
    ];
    expect(sortSources(items, 'name').map((i) => i.name)).toEqual([
      'File1.pdf',
      'file2.pdf',
      'file10.pdf',
      'old.pdf',
    ]);
    expect(sortSources(items, 'date').map((i) => i.name)).toEqual([
      'old.pdf',
      'file2.pdf',
      'file10.pdf',
      'File1.pdf',
    ]);
    expect(sortSources([], 'name')).toEqual([]);
  });

  it('rejects an empty source list and disposes the output when a source fails midway', async () => {
    const s = await svc();
    expect(await codeOf(s.merge([]))).toBe('invalidArgument');
    const good = await fixture('text');
    const bad = await fixture('garbage');
    expect(
      await codeOf(
        s.merge([
          { name: 'a.pdf', bytes: good },
          { name: 'b.pdf', bytes: bad },
        ]),
      ),
    ).toBe('invalidPdf');
    expect(await codeOf(s.merge([{ name: 'a.pdf', bytes: good, range: '9' }]))).toBe('invalidArgument');
  });

  it('abort between sources cancels cleanly', async () => {
    const s = await svc();
    const ac = new AbortController();
    const bytes = await fixture('text');
    const run = s.merge(
      [
        { name: 'a.pdf', bytes },
        { name: 'b.pdf', bytes },
      ],
      {},
      ac.signal,
      () => ac.abort(),
    );
    expect(await codeOf(run)).toBe('cancelled');
  });

  it('flattens form fields of sources unless asked to keep them, and merges images with bookmarks', async () => {
    const s = await svc();
    const form = await fixture('acroform');
    const flat = await s.merge([{ name: 'f.pdf', bytes: form }], { keepFormFields: false });
    expect((await flat.getMeta()).hasAcroForm).toBe(false);
    flat.dispose();
    const kept = await s.merge([{ name: 'f.pdf', bytes: form }], { keepFormFields: true });
    expect((await kept.getMeta()).hasAcroForm).toBe(true);
    kept.dispose();
    const mixed = await s.merge(
      [
        { name: 'text.pdf', bytes: await fixture('text') },
        { name: 'photo.jpg', bytes: sampleJpeg(120, 80) },
      ],
      { bookmarks: true },
    );
    expect(mixed.pageCount).toBe(4);
    expect((await mixed.getOutline()).map((n) => [n.title, (n.target as { page: number }).page])).toEqual([
      ['text', 0],
      ['photo', 3],
    ]);
    mixed.dispose();
  });

  it('repeats and reorders pages through ranges and keeps outline targets inside the result', async () => {
    const s = await svc();
    const out = await s.merge([{ name: 'bm.pdf', bytes: await fixture('bookmarks'), range: '3,3,1' }]);
    expect(out.pageCount).toBe(3);
    const walk = (nodes: Awaited<ReturnType<PdfDocument['getOutline']>>): number[] =>
      nodes.flatMap((n) => {
        const target = n.target;
        return [...(target && target.kind === 'page' ? [target.page] : []), ...walk(n.children)];
      });
    expect(walk(await out.getOutline()).every((p) => p >= 0 && p < out.pageCount)).toBe(true);
    out.dispose();
  });

  it('inspects images, passwords, empty selections and bad ranges without throwing', async () => {
    const s = await svc();
    expect(await s.inspect({ name: 'x.png', bytes: new Uint8Array([1, 2, 3]) })).toMatchObject({
      kind: 'image',
      problem: 'invalid',
    });
    expect(await s.inspect({ name: 'p.jpg', bytes: sampleJpeg(10, 10) })).toMatchObject({
      kind: 'image',
      pageCount: 1,
    });
    expect(await s.inspect({ name: 't.pdf', bytes: await fixture('text'), range: '0' })).toMatchObject({
      problem: 'badRange',
      totalPages: 3,
    });
    expect(await s.inspect({ name: 'e.pdf', bytes: await fixture('encrypted') })).toMatchObject({
      problem: 'passwordRequired',
    });
    expect(await s.inspect({ name: 'g.pdf', bytes: new Uint8Array(0) })).toMatchObject({
      problem: 'invalid',
    });
  });
});

describe('RenderService queue and cache @NFR-02 @NFR-05', () => {
  it('serves repeats from cache, shares in-flight work and re-renders after invalidation', async () => {
    const { doc } = await openFixture('text');
    const r = new RenderService(doc);
    const [a, b] = await Promise.all([r.render({ page: 0, scale: 0.5 }), r.render({ page: 0, scale: 0.5 })]);
    expect(a).toBe(b);
    expect(r.cachedCount).toBe(1);
    expect(r.peek({ page: 0, scale: 0.5 })).toBe(a);
    expect(await r.render({ page: 0, scale: 0.5 })).toBe(a);
    r.invalidate([0]);
    expect(r.peek({ page: 0, scale: 0.5 })).toBeUndefined();
    expect(await r.render({ page: 0, scale: 0.5 })).not.toBe(a);
    doc.dispose();
  });

  it('keeps the cache within its byte budget, evicting the least recently used', async () => {
    const { doc } = await openFixture('text');
    const one = await new RenderService(doc).render({ page: 0, scale: 0.5 });
    const r = new RenderService(doc, { cacheBytes: one.data.byteLength * 2 + 10 });
    await r.render({ page: 0, scale: 0.5 });
    await r.render({ page: 1, scale: 0.5 });
    await r.render({ page: 0, scale: 0.5 }); // touch page 0 so page 1 is the oldest
    await r.render({ page: 2, scale: 0.5 });
    expect(r.cacheBytes).toBeLessThanOrEqual(one.data.byteLength * 2 + 10);
    expect(r.peek({ page: 1, scale: 0.5 })).toBeUndefined();
    expect(r.peek({ page: 0, scale: 0.5 })).toBeDefined();
    doc.dispose();
  });

  it('does not cache a bitmap bigger than the whole budget', async () => {
    const { doc } = await openFixture('text');
    const r = new RenderService(doc, { cacheBytes: 100 });
    const img = await r.render({ page: 0, scale: 1 });
    expect(img.data.byteLength).toBeGreaterThan(100);
    expect([r.cachedCount, r.cacheBytes]).toEqual([0, 0]);
    doc.dispose();
  });

  it('rejects requests that were aborted before and while queued', async () => {
    const { doc } = await openFixture('text');
    const r = new RenderService(doc);
    const pre = new AbortController();
    pre.abort();
    expect(await codeOf(r.render({ page: 0, scale: 1, signal: pre.signal }))).toBe('cancelled');
    const ac = new AbortController();
    const first = r.render({ page: 0, scale: 1 });
    const second = r.render({ page: 1, scale: 1, signal: ac.signal, priority: 'thumbnail' });
    ac.abort();
    await first;
    expect(await codeOf(second)).toBe('cancelled');
    doc.dispose();
  });

  it('thumbnails never exceed 200 px wide and respect page rotation', async () => {
    const { doc } = await openFixture('rotated-pages');
    const r = new RenderService(doc);
    for (let i = 0; i < doc.pageCount; i++) {
      const t = await r.thumbnail(i, 5000);
      expect(t.width).toBeLessThanOrEqual(201);
      const info = await doc.getPageInfo(i);
      const landscape =
        info.rotation % 180 === 0 ? info.size.width > info.size.height : info.size.height > info.size.width;
      expect(t.width > t.height).toBe(landscape);
    }
    doc.dispose();
  });
});

describe('RecoveryScheduler @FR-APP-06', () => {
  it('a pass is not overlapped by the next tick; one failing session does not stop the others', async () => {
    const storage = new MemoryStorage();
    const rec = new RecoveryService({ storage, clock: new FakeClock() });
    const { doc: a } = await openFixture('text');
    const { doc: b } = await openFixture('invoice');
    const errors: unknown[] = [];
    const broken = Object.assign(Object.create(b), {
      snapshot: async () => {
        throw new Error('snapshot failed');
      },
    }) as PdfDocument;
    const st = (sessionId: string, revision: number) => ({ sessionId, name: `${sessionId}.pdf`, revision });
    const sessions = [
      { doc: broken, dirty: true, state: st('s0', 1) },
      { doc: a, dirty: true, state: st('s1', 1) },
      { doc: a, dirty: false, state: st('s2', 1) },
    ];
    const sched = new RecoveryScheduler(
      rec,
      new ManualTicker(),
      () => sessions,
      (e) => errors.push(e),
    );
    const [first, overlapped] = await Promise.all([sched.tick(), sched.tick()]);
    expect([first, overlapped]).toEqual([1, 0]);
    expect(errors).toHaveLength(1);
    expect((await rec.pending()).map((p) => p.sessionId)).toEqual(['s1']);
    expect(await sched.tick()).toBe(0); // same revision: nothing new to write
    // The scheduler is usable again after the failure.
    sessions[1]!.state = st('s1', 2);
    expect(await sched.tick()).toBe(1);
    a.dispose();
    b.dispose();
  });
});
