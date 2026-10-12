// Application-model edge cases: what happens when saving fails, the user backs out, or inputs are odd.
import { describe, expect, it } from 'vitest';
import { FolioError } from '@folio/core';
import { ManualTicker, sampleJpeg, samplePng } from '@folio/testkit';
import { AppModel } from './app.ts';
import { createTestApp, settle } from './testing.ts';

describe('tabs @FR-APP-02', () => {
  it('moveTab clamps the target, ignores unknown ids; activate ignores unknown ids; cycle wraps both ways', async () => {
    const t = await createTestApp();
    expect(() => t.app.cycleTab(1)).not.toThrow(); // no tabs
    const a = await t.open('text', '/a.pdf');
    const b = await t.open('invoice', '/b.pdf');
    const c = await t.open('bookmarks', '/c.pdf');
    const order = () => t.app.sessions.map((s) => s.name);
    t.app.moveTab(c.id, -5);
    expect(order()).toEqual(['c.pdf', 'a.pdf', 'b.pdf']);
    t.app.moveTab(c.id, 99);
    expect(order()).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    t.app.moveTab('ghost', 0);
    expect(order()).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    t.app.activate('ghost');
    expect(t.app.active).toBe(c);
    t.app.cycleTab(1);
    expect(t.app.active).toBe(a);
    t.app.cycleTab(-1);
    expect(t.app.active).toBe(c);
    t.app.activate(b.id);
    expect(t.window.title).toBe('b.pdf — Folio');
    t.app.showHome();
    expect(t.window.title).toBe('Folio');
  });

  it('closing the active tab activates its right neighbour, or the left one at the end', async () => {
    const t = await createTestApp();
    const a = await t.open('text', '/a.pdf');
    const b = await t.open('invoice', '/b.pdf');
    const c = await t.open('bookmarks', '/c.pdf');
    t.app.activate(b.id);
    await t.app.closeTab(b.id);
    expect(t.app.active).toBe(c);
    await t.app.closeTab(c.id);
    expect(t.app.active).toBe(a);
    expect(await t.app.closeTab('ghost')).toBe(true);
    await t.app.closeTab(a.id);
    expect(t.app.active).toBeNull();
  });

  it('the window shows a dirty marker while any tab has unsaved changes', async () => {
    const t = await createTestApp();
    const a = await t.open('text', '/a.pdf');
    await t.open('invoice', '/b.pdf');
    expect(t.window.dirty).toBe(false);
    await t.organise(a).rotate(90, 0);
    expect(t.window.dirty).toBe(true);
    await t.app.save(a);
    expect(t.window.dirty).toBe(false);
  });
});

describe('saving failures @FR-APP-04', () => {
  it('a failed save keeps the document dirty, keeps the recovery snapshot and explains why', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    await t.organise(s).rotate(90, 0);
    expect(await t.app.snapshotNow()).toBe(1);
    const snapshots = (await t.storage.list('recovery/')).length;
    expect(snapshots).toBeGreaterThan(0);
    t.files.failWrites = true;
    expect(await t.app.save()).toBe(false);
    expect(s.dirty).toBe(true);
    expect((await t.storage.list('recovery/')).length).toBe(snapshots);
    expect(t.app.toasts.at(-1)).toMatchObject({ kind: 'error', message: { key: 'error.io' } });
    t.files.failWrites = false;
    expect(await t.app.save()).toBe(true);
    expect(await t.storage.list('recovery/')).toEqual([]);
  });

  it('exportCopy that fails reports and leaves the document alone; a cancelled picker is silent', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    await t.organise(s).rotate(90, 0);
    t.files.nextSave = [null];
    const toasts = t.app.toasts.length;
    expect(await t.app.exportCopy()).toBe(false);
    expect(t.app.toasts.length).toBe(toasts);
    t.files.failWrites = true;
    t.files.nextSave = ['/x.pdf'];
    expect(await t.app.exportCopy()).toBe(false);
    expect(t.app.toasts.at(-1)!.kind).toBe('error');
    expect(s.dirty).toBe(true);
  });

  it('save and print on the home screen do nothing', async () => {
    const t = await createTestApp();
    expect(await t.app.save()).toBe(false);
    expect(await t.app.saveAs()).toBe(false);
    expect(await t.app.exportCopy()).toBe(false);
    expect(await t.app.print()).toBe(false);
    expect(t.app.toasts).toEqual([]);
  });
});

