import { describe, expect, it } from 'vitest';
import { applyToRect, pageToViewMatrix, rotatedSize } from '@folio/core';
import type { Rect } from '@folio/ports';
import { FakeAiProvider } from '@folio/ai';
import { NodeImageCodec, flatFormDoc, scannedFormDoc } from '@folio/testkit';
import { FieldDetectionService, FormAuthoringService } from './index.ts';
import { openFixture } from './testing.ts';

const svc = new FormAuthoringService();

describe('Form authoring @FR-FRM-08 @FR-FRM-11 @FR-FRM-16', () => {
  it('names fields from the nearest label or Text1, never twice @FR-FRM-08', () => {
    const taken = new Set(['Name', 'Text1']);
    expect(svc.autoName('text', 'Name:', taken)).toBe('Name_2');
    expect(svc.autoName('text', 'Date of birth', taken)).toBe('DateOfBirth');
    expect(svc.autoName('text', undefined, taken)).toBe('Text2');
    expect(svc.autoName('checkbox', undefined, taken)).toBe('Checkbox1');
    expect(svc.autoName('signature', '   ', new Set())).toBe('Signature1');
    expect(() => svc.validName('  ', taken)).toThrow();
    expect(() => svc.validName('a..b', taken)).toThrow();
    expect(() => svc.validName('Name', taken)).toThrow();
    expect(svc.validName('Name', taken, 'Name')).toBe('Name');
    expect(svc.validName(' person.first ', taken)).toBe('person.first');
  });

  it('a click makes a default-size field, a drag the dragged one, both inside the page @FR-FRM-08', () => {
    const page: Rect = { x: 0, y: 0, width: 612, height: 792 };
    expect(svc.rectFor('text', { x: 100, y: 100 }, null, page)).toEqual({ x: 20, y: 89, width: 160, height: 22 });
    expect(svc.rectFor('text', { x: 100, y: 100 }, { x: 102, y: 101 }, page).width).toBe(160);
    expect(svc.rectFor('text', { x: 300, y: 400 }, { x: 200, y: 360 }, page)).toEqual({ x: 200, y: 360, width: 100, height: 40 });
    expect(svc.rectFor('checkbox', { x: 2, y: 2 }, null, page)).toEqual({ x: 0, y: 0, width: 16, height: 16 });
    expect(svc.nudge({ x: 10, y: 10, width: 20, height: 20 }, 1, 0, false, page).x).toBe(11);
    expect(svc.nudge({ x: 10, y: 10, width: 20, height: 20 }, 0, -1, true, page).y).toBe(0);
    expect(svc.blocked({ hasXfa: true, isEncrypted: false })).toBe('xfa');
    expect(svc.blocked({ hasXfa: false, isEncrypted: false })).toBeNull();
  });

  it('create, edit, move and delete are single undoable steps; undo restores the exact state @FR-FRM-08 @FR-FRM-16', async () => {
    const { doc, history } = await openFixture('acroform');
    const names = async () => (await doc.listFormFields()).map((f) => f.name).sort();
    const start = await names();
    await history.execute(svc.create([svc.spec('text', 'extra', 0, { x: 300, y: 700, width: 100, height: 20 })]));
    expect(await names()).toEqual([...start, 'extra'].sort());
    const field = (await doc.listFormFields()).find((f) => f.name === 'extra')!;
    await history.execute(svc.update(field, { multiline: true, required: true }));
    await history.execute(svc.move(field, 0, { x: 310, y: 640, width: 120, height: 60 }));
    await history.execute(svc.rename(field, 'extra2', new Set(start)));
    const moved = (await doc.listFormFields()).find((f) => f.name === 'extra2')!;
    expect(moved).toMatchObject({ multiline: true, required: true });
    expect(moved.widgets[0]!.rect).toMatchObject({ x: 310, y: 640, width: 120, height: 60 });
    await history.execute(svc.remove(moved));
    expect(await names()).toEqual(start);
    for (let i = 0; i < 5; i++) expect(await history.undo()).toBe(true);
    expect(await names()).toEqual(start);
    expect(() => svc.rename(field, 'name', new Set(['name']))).toThrow();
    expect(svc.compatible(moved)).toEqual(['singleline']);
  });

  it('renaming a field inside a group checks the full name it will get @FR-FRM-11', () => {
    const field = { id: 'addr.city', name: 'addr.city' } as Parameters<FormAuthoringService['rename']>[0];
    const taken = new Set(['addr.city', 'addr.zip', 'zip2']);
    // "zip" becomes "addr.zip", which already exists.
    expect(() => svc.rename(field, 'zip', taken)).toThrow(/already exists/);
    // "zip2" becomes "addr.zip2", which is free although a top-level "zip2" exists.
    expect(() => svc.rename(field, 'zip2', taken)).not.toThrow();
    expect(() => svc.rename(field, 'city', taken)).not.toThrow();
    expect(() => svc.rename(field, 'a.b', taken)).toThrow();
  });
});

