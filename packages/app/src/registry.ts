import type { AppModel } from './app.ts';
import { CommandRegistry, type AppCommand, type PermissionKey } from './commands.ts';
import type { SignModel } from './features.ts';
import { MODES, type DocumentSession, type Mode } from './session.ts';
import type { ToolController, ToolId } from './tools.ts';
import type { FindModel, UiState } from './ui.ts';
import { navigate, stepZoom } from './viewer.ts';

/** What commands can reach. `session`, `tools` and `find` are null on the home screen. */
export interface CommandContext {
  app: AppModel;
  ui: UiState;
  sign: SignModel;
  session: DocumentSession | null;
  tools: ToolController | null;
  find: FindModel | null;
  /** Organise actions of the active session, provided by the shell. */
  organise: import('./features.ts').OrganiseModel | null;
}
type C = AppCommand<CommandContext>;
const doc = (ctx: CommandContext): boolean => ctx.session !== null;
const inMode = (...modes: Mode[]) => (ctx: CommandContext): boolean => ctx.session !== null && modes.includes(ctx.session.mode);
const hasPages = (ctx: CommandContext): boolean => ctx.session?.mode === 'organise' && ctx.session.selection.kind === 'pages';

const NEEDS_BY_MODE: Partial<Record<Mode, PermissionKey>> = { edit: 'modify', annotate: 'annotate', fill: 'annotate' };
const tool = (id: ToolId, title: string, icon: string, shortcut: string | undefined, mode: Mode, keywords = ''): C => ({
  needs: id === 'snapshot' ? 'copy' : id === 'select' ? undefined : NEEDS_BY_MODE[mode],
  id: `tool.${id}`,
  title,
  group: 'tool',
  icon,
  shortcut,
  keywords,
  when: doc,
  run: ({ session, tools }) => {
    // Tool shortcuts work from every mode: switch to the mode that owns the tool (SPEC §7.2).
    if (id !== 'select' && session!.mode !== mode) session!.setMode(mode);
    tools!.setTool(id);
  },
});

