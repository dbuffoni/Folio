// Every default command executed through the registry: menus, the palette and shortcuts all call
// `run`, so a command whose closure was never executed is a command nobody has seen work (FR-APP-09).
import { describe, expect, it } from 'vitest';
import { createTestApp, settle, waitFor } from './testing.ts';

describe('registry hygiene @FR-APP-09', () => {
  it('has unique ids, translated titles and no two commands on one shortcut', async () => {
    const t = await createTestApp();
    const all = t.registry.all();
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(all.every((c) => /^[a-z]+\.[A-Za-z0-9-]+$/.test(c.id))).toBe(true);
    expect(t.registry.conflicts()).toEqual([]);
    expect(() => t.registry.register(all[0]!)).toThrow(/Duplicate command id/);
  });

  it('every title key exists in the English message catalogue', async () => {
    const t = await createTestApp();
    const { readFileSync } = await import('node:fs');
    const en = JSON.parse(
      readFileSync(new URL('../../../apps/web/src/lib/i18n/messages/en.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    const missing = t.registry
      .all()
      .map((c) => c.title)
      .filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });

  it('run() on an unknown or unavailable command does nothing', async () => {
    const t = await createTestApp();
    expect(await t.registry.run('nope.nothing', t.ctx())).toBe(false);
    expect(await t.registry.run('file.save', t.ctx())).toBe(false); // home screen: no document
    expect(t.registry.isEnabled('file.save', t.ctx())).toBe(false);
    expect(t.registry.isEnabled('file.open', t.ctx())).toBe(true);
  });

  it('without a document only global and document-free commands are available', async () => {
    const t = await createTestApp();
    const ids = new Set(t.registry.available(t.ctx()).map((c) => c.id));
    for (const id of [
      'file.open',
      'task.merge',
      'task.images',
      'view.palette',
      'settings.open',
      'help.about',
      'sign.create',
    ])
      expect(ids.has(id), id).toBe(true);
    for (const id of ['file.save', 'edit.undo', 'pages.rotateCw', 'tool.highlight', 'view.zoomIn'])
      expect(ids.has(id), id).toBe(false);
  });
});

describe('file commands @FR-APP-01 @FR-APP-04 @FR-APP-07', () => {
  it('open uses the picker; save writes the active file; saveAs and exportCopy write elsewhere', async () => {
    const t = await createTestApp();
    await t.put('/in/a.pdf', 'text');
    t.files.nextOpen = [['/in/a.pdf']];
    await t.registry.run('file.open', t.ctx());
    await waitFor(() => t.app.active !== null); // the command starts the open without awaiting it
    await settle();
    const s = t.app.active!;
    expect(s.name).toBe('a.pdf');
    await t.registry.run('pages.rotateCw', t.ctx()); // not available outside Organise with a selection
    expect(s.dirty).toBe(false);
    s.setMode('organise');
    t.organise(s).click(0);
    await t.registry.run('pages.rotateCw', t.ctx());
    await settle();
    expect(s.dirty).toBe(true);
    await t.registry.run('file.save', t.ctx());
    await settle();
    expect(s.dirty).toBe(false);
    expect(t.files.writes.at(-1)).toMatchObject({ path: '/in/a.pdf', atomic: true });

    t.files.nextSave = ['/out/b.pdf'];
    await t.registry.run('file.saveAs', t.ctx());
    await settle();
    expect(t.files.get('/out/b.pdf')).toBeDefined();
    expect(t.app.active!.name).toBe('b.pdf');

    t.files.nextSave = ['/out/copy.pdf'];
    await t.registry.run('file.exportCopy', t.ctx());
    await settle();
    expect(t.files.get('/out/copy.pdf')).toBeDefined();
    expect(t.app.active!.name).toBe('b.pdf'); // a copy does not rename the tab
  });

  it('close tab asks when dirty; home returns to the tile screen', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    s.setMode('organise');
    t.organise(s).click(0);
    await t.registry.run('pages.rotateCw', t.ctx());
    await settle();
    t.prompts.closeAnswers = ['cancel'];
    await t.registry.run('file.close', t.ctx());
    await settle();
    expect(t.app.sessions).toContain(s);
    t.prompts.closeAnswers = ['discard'];
    await t.registry.run('file.close', t.ctx());
    await settle();
    expect(t.app.sessions).toHaveLength(0);
    await t.open('text', '/b.pdf');
    await t.registry.run('file.home', t.ctx());
    expect(t.app.active).toBeNull();
    expect(t.app.sessions).toHaveLength(1); // the tab stays open behind the home screen
  });

  it('dialogs: print, properties, metadata, merge, split, images, export images, history, settings, profiles, help', async () => {
    const t = await createTestApp();
    await t.open('text', '/a.pdf');
    const expected: Array<[string, string]> = [
      ['file.print', 'print'],
      ['file.properties', 'properties'],
      ['file.metadata', 'metadata'],
      ['task.merge', 'merge'],
      ['task.split', 'split'],
      ['task.images', 'images'],
      ['export.images', 'exportImages'],
      ['edit.history', 'history'],
      ['settings.open', 'settings'],
      ['settings.profiles', 'profiles'],
      ['sign.stamps', 'stampEditor'],
      ['sign.digital', 'digitalSign'],
      ['sign.verify', 'signatures'],
      ['help.shortcuts', 'shortcuts'],
      ['help.privacy', 'privacy'],
      ['help.about', 'about'],
    ];
    for (const [id, dialog] of expected) {
      await t.registry.run(id, t.ctx());
      expect(t.ui.dialog, id).toBe(dialog);
      t.ui.closeDialog();
    }
  });
});

describe('view commands @FR-VIEW-01 @FR-VIEW-06 @FR-VIEW-07', () => {
  it('zoom, fit, layout, theme and rotation commands change the view state', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    const z0 = s.view.zoom;
    await t.registry.run('view.zoomIn', t.ctx());
    expect(s.view.zoom).toBeGreaterThan(z0);
    await t.registry.run('view.zoomOut', t.ctx());
    await t.registry.run('view.zoomOut', t.ctx());
    expect(s.view.zoom).toBeLessThan(z0);
    await t.registry.run('view.actualSize', t.ctx());
    expect([s.view.zoomMode, s.view.zoom]).toEqual(['actual', 1]);
    await t.registry.run('view.fitPage', t.ctx());
    expect(s.view.zoomMode).toBe('fit-page');
    await t.registry.run('view.fitWidth', t.ctx());
    expect(s.view.zoomMode).toBe('fit-width');

    for (const [id, layout] of [
      ['view.single', 'single'],
      ['view.twoPage', 'two-page'],
      ['view.continuous', 'continuous'],
    ] as const) {
      await t.registry.run(id, t.ctx());
      expect(s.view.layout).toBe(layout);
    }
    for (const [id, theme] of [
      ['view.themeDark', 'dark'],
      ['view.themeSepia', 'sepia'],
      ['view.themeContrast', 'high-contrast'],
      ['view.themeNormal', 'normal'],
    ] as const) {
      await t.registry.run(id, t.ctx());
      expect(s.view.theme).toBe(theme);
    }

    expect(t.registry.isEnabled('view.applyRotation', t.ctx())).toBe(false);
    await t.registry.run('view.rotate', t.ctx());
    expect(s.view.rotation).toBe(90);
    expect(t.registry.isEnabled('view.applyRotation', t.ctx())).toBe(true);
    expect(s.dirty).toBe(false);
    await t.registry.run('view.applyRotation', t.ctx());
    await settle();
    expect(s.view.rotation).toBe(0);
    expect(s.dirty).toBe(true);
    expect((await s.doc.getPageInfo(0)).rotation).toBe(90);
  });

  it('page navigation commands stop at the first and last page', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf'); // 3 pages
    await t.registry.run('view.lastPage', t.ctx());
    expect(s.view.page).toBe(2);
    await t.registry.run('view.nextPage', t.ctx());
    expect(s.view.page).toBe(2);
    await t.registry.run('view.prevPage', t.ctx());
    expect(s.view.page).toBe(1);
    await t.registry.run('view.firstPage', t.ctx());
    await t.registry.run('view.prevPage', t.ctx());
    expect(s.view.page).toBe(0);
  });

  it('the theme toggle flips the app setting and persists it', async () => {
    const t = await createTestApp();
    const before = t.app.settings.theme;
    await t.registry.run('view.theme', t.ctx());
    expect(t.app.settings.theme).toBe(before === 'dark' ? 'light' : 'dark');
    await t.registry.run('view.theme', t.ctx());
    expect(t.app.settings.theme).toBe(before === 'dark' ? 'dark' : 'light');
  });

  it('sidebar and inspector toggles flip the panels', async () => {
    const t = await createTestApp();
    await t.open('text', '/a.pdf');
    expect([t.ui.sidebarOpen, t.ui.inspectorOpen]).toEqual([true, true]);
    await t.registry.run('view.sidebar', t.ctx());
    await t.registry.run('view.inspector', t.ctx());
    expect([t.ui.sidebarOpen, t.ui.inspectorOpen]).toEqual([false, false]);
  });
});