describe('toasts @FR-APP-05', () => {
  it('can be updated, dismissed, and an undo toast reverts the active document', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    const id = t.app.toast('info', { key: 'toast.exported', params: { name: 'a' } }, { progress: 0.1 });
    t.app.updateToast(id, { progress: 0.9 });
    expect(t.app.toasts.find((x) => x.id === id)!.progress).toBe(0.9);
    t.app.dismissToast(id);
    t.app.dismissToast(id); // idempotent
    expect(t.app.toasts.find((x) => x.id === id)).toBeUndefined();

    await t.organise(s).delete(0);
    expect(s.pageCount).toBe(2);
    t.app.toastUndo({ key: 'toast.pagesDeleted', params: { count: 1 } });
    t.app.toasts.at(-1)!.action!.run();
    await settle();
    expect(s.pageCount).toBe(3);
  });

  it('cancelled operations are never shown as errors and raw error text never reaches a toast', async () => {
    const t = await createTestApp();
    t.app.reportError(new FolioError('cancelled', 'cancelled'));
    expect(t.app.toasts).toEqual([]);
    t.app.reportError(new Error('ENOENT: /secret/path/to/file'));
    const last = t.app.toasts.at(-1)!;
    expect(last.kind).toBe('error');
    expect(JSON.stringify(last.message)).not.toContain('/secret/path');
  });
});

describe('opening @FR-APP-01 @FR-APP-13', () => {
  it('opens images as one new unsaved PDF named after the first image', async () => {
    const t = await createTestApp();
    t.files.put('/pics/trip.jpg', sampleJpeg(200, 100));
    t.files.put('/pics/map.png', samplePng(50, 50));
    const [s] = await t.app.openRefs([t.files.ref('/pics/trip.jpg'), t.files.ref('/pics/map.png')]);
    expect([s!.name, s!.pageCount, s!.dirty, s!.ref]).toEqual(['trip.pdf', 2, true, undefined]);
  });

  it('a mix of good, missing and broken files opens the good ones and reports the rest', async () => {
    const t = await createTestApp();
    await t.put('/ok.pdf', 'text');
    await t.put('/bad.pdf', 'garbage');
    const opened = await t.app.openRefs([
      t.files.ref('/ok.pdf'),
      t.files.ref('/missing.pdf'),
      t.files.ref('/bad.pdf'),
    ]);
    expect(opened.map((s) => s.name)).toEqual(['ok.pdf']);
    expect(t.app.toasts.filter((x) => x.kind === 'error')).toHaveLength(2);
  });

  it('reopening a file restores its last page; a recent whose file is gone only warns', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    s.goToPage(2);
    await t.app.closeTab(s.id);
    const again = await t.app.openRef(t.files.ref('/a.pdf'));
    expect(again!.view.page).toBe(2);
    const [card] = await t.app.recentFiles('', async () => false);
    expect(card!.missing).toBe(true);
    const before = t.app.sessions.length;
    expect(await t.app.openRecent(card!)).toBeNull();
    expect(t.app.sessions.length).toBe(before);
    expect(t.app.toasts.at(-1)).toMatchObject({ kind: 'warning', message: { key: 'home.fileNotFound' } });
    await t.app.removeRecent(card!.id);
    expect(await t.app.recentFiles()).toEqual([]);
  });

  it('gives up silently when the password prompt is dismissed', async () => {
    const t = await createTestApp();
    await t.put('/enc.pdf', 'encrypted');
    t.prompts.passwords = [null];
    expect(await t.app.openRef(t.files.ref('/enc.pdf'))).toBeNull();
    expect(t.app.sessions).toHaveLength(0);
    expect(t.app.toasts).toEqual([]);
  });
});

describe('tiles @FR-APP-03', () => {
  it('merge and images tiles need no document; others ask for one and stop when the picker is cancelled', async () => {
    const t = await createTestApp();
    expect(await t.app.startTile('merge')).toBe('wizard');
    expect(await t.app.startTile('images')).toBe('wizard');
    t.files.nextOpen = [[]];
    expect(await t.app.startTile('organise')).toBe('cancelled');
    expect(await t.app.startTile('split')).toBe('cancelled');
    await t.put('/a.pdf', 'text');
    t.files.nextOpen = [['/a.pdf']];
    expect(await t.app.startTile('sign')).toBe('opened');
    expect(t.app.active!.mode).toBe('fill');
    expect(await t.app.startTile('organise')).toBe('opened');
    expect(t.app.active!.mode).toBe('organise');
  });
});