/** Default commands and shortcuts (Appendix A). One list feeds menus, tooltips, shortcuts and the palette. */
export function createRegistry(): CommandRegistry<CommandContext> {
  const r = new CommandRegistry<CommandContext>((needs, ctx) => ctx.session?.denial(needs));
  r.register(
    // File
    { id: 'file.open', title: 'cmd.open', group: 'file', icon: 'folder-open', shortcut: 'Mod+O', global: true, run: ({ app }) => void app.openDialog() },
    { id: 'file.save', title: 'cmd.save', group: 'file', icon: 'save', shortcut: 'Mod+S', global: true, when: doc, run: ({ app }) => void app.save() },
    { id: 'file.saveAs', title: 'cmd.saveAs', group: 'file', icon: 'save-all', shortcut: 'Mod+Shift+S', global: true, when: doc, run: ({ app }) => void app.saveAs() },
    { id: 'file.exportCopy', title: 'cmd.exportCopy', group: 'file', icon: 'copy', when: doc, run: ({ app }) => void app.exportCopy() },
    { id: 'file.close', title: 'cmd.closeTab', group: 'file', icon: 'x', shortcut: 'Mod+W', global: true, when: doc, run: ({ app, session }) => void app.closeTab(session!.id) },
    { id: 'file.print', needs: 'print', title: 'cmd.print', group: 'file', icon: 'printer', shortcut: 'Mod+P', global: true, when: doc, run: ({ ui }) => ui.openDialog('print') },
    { id: 'file.properties', title: 'cmd.properties', group: 'file', icon: 'info', when: doc, keywords: 'document info fonts size', run: ({ ui }) => ui.openDialog('properties') },
    { id: 'file.metadata', needs: 'modify', title: 'cmd.metadata', group: 'file', icon: 'tags', when: doc, keywords: 'title author subject keywords', run: ({ ui }) => ui.openDialog('metadata') },
    { id: 'file.hiddenData', needs: 'modify', title: 'cmd.hiddenData', group: 'file', icon: 'eraser', when: doc, keywords: 'remove metadata xmp javascript attachments thumbnails sanitize clean privacy', run: ({ ui }) => ui.openDialog('hiddenData') },
    { id: 'file.unlock', title: 'cmd.unlock', group: 'file', icon: 'lock-open', when: (c) => !!c.session?.meta.permissions && !!c.session.ref, keywords: 'owner password restrictions permissions', run: ({ app, session }) => void app.unlockRestrictions(session!) },
    { id: 'file.home', title: 'cmd.home', group: 'file', icon: 'house', run: ({ app }) => app.showHome() },
    // Tasks
    { id: 'task.merge', needs: 'assemble', title: 'cmd.merge', group: 'file', icon: 'combine', keywords: 'combine join pdfs', run: ({ ui }) => ui.openDialog('merge') },
    { id: 'task.split', needs: 'assemble', title: 'cmd.split', group: 'file', icon: 'scissors', when: doc, keywords: 'separate divide', run: ({ ui }) => ui.openDialog('split') },
    { id: 'task.images', title: 'cmd.imagesToPdf', group: 'file', icon: 'images', keywords: 'photos jpg png scan', run: ({ ui }) => ui.openDialog('images') },
    { id: 'task.ocr', title: 'cmd.ocr.open', group: 'file', icon: 'scan-text', when: doc, keywords: 'recognise recognize text scan searchable ocr', run: ({ ui }) => ui.openDialog('ocr') },
    { id: 'export.compress', title: 'cmd.compress', group: 'export', icon: 'file-down', when: doc, keywords: 'reduce shrink smaller size compress optimise', run: ({ ui }) => ui.openDialog('compress') },
    { id: 'sign.digital', title: 'cmd.digitalSign', group: 'export', icon: 'badge-check', when: doc, keywords: 'certificate pades sign digitally seal', run: ({ ui }) => ui.openDialog('digitalSign') },
    { id: 'sign.remove', needs: 'modify', title: 'cmd.removeSignatures', group: 'export', icon: 'shield-x', when: (c) => !!c.session?.meta.hasSignatures, keywords: 'delete invalidate signed signature remove unsign', run: ({ app, session }) => void app.removeSignatures(session!) },
    { id: 'sign.verify', title: 'cmd.verifySignatures', group: 'export', icon: 'shield-check', when: doc, keywords: 'validate check signatures certificate', run: ({ ui }) => ui.openDialog('signatures') },
    { id: 'export.images', needs: 'copy', title: 'cmd.exportImages', group: 'export', icon: 'image-down', when: doc, keywords: 'png jpeg webp pictures', run: ({ ui }) => ui.openDialog('exportImages') },
    { id: 'export.flatten', needs: 'modify', title: 'cmd.flattenAll', group: 'export', icon: 'layers-2', when: doc, keywords: 'burn annotations form', run: async ({ app, session }) => {
        if (await app.prompts.confirm({ key: 'confirm.flatten' }, { danger: true, confirmLabel: { key: 'cmd.flatten.both' } })) await app.guard(() => session!.run(app.services.exporter.flatten('both')));
      } },
    { id: 'export.flattenAnnotations', needs: 'modify', title: 'cmd.flattenAnnotations', group: 'export', icon: 'layers-2', when: doc, run: async ({ app, session }) => {
        if (await app.prompts.confirm({ key: 'confirm.flattenAnnotations' }, { danger: true, confirmLabel: { key: 'cmd.flatten.annotations' } })) await app.guard(() => session!.run(app.services.exporter.flatten('annotations')));
      } },
    { id: 'export.flattenedCopy', title: 'cmd.flattenedCopy', group: 'export', icon: 'file-output', when: doc, run: async ({ app, session }) => {
        const ref = await app.services.platform.files.pickSave({ suggestedName: session!.name.replace(/\.pdf$/i, '') + ' (flattened).pdf', kind: 'pdf' });
        if (ref) await app.guard(async () => app.services.platform.files.write(ref, await app.services.exporter.flattenedCopy(session!.doc, app.services.engine), { atomic: true }));
      } },
    // Edit
    { id: 'edit.undo', title: 'cmd.undo', group: 'edit', icon: 'undo-2', shortcut: 'Mod+Z', when: (c) => !!c.session?.historyState.canUndo, run: ({ session }) => void session!.undo() },
    { id: 'edit.redo', title: 'cmd.redo', group: 'edit', icon: 'redo-2', shortcut: 'Mod+Shift+Z', when: (c) => !!c.session?.historyState.canRedo, run: ({ session }) => void session!.redo() },
    { id: 'edit.history', title: 'cmd.history', group: 'edit', icon: 'history', when: doc, run: ({ ui }) => ui.openDialog('history') },
    { id: 'edit.find', title: 'cmd.find', group: 'edit', icon: 'search', shortcut: 'Mod+F', global: true, when: doc, run: ({ find }) => find!.toggle(true) },
    { id: 'edit.delete', needs: (c) => { const k = c.session?.selection.kind; return k === 'pages' ? 'assemble' : k === 'annotations' ? 'annotate' : k === 'object' ? 'modify' : undefined; }, title: 'cmd.delete', group: 'edit', icon: 'trash-2', shortcut: 'Del', when: (c) => !!c.session && c.session.selection.kind !== 'none' && c.session.selection.kind !== 'text', run: async ({ session, tools, organise }) => {
        if (session!.selection.kind === 'pages') await organise?.delete();
        else await tools!.deleteSelection();
      } },
    { id: 'edit.selectAll', title: 'cmd.selectAll', group: 'edit', icon: 'square-check-big', shortcut: 'Mod+A', when: inMode('organise'), run: ({ organise }) => organise?.selectAll() },
    { id: 'edit.copy', needs: 'copy', title: 'cmd.copy', group: 'edit', icon: 'copy', shortcut: 'Mod+C', when: (c) => !!c.session && (c.session.selection.kind === 'text' || c.session.selection.kind === 'annotations'), run: ({ tools }) => void tools!.copySelection() },
    { id: 'edit.cancel', title: 'cmd.cancel', group: 'edit', shortcut: 'Esc', when: doc, run: ({ tools, find }) => {
        if (find!.open) find!.toggle(false);
        else tools!.cancel();
      } },
    // View
    { id: 'view.palette', title: 'cmd.palette', group: 'view', icon: 'command', shortcut: 'Mod+K', global: true, run: ({ ui }) => ui.togglePalette() },
    { id: 'view.zoomIn', title: 'cmd.zoomIn', group: 'view', icon: 'zoom-in', shortcut: 'Mod+=', global: true, when: doc, run: ({ session }) => session!.setZoom('custom', stepZoom(session!.view.zoom, 1)) },
    { id: 'view.zoomOut', title: 'cmd.zoomOut', group: 'view', icon: 'zoom-out', shortcut: 'Mod+-', global: true, when: doc, run: ({ session }) => session!.setZoom('custom', stepZoom(session!.view.zoom, -1)) },
    { id: 'view.fitWidth', title: 'cmd.fitWidth', group: 'view', icon: 'move-horizontal', shortcut: 'Mod+0', global: true, when: doc, run: ({ session }) => session!.setZoom('fit-width') },
    { id: 'view.fitPage', title: 'cmd.fitPage', group: 'view', icon: 'maximize', when: doc, run: ({ session }) => session!.setZoom('fit-page') },
    { id: 'view.actualSize', title: 'cmd.actualSize', group: 'view', icon: 'scan', shortcut: 'Mod+1', global: true, when: doc, run: ({ session }) => session!.setZoom('actual', 1) },
    { id: 'view.rotate', title: 'cmd.rotateView', group: 'view', icon: 'rotate-cw', shortcut: 'Mod+Shift+R', global: true, when: doc, run: ({ session }) => session!.rotateView(90) },
    { id: 'view.applyRotation', title: 'cmd.applyRotation', group: 'view', icon: 'rotate-cw-square', when: (c) => !!c.session && c.session.view.rotation !== 0, run: ({ session }) => void session!.applyViewRotation() },
    { id: 'view.sidebar', title: 'cmd.toggleSidebar', group: 'view', icon: 'panel-left', shortcut: 'F4', global: true, when: doc, run: ({ ui }) => ui.toggleSidebar() },
    { id: 'view.inspector', title: 'cmd.toggleInspector', group: 'view', icon: 'panel-right', shortcut: 'F5', global: true, when: doc, run: ({ ui }) => ui.toggleInspector() },
    { id: 'view.continuous', title: 'cmd.layoutContinuous', group: 'view', icon: 'rows-3', when: doc, run: ({ session }) => session!.setLayout('continuous') },
    { id: 'view.single', title: 'cmd.layoutSingle', group: 'view', icon: 'file', when: doc, run: ({ session }) => session!.setLayout('single') },
    { id: 'view.twoPage', title: 'cmd.layoutTwoPage', group: 'view', icon: 'book-open', when: doc, run: ({ session }) => session!.setLayout('two-page') },
    { id: 'view.themeNormal', title: 'cmd.pageNormal', group: 'view', icon: 'sun', when: doc, run: ({ session }) => session!.setTheme('normal') },
    { id: 'view.themeDark', title: 'cmd.pageDark', group: 'view', icon: 'moon', when: doc, keywords: 'night invert', run: ({ session }) => session!.setTheme('dark') },
    { id: 'view.themeSepia', title: 'cmd.pageSepia', group: 'view', icon: 'coffee', when: doc, run: ({ session }) => session!.setTheme('sepia') },
    { id: 'view.themeContrast', title: 'cmd.pageContrast', group: 'view', icon: 'contrast', when: doc, run: ({ session }) => session!.setTheme('high-contrast') },
    { id: 'view.nextPage', title: 'cmd.nextPage', group: 'view', icon: 'chevron-down', shortcut: 'PageDown', when: doc, run: ({ session }) => session!.goToPage(navigate('PageDown', session!.view.page, session!.pageCount, session!.view.layout)) },
    { id: 'view.prevPage', title: 'cmd.prevPage', group: 'view', icon: 'chevron-up', shortcut: 'PageUp', when: doc, run: ({ session }) => session!.goToPage(navigate('PageUp', session!.view.page, session!.pageCount, session!.view.layout)) },
    { id: 'view.firstPage', title: 'cmd.firstPage', group: 'view', shortcut: 'Home', when: doc, run: ({ session }) => session!.goToPage(0) },
    { id: 'view.lastPage', title: 'cmd.lastPage', group: 'view', shortcut: 'End', when: doc, run: ({ session }) => session!.goToPage(session!.pageCount - 1) },
    { id: 'view.theme', title: 'cmd.toggleTheme', group: 'view', icon: 'sun-moon', keywords: 'dark light appearance', run: ({ app }) => app.setSetting('theme', app.settings.theme === 'dark' ? 'light' : 'dark') },
    // Modes
    ...MODES.map(
      (mode): C => ({ id: `mode.${mode}`, title: `mode.${mode}`, group: 'mode', shortcut: mode === 'organise' ? 'Mod+Shift+O' : undefined, global: mode === 'organise', when: doc, run: ({ session }) => session!.setMode(mode) }),
    ),
    // Tools (Appendix A)
    tool('select', 'tool.select', 'mouse-pointer-2', 'V', 'view'),
    tool('edit-text', 'tool.editText', 'text-cursor-input', 'E', 'edit', 'typo fix change text'),
    tool('add-text', 'tool.addText', 'type', undefined, 'edit'),
    tool('whiteout', 'tool.whiteout', 'eraser', undefined, 'edit', 'cover hide white'),
    tool('highlight', 'tool.highlight', 'highlighter', 'H', 'annotate', 'marker'),
    tool('underline', 'tool.underline', 'underline', undefined, 'annotate'),
    tool('strikeout', 'tool.strikeout', 'strikethrough', undefined, 'annotate'),
    tool('squiggly', 'tool.squiggly', 'spline', undefined, 'annotate'),
    tool('note', 'tool.note', 'message-square', 'N', 'annotate', 'comment sticky'),
    tool('textbox', 'tool.textbox', 'text-cursor', 'T', 'annotate', 'typewriter free text'),
    tool('rect', 'tool.shape', 'square', 'S', 'annotate', 'rectangle box'),
    tool('ellipse', 'tool.ellipse', 'circle', undefined, 'annotate', 'oval'),
    tool('line', 'tool.line', 'minus', undefined, 'annotate'),
    tool('arrow', 'tool.arrow', 'move-up-right', undefined, 'annotate'),
    tool('polyline', 'tool.polyline', 'waypoints', undefined, 'annotate'),
    tool('cover-type', 'tool.coverType', 'pencil-line', undefined, 'fill', 'type on form non-fillable'),
    tool('check', 'tool.check', 'check', undefined, 'fill', 'tick'),
    tool('cross', 'tool.cross', 'x', undefined, 'fill'),
    tool('snapshot', 'tool.snapshot', 'camera', undefined, 'view', 'copy area image'),
    tool('table', 'tool.table', 'table', undefined, 'view', 'extract table csv spreadsheet grid'),
    { id: 'task.tableWhole', title: 'cmd.tableWholePage', group: 'file', icon: 'table', when: doc, keywords: 'extract table csv page', run: ({ ui }) => ui.openDialog('tables') },
    // Sign & stamps
    { id: 'sign.sign', needs: 'annotate', title: 'cmd.sign', group: 'sign', icon: 'signature', shortcut: 'G', when: doc, keywords: 'signature autograph', run: async ({ session, sign, tools, ui }) => {
        session!.setMode('fill');
        if ((await sign.sign(tools!)) === 'creating') ui.openDialog('signature');
      } },
    { id: 'sign.initials', needs: 'annotate', title: 'cmd.initials', group: 'sign', icon: 'pen-line', when: doc, run: async ({ session, sign, tools, ui }) => {
        session!.setMode('fill');
        if ((await sign.sign(tools!, 'initials')) === 'creating') ui.openDialog('signature');
      } },
    { id: 'sign.create', title: 'cmd.createSignature', group: 'sign', icon: 'plus', run: ({ sign, ui }) => {
        sign.openCreate('signature');
        ui.openDialog('signature');
      } },
    { id: 'sign.date', needs: 'annotate', title: 'cmd.insertDate', group: 'sign', icon: 'calendar', shortcut: 'Mod+Shift+D', global: true, when: doc, run: ({ session, sign, tools }) => {
        session!.setMode('fill');
        sign.placeDate(tools!);
      } },
    { id: 'sign.stamps', title: 'cmd.manageStamps', group: 'sign', icon: 'stamp', run: ({ ui }) => ui.openDialog('stampEditor') },
    // Pages (Organise)
    { id: 'pages.rotateCw', needs: 'assemble', title: 'cmd.rotateCw', group: 'pages', icon: 'rotate-cw', shortcut: 'R', when: hasPages, run: ({ organise }) => void organise?.rotate(90) },
    { id: 'pages.rotateCcw', needs: 'assemble', title: 'cmd.rotateCcw', group: 'pages', icon: 'rotate-ccw', shortcut: 'Shift+R', when: hasPages, run: ({ organise }) => void organise?.rotate(270) },
    { id: 'pages.rotate180', needs: 'assemble', title: 'cmd.rotate180', group: 'pages', icon: 'refresh-cw', when: hasPages, run: ({ organise }) => void organise?.rotate(180) },
    { id: 'pages.duplicate', needs: 'assemble', title: 'cmd.duplicate', group: 'pages', icon: 'copy-plus', shortcut: 'Mod+D', global: true, when: hasPages, run: ({ organise }) => void organise?.duplicate() },
    { id: 'pages.extract', needs: 'assemble', title: 'cmd.extract', group: 'pages', icon: 'file-output', when: hasPages, run: ({ organise }) => void organise?.extract(false) },
    { id: 'pages.insertBlank', needs: 'assemble', title: 'cmd.insertBlank', group: 'pages', icon: 'file-plus', when: inMode('organise'), run: ({ ui }) => ui.openDialog('insertBlank') },
    { id: 'pages.insertFile', needs: 'assemble', title: 'cmd.insertFromFile', group: 'pages', icon: 'file-input', when: inMode('organise'), run: ({ organise, session }) => {
        const sel = session!.selection;
        void organise?.insertFromFile(sel.kind === 'pages' ? sel.pages[sel.pages.length - 1]! + 1 : session!.pageCount);
      } },
    { id: 'pages.replace', needs: 'assemble', title: 'cmd.replacePages', group: 'pages', icon: 'replace', when: hasPages, run: ({ organise }) => void organise?.replaceFromFile() },
    { id: 'pages.moveUp', needs: 'assemble', title: 'cmd.movePagesUp', group: 'pages', icon: 'arrow-left', shortcut: 'Alt+ArrowLeft', when: hasPages, run: ({ organise }) => void organise?.nudge(-1) },
    { id: 'pages.moveDown', needs: 'assemble', title: 'cmd.movePagesDown', group: 'pages', icon: 'arrow-right', shortcut: 'Alt+ArrowRight', when: hasPages, run: ({ organise }) => void organise?.nudge(1) },
    { id: 'pages.selectOdd', title: 'cmd.selectOdd', group: 'pages', when: inMode('organise'), run: ({ organise }) => organise?.selectOdd() },
    { id: 'pages.selectEven', title: 'cmd.selectEven', group: 'pages', when: inMode('organise'), run: ({ organise }) => organise?.selectEven() },
    { id: 'pages.selectNone', title: 'cmd.selectNone', group: 'pages', when: inMode('organise'), run: ({ organise }) => organise?.selectNone() },
    // Settings & help
    { id: 'settings.open', title: 'cmd.settings', group: 'settings', icon: 'settings', keywords: 'preferences options theme language units ai key', run: ({ ui }) => ui.openDialog('settings') },
    { id: 'settings.profiles', title: 'cmd.profiles', group: 'settings', icon: 'contact', keywords: 'my data reference auto fill', run: ({ ui }) => ui.openDialog('profiles') },
    { id: 'help.shortcuts', title: 'cmd.shortcuts', group: 'help', icon: 'keyboard', run: ({ ui }) => ui.openDialog('shortcuts') },
    { id: 'help.privacy', title: 'cmd.privacy', group: 'help', icon: 'shield', run: ({ ui }) => ui.openDialog('privacy') },
    { id: 'help.about', title: 'cmd.about', group: 'help', icon: 'badge-info', run: ({ ui }) => ui.openDialog('about') },
  );
  return r;
}