describe('edit commands @FR-APP-05 @FR-ORG-01', () => {
  it('undo and redo are only offered when there is something to undo or redo', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    expect([t.registry.isEnabled('edit.undo', t.ctx()), t.registry.isEnabled('edit.redo', t.ctx())]).toEqual([
      false,
      false,
    ]);
    s.setMode('organise');
    t.organise(s).click(0);
    await t.registry.run('pages.duplicate', t.ctx());
    await settle();
    expect(s.pageCount).toBe(4);
    expect(t.registry.isEnabled('edit.undo', t.ctx())).toBe(true);
    await t.registry.run('edit.undo', t.ctx());
    await settle();
    expect([s.pageCount, t.registry.isEnabled('edit.redo', t.ctx())]).toEqual([3, true]);
    await t.registry.run('edit.redo', t.ctx());
    await settle();
    expect(s.pageCount).toBe(4);
  });

  it('delete removes the selected pages and select commands pick odd, even, all and none', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    s.setMode('organise');
    const org = t.organise(s);
    await t.registry.run('pages.selectOdd', t.ctx());
    expect(org.selected).toEqual([0, 2]);
    await t.registry.run('pages.selectEven', t.ctx());
    expect(org.selected).toEqual([1]);
    await t.registry.run('edit.selectAll', t.ctx());
    expect(org.selected).toEqual([0, 1, 2]);
    await t.registry.run('pages.selectNone', t.ctx());
    expect(org.selected).toEqual([]);
    expect(t.registry.isEnabled('edit.delete', t.ctx())).toBe(false);
    await t.registry.run('pages.selectEven', t.ctx());
    await t.registry.run('edit.delete', t.ctx());
    await settle();
    expect(s.pageCount).toBe(2);
  });

  it('rotate, duplicate and move commands act on the page selection', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    s.setMode('organise');
    const org = t.organise(s);
    org.click(0);
    await t.registry.run('pages.rotateCw', t.ctx());
    await t.registry.run('pages.rotateCcw', t.ctx());
    await t.registry.run('pages.rotate180', t.ctx());
    await settle();
    expect((await s.doc.getPageInfo(0)).rotation).toBe(180);
    await t.registry.run('pages.moveDown', t.ctx());
    await settle();
    expect(org.selected).toEqual([1]);
    await t.registry.run('pages.moveUp', t.ctx());
    await settle();
    expect(org.selected).toEqual([0]);
    await t.registry.run('pages.extract', t.ctx());
    await settle();
    expect(t.app.sessions).toHaveLength(2);
  });

  it('insert blank opens its dialog, insert-from-file and replace use the picker', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    await t.put('/ins.pdf', 'invoice');
    s.setMode('organise');
    const org = t.organise(s);
    org.click(0);
    await t.registry.run('pages.insertBlank', t.ctx());
    expect(t.ui.dialog).toBe('insertBlank');
    t.ui.closeDialog();
    t.files.nextOpen = [['/ins.pdf']];
    await t.registry.run('pages.insertFile', t.ctx());
    await settle();
    expect(s.pageCount).toBe(4);
    org.click(0);
    t.files.nextOpen = [['/ins.pdf']];
    await t.registry.run('pages.replace', t.ctx());
    await settle();
    expect(s.pageCount).toBe(4);
  });

  it('escape closes the find bar first, then cancels the active tool', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    await t.registry.run('edit.find', t.ctx());
    expect(t.find(s).open).toBe(true);
    await t.registry.run('tool.highlight', t.ctx());
    await t.registry.run('edit.cancel', t.ctx());
    expect(t.find(s).open).toBe(false);
    expect(t.tools(s).tool).toBe('highlight');
    await t.registry.run('edit.cancel', t.ctx());
    expect(t.tools(s).tool).toBe('select');
  });
});