describe('recovery on start-up @FR-APP-06', () => {
  const leaveSnapshot = async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    await t.organise(s).rotate(90, 0);
    expect(await t.app.snapshotNow()).toBe(1);
    return t;
  };

  it('start() does not wait for the recovery prompt: the shell can only show it once it is running', async () => {
    const t = await leaveSnapshot();
    let asked = 0;
    const hanging = Object.create(t.prompts, {
      offerRecovery: {
        value: () => {
          asked++;
          return new Promise<string[]>(() => undefined);
        },
      },
    });
    const app = new AppModel(t.services, hanging, new ManualTicker());
    const outcome = await Promise.race([
      app.start().then(() => 'started'),
      new Promise((r) => setTimeout(() => r('hung'), 1000)),
    ]);
    expect(outcome).toBe('started');
    expect(asked).toBe(0); // nothing is asked until the shell calls offerRecovery()
    void app.offerRecovery();
    await settle();
    expect(asked).toBe(1);
    await app.stop();
  });

  it('restores leftover work as a dirty tab and clears the snapshot', async () => {
    const t = await leaveSnapshot();
    const next = await createTestApp({ from: t }); // a new run of the app over the same storage
    expect(next.prompts.asked.some((a) => a.startsWith('recovery:'))).toBe(true);
    expect(next.app.sessions.map((s) => [s.name, s.dirty])).toEqual([['a.pdf', true]]);
    expect((await next.app.sessions[0]!.doc.getPageInfo(0)).rotation).toBe(90);
    expect(await t.storage.list('recovery/')).toEqual([]);
  });

  it('declining discards the snapshots and opens nothing', async () => {
    const t2 = await leaveSnapshot();
    t2.prompts.recover = 'none';
    await t2.app.stop();
    expect((await t2.storage.list('recovery/')).length).toBeGreaterThan(0);
    t2.prompts.asked.length = 0;
    await t2.app.start();
    await t2.app.offerRecovery();
    expect(t2.prompts.asked.some((a) => a.startsWith('recovery:'))).toBe(true);
    expect(t2.app.sessions).toHaveLength(0);
    expect(await t2.storage.list('recovery/')).toEqual([]);
  });

  it('a corrupt snapshot is reported, dropped, and does not block start-up', async () => {
    const t = await leaveSnapshot();
    for (const k of await t.storage.list('recovery/'))
      if (k.endsWith('.pdf')) await t.storage.write(k, new Uint8Array([1, 2, 3]));
    const next = await createTestApp({ from: t });
    expect(next.app.sessions).toHaveLength(0);
    expect(next.app.toasts.some((x) => x.kind === 'error')).toBe(true);
    expect(await t.storage.list('recovery/')).toEqual([]);
  });

  it('stop releases hooks: a window close request no longer reaches the app', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    await t.organise(s).rotate(90, 0);
    await t.app.stop();
    expect(t.app.sessions).toHaveLength(0);
    t.prompts.closeAnswers = ['cancel'];
    expect(await t.window.requestClose()).toBe(true); // nothing is guarding the window any more
  });
});

describe('print @FR-VIEW-09', () => {
  it('rejects empty and out-of-range selections and clamps copies', async () => {
    const t = await createTestApp();
    await t.open('text', '/a.pdf');
    expect(await t.app.print({ pages: [] })).toBe(false);
    expect(await t.app.print({ pages: [-1] })).toBe(false);
    expect(t.app.toasts.at(-1)!.kind).toBe('error');
    expect(await t.app.print({ copies: 0 })).toBe(true);
    expect(await t.app.print({ copies: 2.6 })).toBe(true);
    await expect(t.printing.jobs[0]!.pdf).toHavePageCount(3);
    await expect(t.printing.jobs[1]!.pdf).toHavePageCount(9);
    expect(await t.app.print({ copies: 500 })).toBe(true);
    await expect(t.printing.jobs[2]!.pdf).toHavePageCount(3 * 99);
  });
});
