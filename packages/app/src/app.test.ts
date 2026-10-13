import { describe, expect, it } from 'vitest';
import { FIXTURE_PASSWORD, fixture, pdfinfo, sharedEngine } from '@folio/testkit';
import { fuzzyScore } from './commands.ts';
import { RESERVED, chordOfEvent, formatChord, parseChord, sameChord } from './keymap.ts';
import { HOME_TILES, describeError } from './app.ts';
import { MODE_TOOLS } from './tools.ts';
import { createTestApp, markers, settle } from './testing.ts';
import { fitZoom, layoutPages, navigate, parsePageJump, renderWindow, sameSet, scrollTopFor, stepZoom, themeFilter, themeInvertsImages, visibleRange, wheelZoom } from './viewer.ts';
import { PasswordRequiredError, UnsupportedFeatureError } from '@folio/core';

const key = (k: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) => ({ key: k, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt });

describe('opening files', () => {
  it('opens from the dialog, a drop, a CLI argument or "Open with"; reopening activates the tab @FR-APP-01', async () => {
    const t = await createTestApp();
    await t.put('/docs/a.pdf', 'text');
    await t.put('/docs/b.pdf', 'invoice');
    t.files.nextOpen = [['/docs/a.pdf', '/docs/b.pdf']];
    const opened = await t.app.openDialog();
    expect(opened.map((s) => s.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(t.app.active!.name).toBe('b.pdf');
    expect(t.window.title).toBe('b.pdf — Folio');
    // The OS hands over a file while the app is running (second instance, file association, drop).
    await t.put('/downloads/c.pdf', 'bookmarks');
    t.files.emitExternalOpen(['/downloads/c.pdf', '/docs/a.pdf']);
    await settle();
    await settle();
    expect(t.app.sessions.map((s) => s.name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(t.app.active!.name).toBe('a.pdf');
    expect((await t.app.recentFiles()).map((r) => r.displayName).sort()).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    // Dropped images become a new, unsaved PDF.
    const { samplePng } = await import('@folio/testkit');
    t.files.put('/pics/one.png', samplePng());
    t.files.put('/pics/two.png', samplePng(50, 90));
    const [img] = await t.app.openRefs([t.files.ref('/pics/one.png'), t.files.ref('/pics/two.png')]);
    expect(img).toMatchObject({ name: 'one.pdf', pageCount: 2, dirty: true, ref: undefined });
  });

  it('asks for the password until it is right or the user gives up; never keeps it @FR-APP-12', async () => {
    const t = await createTestApp();
    await t.put('/docs/secret.pdf', 'encrypted');
    t.prompts.passwords = ['nope', 'still wrong', FIXTURE_PASSWORD];
    const s = await t.app.openRef(t.files.ref('/docs/secret.pdf'));
    expect(s!.meta.isEncrypted).toBe(true);
    expect(t.prompts.asked).toEqual(['password:secret.pdf:false', 'password:secret.pdf:true', 'password:secret.pdf:true']);
    expect(t.toastKeys()).toEqual([]);
    await t.app.closeTab(s!.id);
    t.prompts.passwords = [null];
    expect(await t.app.openRef(t.files.ref('/docs/secret.pdf'))).toBeNull();
    expect(t.app.sessions.length).toBe(0);
    expect(JSON.stringify(await t.db.select('SELECT * FROM recent_files'))).not.toContain(FIXTURE_PASSWORD);
    expect(JSON.stringify([...t.storage.items.keys()])).not.toContain(FIXTURE_PASSWORD);
  });

  it('opens damaged files with a banner and explains unreadable ones without raw errors @FR-APP-13', async () => {
    const t = await createTestApp();
    const s = await t.open('damaged');
    expect(s.meta.wasRepaired).toBe(true);
    expect(t.app.toasts[0]).toMatchObject({ kind: 'warning', message: { key: 'banner.repaired' } });
    await t.put('/docs/garbage.pdf', 'garbage');
    expect(await t.app.openRef(t.files.ref('/docs/garbage.pdf'))).toBeNull();
    const err = t.app.toasts.at(-1)!;
    expect(err).toMatchObject({ kind: 'error', message: { key: 'error.invalidPdf' } });
    expect(err.detail).toContain('InvalidPdfError');
    expect(await t.app.openRef(t.files.ref('/nowhere.pdf'))).toBeNull();
    expect(t.app.toasts.at(-1)!.message.key).toBe('error.io');
    expect(describeError(new PasswordRequiredError(true)).message.key).toBe('error.wrongPassword');
    expect(describeError(new UnsupportedFeatureError('scannedText')).message.key).toBe('error.unsupportedFeature.scannedText');
    expect(describeError(new TypeError('boom'))).toEqual({ message: { key: 'error.unexpected' }, detail: 'TypeError: boom' });
  });
});

describe('tabs and close guard', () => {
  it('keeps several documents in tabs: activate, reorder, cycle, unsaved dot, close @FR-APP-02', async () => {
    const t = await createTestApp();
    const a = await t.open('text', '/a.pdf');
    const b = await t.open('invoice', '/b.pdf');
    const c = await t.open('bookmarks', '/c.pdf');
    expect(t.app.sessions.map((s) => s.title)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    t.app.moveTab(c.id, 0);
    expect(t.app.sessions.map((s) => s.name)).toEqual(['c.pdf', 'a.pdf', 'b.pdf']);
    t.app.activate(a.id);
    t.app.cycleTab(1);
    expect(t.app.active).toBe(b);
    t.app.cycleTab(1);
    expect(t.app.active).toBe(c);
    t.app.cycleTab(-1);
    expect(t.app.active).toBe(b);
    expect([a.dirty, b.dirty]).toEqual([false, false]);
    await t.organise(b).rotate(90, 0);
    expect(b.dirty).toBe(true);
    expect(t.window.dirty).toBe(true);
    await b.undo();
    expect(b.dirty).toBe(false);
    // Middle-click on a clean tab closes it at once; the neighbour becomes active.
    expect(await t.app.closeTab(b.id)).toBe(true);
    expect(t.app.sessions.map((s) => s.name)).toEqual(['c.pdf', 'a.pdf']);
    expect(t.app.active).toBe(a);
    await t.app.closeTab(a.id);
    await t.app.closeTab(c.id);
    expect(t.app.active).toBeNull();
    expect(t.window.title).toBe('Folio');
    t.app.activate('missing');
    expect(t.app.activeId).toBeNull();
  });

  it('guards dirty documents on tab close and window close: Save / Don\'t save / Cancel @FR-APP-07', async () => {
    const t = await createTestApp();
    const a = await t.open('text', '/a.pdf');
    const b = await t.open('invoice', '/b.pdf');
    await t.organise(a).delete(0);
    await t.organise(b).rotate(90, 0);
    t.prompts.closeAnswers = ['cancel'];
    expect(await t.app.closeTab(a.id)).toBe(false);
    expect(t.app.sessions.length).toBe(2);
    t.prompts.closeAnswers = ['save'];
    expect(await t.app.closeTab(a.id)).toBe(true);
    await expect(t.files.get('/a.pdf')!).toHavePageCount(2);
    // Window close asks for each dirty tab; one Cancel keeps the window open.
    t.prompts.closeAnswers = ['cancel'];
    expect(await t.window.requestClose()).toBe(false);
    expect(t.app.sessions.length).toBe(1);
    t.prompts.closeAnswers = ['discard'];
    const original = Buffer.from(t.files.get('/b.pdf')!).toString('base64');
    expect(await t.window.requestClose()).toBe(true);
    expect(t.app.sessions.length).toBe(0);
    expect(Buffer.from(t.files.get('/b.pdf')!).toString('base64')).toBe(original);
    expect(t.prompts.asked.filter((x) => x.startsWith('close:'))).toEqual(['close:a.pdf', 'close:a.pdf', 'close:b.pdf', 'close:b.pdf']);
    // A failed save does not close the tab.
    const c = await t.open('text', '/c.pdf');
    await t.organise(c).rotate(90, 0);
    t.files.failWrites = true;
    t.prompts.closeAnswers = ['save'];
    expect(await t.app.closeTab(c.id)).toBe(false);
    expect(t.app.toasts.at(-1)!.message.key).toBe('error.io');
  });
});

describe('saving', () => {
  it('Save writes atomically with a backup; Save As and Export a copy behave differently @FR-APP-04', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/docs/a.pdf');
    await t.organise(s).rotate(90, 0);
    expect(await t.app.save()).toBe(true);
    expect(t.files.writes.at(-1)).toEqual({ path: '/docs/a.pdf', atomic: true, backup: true });
    expect(t.files.get('/docs/a.pdf.bak')).toBeDefined();
    expect(s.dirty).toBe(false);
    expect(t.toastKeys()).toContain('toast.saved');
    await t.app.setSetting('keepBackup', false);
    await t.organise(s).rotate(90, 0);
    await t.app.save();
    expect(t.files.writes.at(-1)!.backup).toBe(false);
    // Export a copy leaves the document and its dirty state alone.
    await t.organise(s).rotate(90, 0);
    t.files.nextSave = ['/docs/a copy.pdf'];
    expect(await t.app.exportCopy()).toBe(true);
    expect([s.dirty, s.name, s.ref!.path]).toEqual([true, 'a.pdf', '/docs/a.pdf']);
    t.files.nextSave = ['/elsewhere/renamed.pdf'];
    expect(await t.app.saveAs()).toBe(true);
    expect([s.dirty, s.name, s.ref!.path, t.window.title]).toEqual([false, 'renamed.pdf', '/elsewhere/renamed.pdf', 'renamed.pdf — Folio']);
    t.files.nextSave = [null];
    expect(await t.app.saveAs()).toBe(false);
    // A new, never-saved document goes through Save As.
    const engine = await sharedEngine();
    const mem = await t.app.adopt(await engine.open(await fixture('invoice')), 'Untitled.pdf');
    t.files.nextSave = ['/docs/new.pdf'];
    expect(await t.app.save(mem)).toBe(true);
    expect(mem.ref!.path).toBe('/docs/new.pdf');
    await expect(t.files.get('/docs/new.pdf')!).toBeValidPdf();
  });

  it('warns before saving a signed file and offers incremental save @FR-APP-11', async () => {
    const t = await createTestApp();
    const original = await fixture('signed');
    const s = await t.open('signed', '/s.pdf');
    await t.tools(s).setTool('note');
    await t.tools(s).pointerDown(0, { x: 300, y: 600 });
    t.prompts.signedAnswers = ['cancel'];
    expect(await t.app.save()).toBe(false);
    expect(s.dirty).toBe(true);
    t.prompts.signedAnswers = ['incremental'];
    expect(await t.app.save()).toBe(true);
    const saved = t.files.get('/s.pdf')!;
    expect(Buffer.from(saved.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
    expect(t.prompts.asked.filter((a) => a === 'signed:s.pdf').length).toBe(2);
  });

  it('can flatten stamps when saving (setting) @FR-STM-08', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    t.sign.placeDate(t.tools(s));
    await t.tools(s).pointerMove(0, { x: 300, y: 300 });
    await t.tools(s).pointerDown(0, { x: 300, y: 300 });
    expect((await s.doc.listAnnotations(0)).map((a) => a.type)).toEqual(['stamp']);
    await t.app.setSetting('flattenStampsOnSave', true);
    await t.app.save();
    expect(await s.doc.listAnnotations(0)).toEqual([]);
  });
});

describe('undo history', () => {
  it('lists every step and can jump to any point @FR-APP-05', async () => {
    const t = await createTestApp();
    const s = await t.open('text-25', '/a.pdf');
    const org = t.organise(s);
    org.click(0);
    await org.delete();
    await settle();
    org.click(1);
    await org.duplicate();
    await settle();
    org.click(0);
    await org.rotate(90);
    expect(s.historyState.done.map((d) => d.label.key)).toEqual(['cmd.deletePages', 'cmd.duplicatePages', 'cmd.rotatePages']);
    expect((await markers(s)).slice(0, 4)).toEqual([2, 3, 3, 4]);
    await s.history.goTo(1);
    expect((await markers(s)).slice(0, 3)).toEqual([2, 3, 4]);
    expect(s.historyState.undone.map((d) => d.label.key)).toEqual(['cmd.duplicatePages', 'cmd.rotatePages']);
    await s.history.goTo(3);
    expect((await s.doc.getPageInfo(0)).rotation).toBe(90);
    await s.history.goTo(0);
    expect(s.dirty).toBe(false);
    expect(await markers(s)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(t.app.toasts.find((x) => x.message.key === 'toast.pagesDeleted')!.action!.label.key).toBe('action.undo');
  });
});

describe('auto-recovery', () => {
  it('snapshots dirty documents on the timer and offers to restore them after a crash @FR-APP-06', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/docs/a.pdf');
    expect(t.ticker.intervals).toEqual([30_000]);
    expect(await t.app.snapshotNow()).toBe(0);
    await t.organise(s).delete(0);
    await settle();
    s.goToPage(1);
    expect(await t.app.snapshotNow()).toBe(1);
    expect((await t.storage.list('recovery/')).length).toBe(2);
    // Crash: a new process starts with the same disk, database and app storage.
    const next = await createTestApp({ from: t });
    expect(next.prompts.asked).toEqual(['recovery:a.pdf']);
    const restored = next.app.active!;
    expect(restored).toMatchObject({ name: 'a.pdf', dirty: true, pageCount: 2 });
    expect(restored.ref!.path).toBe('/docs/a.pdf');
    expect(restored.view.page).toBe(1);
    expect(await markers(restored)).toEqual([2, 3]);
    expect(await next.storage.list('recovery/')).toEqual([]);
    await expect(next.files.get('/docs/a.pdf')!).toHavePageCount(3);
    // Saving or declining clears snapshots; the interval follows the setting.
    await next.app.setSetting('recoveryIntervalSec', 10);
    expect(next.ticker.intervals).toEqual([10_000]);
    await next.organise(restored).rotate(90, 0);
    await next.app.snapshotNow();
    await next.app.save();
    expect(await next.storage.list('recovery/')).toEqual([]);
    await next.organise(restored).rotate(90, 0);
    await next.app.snapshotNow();
    const declined = await createTestApp({ from: next });
    declined.prompts.recover = 'none';
    expect(declined.app.sessions.length).toBe(1);
    const third = await createTestApp({ from: next });
    expect(third.app.sessions.length).toBe(0);
  });
});

describe('home screen', () => {
  it('offers six task tiles and recent files with search, missing-file state and removal @FR-APP-03', async () => {
    const t = await createTestApp();
    expect(HOME_TILES).toEqual(['merge', 'split', 'organise', 'fill', 'sign', 'images']);
    t.clock.set(new Date(2026, 9, 11, 9));
    expect(t.app.greeting()).toBe('home.goodMorning');
    t.clock.set(new Date(2026, 9, 11, 15));
    expect(t.app.greeting()).toBe('home.goodAfternoon');
    t.clock.set(new Date(2026, 9, 11, 21));
    expect(t.app.greeting()).toBe('home.goodEvening');
    const a = await t.open('invoice', '/work/invoices/inv.pdf');
    await settle();
    t.clock.advance(1000);
    await t.open('text', '/home/notes.pdf');
    await settle();
    await t.app.closeTab(a.id);
    t.app.showHome();
    const exists = async (p: string) => t.files.get(p) !== undefined;
    let cards = await t.app.recentFiles('', exists);
    expect(cards.map((c) => [c.displayName, c.folder, c.pageCount, c.missing])).toEqual([['notes.pdf', '/home', 3, false], ['inv.pdf', '/work/invoices', 1, false]]);
    expect(cards[1]!.thumbnail![1]).toBe(0x50);
    expect((await t.app.recentFiles('invoices', exists)).map((c) => c.displayName)).toEqual(['inv.pdf']);
    t.files.files.delete('/work/invoices/inv.pdf');
    cards = await t.app.recentFiles('', exists);
    expect(cards[1]!.missing).toBe(true);
    expect(await t.app.openRecent(cards[1]!)).toBeNull();
    expect(t.toastKeys().at(-1)).toBe('home.fileNotFound');
    await t.app.revealRecent(cards[0]!);
    expect(t.files.revealed).toEqual(['/home/notes.pdf']);
    await t.app.removeRecent(cards[1]!.id);
    expect((await t.app.recentFiles()).length).toBe(1);
    // Tiles: wizards open directly; the others ask for a file first and start the right mode.
    expect(await t.app.startTile('merge')).toBe('wizard');
    expect(await t.app.startTile('images')).toBe('wizard');
    await t.app.closeTab(t.app.sessions[0]!.id);
    t.files.nextOpen = [[]];
    expect(await t.app.startTile('organise')).toBe('cancelled');
    t.files.nextOpen = [['/home/notes.pdf']];
    expect(await t.app.startTile('organise')).toBe('opened');
    expect(t.app.active!.mode).toBe('organise');
    expect(await t.app.startTile('sign')).toBe('opened');
    expect([t.app.active!.mode, t.app.pendingIntent]).toEqual(['fill', 'sign']);
  });

  it('remembers the last page and zoom of a file @FR-VIEW-08', async () => {
    const t = await createTestApp();
    const s = await t.open('text-25', '/a.pdf');
    s.goToPage(11);
    s.setZoom('custom', 1.5);
    await t.app.closeTab(s.id);
    const again = await t.app.openRef(t.files.ref('/a.pdf'));
    expect(again!.view).toMatchObject({ page: 11, zoomMode: 'custom', zoom: 1.5 });
    again!.goToPage(999);
    expect(again!.view.page).toBe(24);
  });
});

describe('viewer', () => {
  it('computes fit zooms, steps and wheel zoom within 10 %–800 % @FR-VIEW-01', () => {
    const page = { width: 612, height: 792 };
    const vp = { width: 1272, height: 900 };
    expect(fitZoom(page, vp, 'fit-width', 'continuous')).toBeCloseTo(2, 5);
    expect(fitZoom(page, vp, 'fit-page', 'continuous')).toBeCloseTo(852 / 792, 5);
    expect(fitZoom(page, vp, 'fit-width', 'two-page')).toBeCloseTo((1272 - 48 - 12) / 1224, 5);
    expect(fitZoom(page, vp, 'actual', 'continuous')).toBe(1);
    expect(fitZoom(page, vp, 'custom', 'continuous', 99)).toBe(8);
    expect(fitZoom(page, { width: 10, height: 10 }, 'fit-width', 'continuous')).toBeGreaterThanOrEqual(0.1);
    expect([stepZoom(1, 1), stepZoom(1, -1), stepZoom(8, 1), stepZoom(0.1, -1), stepZoom(1.3, 1)]).toEqual([1.1, 0.9, 8, 0.1, 1.5]);
    expect(wheelZoom(1, -100)).toBeGreaterThan(1);
    expect(wheelZoom(1, 100)).toBeLessThan(1);
    expect(wheelZoom(7.9, -10000)).toBe(8);
    expect(wheelZoom(0.11, 10000)).toBe(0.1);
  });
  it('lays out continuous, single and two-page views and finds the visible pages @FR-VIEW-01', () => {
    const sizes = Array.from({ length: 5 }, (_, i) => ({ size: { width: 600, height: 800 }, rotation: (i === 1 ? 90 : 0) as 0 | 90 }));
    const cont = layoutPages(sizes, 0.5, 'continuous');
    expect(cont.boxes[0]).toEqual({ index: 0, x: 74, y: 24, width: 300, height: 400 });
    expect(cont.boxes[1]).toMatchObject({ x: 24, y: 436, width: 400, height: 300 });
    expect(cont.width).toBe(448);
    expect(cont.height).toBe(24 + 400 + 12 + 300 + 12 + 3 * 400 + 2 * 12 + 24);
    const two = layoutPages(sizes, 0.5, 'two-page');
    expect(two.boxes.map((b) => Math.round(b.y))).toEqual([24, 486, 436, 848, 848]);
    expect(two.boxes[3]!.x + two.boxes[3]!.width + 12).toBeCloseTo(two.boxes[4]!.x, 5);
    expect(layoutPages(sizes, 0.5, 'continuous', 90).boxes[0]).toMatchObject({ width: 400, height: 300 });
    const v = visibleRange(cont.boxes, 500, 600);
    expect(v).toMatchObject({ visible: [1, 2], current: 2 });
    expect(v.mounted).toEqual([0, 1, 2, 3, 4]);
    expect(visibleRange(cont.boxes, 0, 100, 0)).toMatchObject({ visible: [0], mounted: [0], current: 0 });
    expect(scrollTopFor(cont.boxes, 2)).toBe(748 - 12);
    expect(layoutPages([], 1, 'continuous').height).toBe(48);
  });
  it('navigates with the keyboard and the page box @FR-VIEW-08', () => {
    expect(navigate('PageDown', 3, 10, 'continuous')).toBe(4);
    expect(navigate('Space', 9, 10, 'continuous')).toBe(9);
    expect(navigate('PageUp', 0, 10, 'continuous')).toBe(0);
    expect(navigate('ShiftSpace', 5, 10, 'two-page')).toBe(3);
    expect([navigate('Home', 5, 10, 'single'), navigate('End', 5, 10, 'single')]).toEqual([0, 9]);
    expect([parsePageJump(' 7 ', 10), parsePageJump('0', 10), parsePageJump('11', 10), parsePageJump('x', 10), parsePageJump('2.5', 10)]).toEqual([6, null, null, null, null]);
  });
  it('rotates the view without touching the file until "Apply rotation to file" @FR-VIEW-06', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    s.rotateView(90);
    s.rotateView(90);
    expect(s.view.rotation).toBe(180);
    expect(s.dirty).toBe(false);
    expect((await s.doc.getPageInfo(0)).rotation).toBe(0);
    expect(t.registry.isEnabled('view.applyRotation', t.ctx())).toBe(true);
    expect(await s.applyViewRotation()).toBe(true);
    expect([s.view.rotation, s.dirty, (await s.doc.getPageInfo(2)).rotation]).toEqual([0, true, 180]);
    await s.undo();
    expect((await s.doc.getPageInfo(0)).rotation).toBe(0);
    expect(await s.applyViewRotation()).toBe(false);
  });
  it('offers reading modes: dark page, sepia and high contrast @FR-VIEW-07', async () => {
    const t = await createTestApp();
    const s = await t.open('images', '/a.pdf');
    expect(s.view.theme).toBe('normal');
    expect(themeFilter('normal')).toBe('none');
    await t.registry.run('view.themeDark', t.ctx());
    expect(s.view.theme).toBe('dark');
    expect(themeFilter(s.view.theme)).toBe('invert(0.9) hue-rotate(180deg)');
    // Images keep their colours in dark mode: the UI re-inverts these regions.
    expect(themeInvertsImages('dark')).toBe(true);
    expect((await t.services.objects.imagesOn(s.doc, 0)).length).toBe(2);
    expect(themeFilter('sepia')).toContain('sepia');
    expect(themeFilter('high-contrast')).toContain('contrast');
    expect([themeInvertsImages('sepia'), themeInvertsImages('high-contrast')]).toEqual([false, false]);
    expect(s.dirty).toBe(false);
    await t.app.setSetting('pageTheme', 'sepia');
    expect((await t.open('text', '/b.pdf')).view.theme).toBe('sepia');
  });
  it('fit width follows the widest page, so no page overflows and zoom does not change while scrolling @FR-VIEW-01', async () => {
    const t = await createTestApp();
    const s = await t.open('mixed-sizes', '/m.pdf');
    const widths = s.pageInfos.map((p) => p.size.width);
    expect(new Set(widths).size).toBeGreaterThan(1);
    s.fit({ width: 1272, height: 900 });
    const widest = Math.max(...widths);
    expect(s.view.zoom).toBeCloseTo((1272 - 48) / widest, 3);
    const zoom = s.view.zoom;
    s.goToPage(s.pageInfos.findIndex((p) => p.size.width === Math.min(...widths)));
    s.fit({ width: 1272, height: 900 });
    expect(s.view.zoom).toBeCloseTo(zoom, 5);
  });
  it('scroll-reported pages update the indicator without a full refresh, except in fit-page @FR-VIEW-08', async () => {
    const t = await createTestApp();
    const s = await t.open('mixed-sizes', '/m.pdf');
    let changed = 0;
    let paged = 0;
    s.changed.on(() => changed++);
    s.pageChanged.on(() => paged++);
    s.reportPage(2);
    expect(s.view.page).toBe(2);
    expect({ changed, paged }).toEqual({ changed: 0, paged: 1 });
    s.reportPage(2);
    expect(paged).toBe(1);
    s.goToPage(3);
    expect({ changed, paged }).toEqual({ changed: 1, paged: 2 });
    s.setZoom('fit-page');
    changed = 0;
    s.reportPage(1);
    expect({ changed, paged }).toEqual({ changed: 1, paged: 3 });
  });
  it('mounts pages within a viewport of the view and keeps them until three away @FR-VIEW-01', () => {
    const sizes = Array.from({ length: 12 }, () => ({ size: { width: 600, height: 800 }, rotation: 0 as const }));
    const { boxes } = layoutPages(sizes, 1, 'continuous');
    const top = renderWindow(boxes, 0, 800);
    expect([...top.inView]).toEqual([0]);
    expect([...top.near]).toEqual([0, 1]);
    // Scrolling down a few pages: earlier pages stay mounted until they are far away.
    const mid = renderWindow(boxes, 6 * 812, 800, top.mounted);
    expect(mid.inView.has(6)).toBe(true);
    expect(mid.mounted.has(0)).toBe(false);
    expect(mid.mounted.has(7)).toBe(true);
    // Scrolling back up a little keeps the pages below, which are still within three viewports.
    const back = renderWindow(boxes, 5 * 812, 800, mid.mounted);
    expect(back.mounted.has(7)).toBe(true);
    expect(sameSet(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameSet(new Set([1]), new Set([1, 2]))).toBe(false);
    expect(renderWindow(boxes, 0, 800, new Set([0, 1, 2, 3, 4, 5])).mounted.has(5)).toBe(false);
  });
  it('fits the zoom to the viewport and switches layouts @FR-VIEW-01', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    expect(s.view).toMatchObject({ zoomMode: 'fit-width', layout: 'continuous' });
    s.fit({ width: 1272, height: 900 });
    expect(s.view.zoom).toBeCloseTo(2, 5);
    await t.registry.run('view.fitPage', t.ctx());
    s.fit({ width: 1272, height: 900 });
    expect(s.view.zoom).toBeCloseTo(852 / 792, 5);
    await t.registry.run('view.zoomIn', t.ctx());
    expect(s.view).toMatchObject({ zoomMode: 'custom', zoom: 1.1 });
    await t.registry.run('view.actualSize', t.ctx());
    expect(s.view.zoom).toBe(1);
    await t.registry.run('view.twoPage', t.ctx());
    expect(s.view.layout).toBe('two-page');
    await t.registry.run('view.nextPage', t.ctx());
    expect(s.view.page).toBe(2);
  });
  it('searches with a live result list, options and next/previous @FR-VIEW-04', async () => {
    const t = await createTestApp();
    const s = await t.open('text-25', '/a.pdf');
    const find = t.find(s);
    await t.registry.run('edit.find', t.ctx());
    expect(find.open).toBe(true);
    s.goToPage(4);
    await find.setQuery('marker');
    expect(find.position).toEqual({ index: 5, total: 25 });
    expect(find.hitsOnPage(4)).toMatchObject([{ active: true, snippet: { match: 'marker' } }]);
    find.step(1);
    expect([find.position.index, s.view.page]).toEqual([6, 5]);
    find.step(-1);
    find.step(-1);
    expect(s.view.page).toBe(3);
    find.select(24);
    find.step(1);
    expect(find.position.index).toBe(1);
    await find.setOptions({ matchCase: true });
    expect(find.position.total).toBe(25);
    await find.setQuery('MARKER');
    expect(find.position).toEqual({ index: 0, total: 0 });
    await find.setOptions({ matchCase: false, wholeWord: true });
    expect(find.position.total).toBe(25);
    await find.setQuery('mark');
    expect(find.position.total).toBe(0);
    await find.setQuery('twenty-five');
    expect(find.position.total).toBe(25);
    // Results follow edits.
    await t.organise(s).delete(0);
    await settle();
    await settle();
    expect(find.position.total).toBe(24);
    await t.registry.run('edit.cancel', t.ctx());
    expect([find.open, find.hits.length]).toEqual([false, 0]);
  });
  it('shows outline, annotations, attachments and search results in the sidebar; follows links safely @FR-VIEW-02 @FR-VIEW-05', async () => {
    const t = await createTestApp();
    const s = await t.open('bookmarks', '/b.pdf');
    expect(s.sidebarTab).toBe('thumbnails');
    s.setSidebarTab('outline');
    const items = s.nav.flatten(await s.nav.outline());
    await t.app.followLink(items[2]!.target);
    expect(s.view.page).toBe(3);
    const att = await t.open('attachment', '/att.pdf');
    att.setSidebarTab('attachments');
    expect(await att.doc.listAttachments()).toEqual([{ index: 0, name: 'data.txt', size: 16 }]);
    const l = await t.open('links', '/l.pdf');
    const links = await l.nav.links(0);
    const web = links.find((x) => x.target.kind === 'uri')!;
    t.prompts.linkAnswers = [false, true];
    await t.app.followLink(web.target);
    expect(t.shell.opened).toEqual([]);
    await t.app.followLink(web.target);
    expect(t.shell.opened).toEqual(['https://example.com/docs?a=1']);
    expect(t.prompts.asked.filter((a) => a === 'link:example.com').length).toBe(2);
    for (const bad of links.filter((x) => x.target.kind === 'unsupported')) await t.app.followLink(bad.target);
    expect(t.shell.opened.length).toBe(1);
    expect(t.toastKeys().filter((k) => k === 'link.blocked').length).toBe(3);
    t.ui.toggleSidebar();
    t.ui.toggleInspector();
    expect([t.ui.sidebarOpen, t.ui.inspectorOpen]).toEqual([false, false]);
  });
  it('shows an identical notice once and can dismiss them all @FR-APP-01', async () => {
    const t = await createTestApp();
    t.app.toast('warning', { key: 'images.notAnImage', params: { name: 'a.txt' } });
    t.app.toast('warning', { key: 'images.notAnImage', params: { name: 'a.txt' } });
    t.app.toast('warning', { key: 'images.notAnImage', params: { name: 'b.txt' } });
    expect(t.app.toasts.length).toBe(2);
    const progress = t.app.toast('info', { key: 'cmd.save' }, { progress: 0.2 });
    t.app.dismissAllToasts();
    expect(t.app.toasts.map((x) => x.id)).toEqual([progress]);
  });
  it('prints a page range with copies through the OS dialog @FR-VIEW-09', async () => {
    const t = await createTestApp();
    const s = await t.open('text-25', '/a.pdf');
    expect(await t.app.print({ pages: [0, 4, 5], copies: 2, scale: 'actual' })).toBe(true);
    // The print frame cannot set copies, so the pages are repeated in the document that is handed over.
    expect(t.printing.jobs[0]!.opts).toEqual({ copies: 1, scale: 'actual' });
    await expect(t.printing.jobs[0]!.pdf).toHavePageCount(6);
    expect(await t.app.print()).toBe(true);
    expect(t.printing.jobs[1]!.opts).toEqual({ copies: 1, scale: 'fit' });
    await expect(t.printing.jobs[1]!.pdf).toHavePageCount(25);
    expect(await t.app.print({ pages: [99] })).toBe(false);
    expect(t.toastKeys().at(-1)).toBe('error.invalidArgument.printRange');
    expect(s.dirty).toBe(false);
    await t.registry.run('file.print', t.ctx());
    expect(t.ui.dialog).toBe('print');
    void pdfinfo;
  });
});

describe('command palette and shortcuts', () => {
  it('parses and formats chords with the Mod abstraction (§7.6)', () => {
    expect(parseChord('Mod+Shift+S')).toEqual({ key: 's', mod: true, shift: true, alt: false });
    expect(parseChord('Del').key).toBe('Delete');
    expect(parseChord('Mod+=').key).toBe('=');
    expect(parseChord('F4')).toMatchObject({ key: 'F4', mod: false });
    expect(sameChord(parseChord('Mod+S'), chordOfEvent(key('s', { ctrl: true }), false))).toBe(true);
    expect(sameChord(parseChord('Mod+S'), chordOfEvent(key('s', { meta: true }), true))).toBe(true);
    expect(sameChord(parseChord('Mod+S'), chordOfEvent(key('s', { ctrl: true }), true))).toBe(false);
    expect(sameChord(parseChord('Mod+S'), chordOfEvent(key('S', { ctrl: true, shift: true }), false))).toBe(false);
    expect(sameChord(parseChord('Mod+='), chordOfEvent(key('=', { ctrl: true, shift: true }), false))).toBe(true);
    expect([formatChord('Mod+Shift+S', false), formatChord('Mod+Shift+S', true), formatChord('Del', false), formatChord('Mod+K', true)]).toEqual(['Ctrl+Shift+S', '⌘⇧S', 'Del', '⌘K']);
  });

  it('searches every action, tool and setting; unavailable ones are hidden @FR-APP-09', async () => {
    const t = await createTestApp();
    const tr = (k: string) => ({ 'cmd.merge': 'Merge PDFs', 'cmd.settings': 'Settings', 'tool.highlight': 'Highlight', 'cmd.save': 'Save', 'cmd.rotateCw': 'Rotate pages clockwise', 'cmd.sign': 'Sign', 'cmd.palette': 'Command palette' })[k] ?? k;
    const titles = (q: string) => t.registry.search(q, t.ctx(), tr).map((i) => i.title);
    // Home screen: document commands are not offered.
    expect(titles('save')).toEqual([]);
    expect(titles('merge')[0]).toBe('Merge PDFs');
    expect(titles('prefer')[0]).toBe('Settings');
    expect(titles('ai key')[0]).toBe('Settings');
    const s = await t.open('text', '/a.pdf');
    expect(titles('save')[0]).toBe('Save');
    expect(titles('hilit')[0]).toBe('Highlight');
    expect(titles('marker')[0]).toBe('Highlight');
    expect(titles('rotate')).not.toContain('Rotate pages clockwise');
    s.setMode('organise');
    t.organise(s).click(0);
    expect(titles('rotate')).toContain('Rotate pages clockwise');
    expect(titles('').length).toBeGreaterThan(40);
    expect(titles('zzzz')).toEqual([]);
    expect(fuzzyScore('sv', 'Save')).toBeGreaterThan(0);
    expect(fuzzyScore('vs', 'Save')).toBe(0);
    expect(fuzzyScore('rot', 'Document properties')).toBe(0);
    expect(fuzzyScore('ps', 'Open pages')).toBeGreaterThan(0);
    expect(fuzzyScore('sm', 'Split and merge')).toBeGreaterThan(0);
    expect(fuzzyScore('sig', 'Sign')).toBeGreaterThan(fuzzyScore('sig', 'Split and merge'));
    // Every command has a title key and an id; ids are unique (register throws otherwise).
    expect(t.registry.all().every((c) => c.title && c.id)).toBe(true);
    await t.registry.run('view.palette', t.ctx());
    expect(t.ui.palette).toBe(true);
    t.ui.openDialog('settings');
    expect([t.ui.palette, t.ui.dialog]).toEqual([false, 'settings']);
  });

  it('runs the default shortcuts of Appendix A; tool keys are ignored while typing', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    const press = async (k: string, mods = {}, typing = false) => {
      const cmd = t.registry.match(key(k, mods), t.ctx(), { isMac: false, typing });
      if (cmd) await cmd.run(t.ctx());
      return cmd?.id;
    };
    expect(await press('h')).toBe('tool.highlight');
    expect([s.mode, t.tools(s).tool]).toEqual(['annotate', 'highlight']);
    expect(await press('e')).toBe('tool.edit-text');
    expect(s.mode).toBe('edit');
    expect(await press('n')).toBe('tool.note');
    expect(await press('t')).toBe('tool.textbox');
    expect(await press('s')).toBe('tool.rect');
    expect(await press('v')).toBe('tool.select');
    expect(await press('h', {}, true)).toBeUndefined();
    expect(await press('k', { ctrl: true }, true)).toBe('view.palette');
    expect(await press('o', { ctrl: true, shift: true })).toBe('mode.organise');
    expect(s.mode).toBe('organise');
    expect(await press('r')).toBeUndefined();
    t.organise(s).click(1);
    expect(await press('r')).toBe('pages.rotateCw');
    await settle();
    expect(await press('R', { shift: true })).toBe('pages.rotateCcw');
    await settle();
    expect(await press('d', { ctrl: true })).toBe('pages.duplicate');
    await settle();
    expect(s.pageCount).toBe(4);
    expect(await press('a', { ctrl: true })).toBe('edit.selectAll');
    expect(t.organise(s).selected.length).toBe(4);
    expect(await press('z', { ctrl: true })).toBe('edit.undo');
    await settle();
    expect(s.pageCount).toBe(3);
    expect(await press('z', { ctrl: true, shift: true })).toBe('edit.redo');
    expect(await press('F4')).toBe('view.sidebar');
    expect(await press('F5')).toBe('view.inspector');
    expect(await press('=', { ctrl: true })).toBe('view.zoomIn');
    expect(await press('-', { ctrl: true })).toBe('view.zoomOut');
    expect(await press('0', { ctrl: true })).toBe('view.fitWidth');
    expect(await press('1', { ctrl: true })).toBe('view.actualSize');
    expect(await press('f', { ctrl: true })).toBe('edit.find');
    expect(await press('p', { ctrl: true })).toBe('file.print');
    expect(await press('Escape')).toBe('edit.cancel');
    // No command claims a shortcut the OS or browser owns.
    expect(t.registry.conflicts(RESERVED).filter((c) => c.includes('reserved'))).toEqual([]);
    for (const mode of Object.keys(MODE_TOOLS)) expect(MODE_TOOLS[mode as keyof typeof MODE_TOOLS]).toContain('select');
  });
});

describe('settings', () => {
  it('changes settings, persists them across restarts and resets to defaults @FR-APP-10', async () => {
    const t = await createTestApp();
    await t.app.setSetting('theme', 'dark');
    await t.app.setSetting('units', 'in');
    await t.app.setSetting('defaultZoom', 125);
    await t.app.setSetting('authorName', 'M. Esempio');
    await t.app.setSetting('ai', { ...t.app.settings.ai, enabled: true, model: 'local-model', baseUrl: 'http://localhost:11434/v1' });
    const next = await createTestApp({ from: t });
    expect(next.app.settings).toMatchObject({ theme: 'dark', units: 'in', defaultZoom: 125, ai: { enabled: true, model: 'local-model' } });
    const s = await next.open('text', '/a.pdf');
    expect(s.view).toMatchObject({ zoomMode: 'custom', zoom: 1.25 });
    await next.registry.run('view.theme', next.ctx());
    expect(next.app.settings.theme).toBe('light');
    await next.app.resetSettings();
    expect(next.app.settings).toMatchObject({ theme: 'system', units: 'mm', defaultZoom: 'fit-width' });
  });

  it('uses the configured author name for annotations, the OS user name by default @FR-ANN-08', async () => {
    const t = await createTestApp({ userName: 'luca' });
    const s = await t.open('text', '/a.pdf');
    const tools = t.tools(s);
    tools.setTool('note', { sticky: true });
    await tools.pointerDown(0, { x: 100, y: 600 });
    await t.app.setSetting('authorName', 'Luca Prova');
    await tools.pointerDown(0, { x: 200, y: 600 });
    expect((await s.doc.listAnnotations(0)).map((a) => a.author)).toEqual(['luca', 'Luca Prova']);
  });
});