describe('mode and tool commands @FR-APP-09', () => {
  it('every mode command switches the mode', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    for (const m of ['annotate', 'fill', 'edit', 'organise', 'view'] as const) {
      await t.registry.run(`mode.${m}`, t.ctx());
      expect(s.mode).toBe(m);
    }
  });

  it('every tool command selects its tool and moves to the mode that owns it', async () => {
    const t = await createTestApp();
    const s = await t.open('text', '/a.pdf');
    const owner: Record<string, string> = {
      'edit-text': 'edit',
      'add-text': 'edit',
      whiteout: 'edit',
      highlight: 'annotate',
      underline: 'annotate',
      strikeout: 'annotate',
      squiggly: 'annotate',
      note: 'annotate',
      textbox: 'annotate',
      rect: 'annotate',
      ellipse: 'annotate',
      line: 'annotate',
      arrow: 'annotate',
      polyline: 'annotate',
      'cover-type': 'fill',
      check: 'fill',
      cross: 'fill',
      snapshot: 'view',
      table: 'view',
    };
    const tools = t.registry.all().filter((c) => c.group === 'tool' && c.id !== 'tool.select');
    expect(tools.map((c) => c.id.slice(5)).sort()).toEqual(Object.keys(owner).sort());
    for (const c of tools) {
      const id = c.id.slice('tool.'.length);
      s.setMode('view');
      await t.registry.run(c.id, t.ctx());
      expect([t.tools(s).tool, s.mode], c.id).toEqual([id, owner[id]]);
    }
  });
});