describe('Field detection @FR-FRM-15 @FR-FRM-07', () => {
  it('vector forms are detected locally, with no AI at all @FR-FRM-07', async () => {
    const { pdf } = await flatFormDoc();
    const { engine } = await openFixture('text');
    const doc = await engine.open(pdf);
    const ai = new FakeAiProvider();
    const out = await new FieldDetectionService({ ai, images: new NodeImageCodec() }).detect(doc, [0], { useAi: true });
    expect(out.usedAi).toBe(false);
    expect(ai.requests.length).toBe(0);
    expect(out.proposals.length).toBeGreaterThanOrEqual(5);
    expect(out.proposals.every((p) => p.source === 'local' && p.accepted)).toBe(true);
    expect(out.proposals.some((p) => p.type === 'checkbox')).toBe(true);
    expect(out.proposals.map((p) => p.id)).toEqual(out.proposals.map((_, k) => `p1-d${k + 1}`));
  });

  it('a scan needs AI; with a recorded answer the boxes land where they are, also rotated by 90° @FR-FRM-15', async () => {
    for (const rotate of [0, 90] as const) {
      const { pdf, areas } = await scannedFormDoc({ rotate });
      const { engine } = await openFixture('text');
      const doc = await engine.open(pdf);
      const info = await doc.getPageInfo(0);
      expect(info.rotation).toBe(rotate);
      // Without AI the shapes in the page image are proposed: the five boxes and two squares.
      const none = await new FieldDetectionService({}).detect(doc, [0], { useAi: false });
      expect(none).toMatchObject({ notice: 'scanLocal', usedAi: false });
      expect(none.proposals.length).toBe(7);
      for (const a of areas) {
        const p = none.proposals.find((x) => x.type === a.kind && Math.abs(x.rect.x - a.rect.x) < 2 && Math.abs(x.rect.y - a.rect.y) < 2)!;
        expect(p, `${a.label} @${rotate}`).toBeTruthy();
        expect(p.source).toBe('local');
        expect(Math.abs(p.rect.width - a.rect.width)).toBeLessThan(2);
        expect(Math.abs(p.rect.height - a.rect.height)).toBeLessThan(2);
      }

      // The model answers in fractions of the page image as shown (rotated).
      const shown = rotatedSize(info.size, info.rotation);
      const m = pageToViewMatrix(info.size, info.rotation, 1);
      const ai = new FakeAiProvider();
      ai.enqueue((req) => ({
        fields: [],
        newAreas: areas.map((a, k) => {
          const v = applyToRect(m, a.rect);
          return {
            page: req.pages[0]!.page,
            bbox: [v.x / shown.width, v.y / shown.height, (v.x + v.width) / shown.width, (v.y + v.height) / shown.height],
            label: a.label,
            fieldType: a.kind,
            profileKey: null,
            confidence: k === 4 ? 0.4 : 0.95,
          };
        }),
      }));
      const out = await new FieldDetectionService({ ai, images: new NodeImageCodec() }).detect(doc, [0], { useAi: true });
      expect(out.usedAi).toBe(true);
      expect(ai.requests.length).toBe(1);
      expect(ai.requests[0]!.profileKeys).toEqual([]);
      expect(out.proposals.length).toBe(7);
      for (const a of areas) {
        const p = out.proposals.find((x) => x.label === a.label)!;
        for (const key of ['x', 'y', 'width', 'height'] as const) expect(p.rect[key], `${a.label} ${key} @${rotate}`).toBeCloseTo(a.rect[key], 0);
        expect(p.type).toBe(a.kind);
        expect(p.source).toBe('ai');
      }
      // Low-confidence proposals start unticked; confidence never exceeds the 0.8 cap.
      expect(out.proposals.find((p) => p.label === 'Tax code')!.accepted).toBe(false);
      expect(Math.max(...out.proposals.map((p) => p.confidence))).toBeLessThanOrEqual(0.8);
    }
  });

  it('overlapping proposals are merged and AI failures fall back to a notice @FR-FRM-15', async () => {
    const svcD = new FieldDetectionService({});
    const base = { page: 0, type: 'text' as const, id: '', accepted: true };
    const merged = svcD.merge([
      { ...base, rect: { x: 10, y: 10, width: 100, height: 20 }, confidence: 0.8, source: 'local' },
      { ...base, rect: { x: 12, y: 11, width: 98, height: 20 }, confidence: 0.8, source: 'ai' },
      { ...base, rect: { x: 300, y: 300, width: 50, height: 20 }, confidence: 0.5, source: 'ai' },
    ]);
    // Reading order: the lower box (higher on the page) first.
    expect(merged.map((p) => [p.source, p.confidence])).toEqual([['ai', 0.5], ['local', 0.8]]);
    const { pdf } = await scannedFormDoc();
    const { engine } = await openFixture('text');
    const doc = await engine.open(pdf);
    const { AiError } = await import('@folio/core');
    const ai = new FakeAiProvider();
    ai.enqueue(new AiError('rateLimited'));
    const out = await new FieldDetectionService({ ai, images: new NodeImageCodec() }).detect(doc, [0], { useAi: true });
    expect(out).toMatchObject({ proposals: [], notice: 'aiFailed' });
  });
});