describe('sign commands @FR-STM-01 @FR-STM-05', () => {
  it('create signature opens the dialog without a document; date places a text stamp', async () => {
    const t = await createTestApp();
    await t.registry.run('sign.create', t.ctx());
    expect([t.ui.dialog, t.sign.creating]).toEqual(['signature', 'signature']);
    t.ui.closeDialog();
    const s = await t.open('invoice', '/a.pdf');
    await t.registry.run('sign.date', t.ctx());
    await settle();
    expect(s.mode).toBe('fill');
  });

  it('initials open the creation dialog when none is stored', async () => {
    const t = await createTestApp();
    await t.open('invoice', '/a.pdf');
    await t.registry.run('sign.initials', t.ctx());
    expect([t.sign.creating, t.ui.dialog]).toEqual(['initials', 'signature']);
  });
});

describe('export commands @FR-OPT-04', () => {
  it('flatten asks first and does nothing when declined', async () => {
    const t = await createTestApp();
    const s = await t.open('acroform', '/f.pdf');
    t.prompts.confirmAnswers = [false];
    await t.registry.run('export.flatten', t.ctx());
    await settle();
    expect(t.prompts.asked.at(-1)).toBe('confirm:confirm.flatten');
    expect(s.dirty).toBe(false);
    t.prompts.confirmAnswers = [true];
    await t.registry.run('export.flatten', t.ctx());
    await settle();
    expect(s.dirty).toBe(true);
    expect((await s.fields()).length).toBe(0);
  });

  it('flatten annotations only keeps form fields', async () => {
    const t = await createTestApp();
    const s = await t.open('acroform', '/f.pdf');
    const before = (await s.fields()).length;
    expect(before).toBeGreaterThan(0);
    t.prompts.confirmAnswers = [true];
    await t.registry.run('export.flattenAnnotations', t.ctx());
    await settle();
    expect((await s.fields()).length).toBe(before);
  });

  it('flattened copy writes a new file and leaves the open document untouched', async () => {
    const t = await createTestApp();
    const s = await t.open('acroform', '/f.pdf');
    t.files.nextSave = ['/out/f (flattened).pdf'];
    await t.registry.run('export.flattenedCopy', t.ctx());
    await settle();
    await expect(t.files.get('/out/f (flattened).pdf')!).toBeValidPdf();
    expect(s.dirty).toBe(false);
    expect((await s.fields()).length).toBeGreaterThan(0);
  });

  it('a cancelled save picker writes nothing', async () => {
    const t = await createTestApp();
    await t.open('acroform', '/f.pdf');
    const writes = t.files.writes.length;
    t.files.nextSave = [null];
    await t.registry.run('export.flattenedCopy', t.ctx());
    await settle();
    expect(t.files.writes.length).toBe(writes);
  });
});
