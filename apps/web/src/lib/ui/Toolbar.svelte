<script lang="ts">
  import { MODES, formatChord, type DocumentSession, type Mode, type ToolId } from '@folio/app';
  import { HIGHLIGHT_COLORS } from '@folio/services';
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, isMac, models, registry, commandContext, run, services, sign, track, ui } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import Menu, { type MenuItem } from './Menu.svelte';
  import { colorToHex, hexToColor, png } from './raster.ts';
  import { tip } from './tip.ts';

  let { session }: { session: DocumentSession } = $props();
  const m = $derived(models(session));
  const mode = $derived(dep(track(), session.mode));
  const tool = $derived(dep(track(), m.tools.tool));
  const opts = $derived(dep(track(), m.tools.options));
  const hs = $derived(dep(track(), session.historyState));
  const selCount = $derived(dep(track(), session.selection.kind === 'pages' ? session.selection.pages.length : 0));
  const k = (s?: string): string | undefined => (s ? formatChord(s, isMac) : undefined);
  const MODE_ICON: Record<Mode, string> = { view: 'eye', organise: 'layout-grid', annotate: 'highlighter', fill: 'pen-line', edit: 'file-pen' };
  const HL = Object.values(HIGHLIGHT_COLORS).map(colorToHex);
  const INK = ['#d32f2f', '#2563eb', '#16803c', '#171a20', '#a15c00'];

  let menu = $state<{ items: MenuItem[]; x: number; y: number } | null>(null);
  function open(e: MouseEvent, items: MenuItem[]): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu = { items, x: r.left, y: r.bottom + 4 };
  }
  function pick(id: ToolId, e?: MouseEvent): void {
    m.tools.setTool(id, { sticky: !!e?.shiftKey });
  }
  const cmd = (id: string) => registry.get(id)!;
  const enabled = (id: string): boolean => (track(), registry.isEnabled(id, commandContext()));

  const layoutMenu = (): MenuItem[] => [
    { icon: 'rows-3', label: t('cmd.layoutContinuous'), checked: session.view.layout === 'continuous', run: () => session.setLayout('continuous') },
    { icon: 'file', label: t('cmd.layoutSingle'), checked: session.view.layout === 'single', run: () => session.setLayout('single') },
    { icon: 'columns-2', label: t('cmd.layoutTwoPage'), checked: session.view.layout === 'two-page', run: () => session.setLayout('two-page') },
    { kind: 'sep' },
    { icon: 'sun', label: t('cmd.pageNormal'), checked: session.view.theme === 'normal', run: () => session.setTheme('normal') },
    { icon: 'moon', label: t('cmd.pageDark'), checked: session.view.theme === 'dark', run: () => session.setTheme('dark') },
    { icon: 'coffee', label: t('cmd.pageSepia'), checked: session.view.theme === 'sepia', run: () => session.setTheme('sepia') },
    { icon: 'contrast', label: t('cmd.pageContrast'), checked: session.view.theme === 'high-contrast', run: () => session.setTheme('high-contrast') },
  ];
  const shapeMenu = (): MenuItem[] => [
    { icon: 'square', label: t('ui.rectangle'), shortcut: 'S', run: () => pick('rect') },
    { icon: 'circle', label: t('ui.ellipse'), run: () => pick('ellipse') },
    { icon: 'minus', label: t('ui.line'), run: () => pick('line') },
    { icon: 'move-up-right', label: t('ui.arrow'), run: () => pick('arrow') },
    { icon: 'waypoints', label: t('ui.polyline'), run: () => pick('polyline') },
  ];
  const insertMenu = (): MenuItem[] => [
    { icon: 'file-plus', label: t('ui.blankBefore'), run: () => void m.organise.insertBlank('before') },
    { icon: 'file-plus', label: t('ui.blankAfter'), run: () => void m.organise.insertBlank('after') },
    { icon: 'file-plus', label: t('cmd.insertBlank'), run: () => ui.openDialog('insertBlank') },
    { icon: 'file-input', label: t('ui.fromFile'), run: () => void run('pages.insertFile') },
  ];
  const signMenu = (): MenuItem[] => {
    const sigs = sign.of('signature');
    const inits = sign.of('initials');
    return [
      { kind: 'head', label: t('sign.saved') },
      ...(sigs.length ? sigs.map((s): MenuItem => ({ kind: 'custom', id: s.id })) : ([{ label: t('sign.none'), disabled: true, run: () => undefined }] as MenuItem[])),
      ...(inits.length ? ([{ kind: 'head', label: t('sign.savedInitials') }, ...inits.map((s): MenuItem => ({ kind: 'custom', id: s.id }))] as MenuItem[]) : []),
      { kind: 'sep' },
      { icon: 'plus', label: t('sign.createNew'), run: () => (sign.openCreate('signature'), ui.openDialog('signature')) },
      { icon: 'pen-line', label: t('sign.createInitials'), run: () => (sign.openCreate('initials'), ui.openDialog('signature')) },
      { icon: 'calendar', label: t('cmd.insertDate'), shortcut: k('Mod+Shift+D'), run: () => void run('sign.date') },
    ];
  };
  const stampMenu = (): MenuItem[] => [
    { kind: 'head', label: t('stamp.builtin') },
    ...sign.builtinStamps.map((s): MenuItem => ({ kind: 'custom', id: s.id })),
    ...(sign.customStamps.length ? ([{ kind: 'head', label: t('stamp.custom') }, ...sign.customStamps.map((s): MenuItem => ({ kind: 'custom', id: s.id }))] as MenuItem[]) : []),
    { kind: 'sep' },
    { icon: 'settings-2', label: t('stamp.manage'), run: () => ui.openDialog('stampEditor') },
  ];
  async function addImage(): Promise<void> {
    const [ref] = await services.platform.files.pickOpen({ accept: ['image'] });
    if (!ref) return;
    const prepared = await app.guard(async () => services.objects.prepare(await services.platform.files.read(ref)));
    if (!prepared) return;
    const w = Math.min(240, prepared.width * 0.75);
    m.tools.beginPlacement({ kind: 'image', size: { width: w, height: (w * prepared.height) / prepared.width }, make: (rect) => ({ image: { image: prepared.image, rect } }) });
    app.toast('info', { key: 'toast.placeHint' });
  }
  async function replaceImage(): Promise<void> {
    const sel = session.selection;
    if (sel.kind !== 'object') return;
    const [ref] = await services.platform.files.pickOpen({ accept: ['image'] });
    if (!ref) return;
    await app.guard(async () => session.run(services.objects.replace(sel.page, sel.id, (await services.objects.prepare(await services.platform.files.read(ref))).image)));
  }
  const stampDef = (id: string) => [...sign.builtinStamps, ...sign.customStamps].find((s) => s.id === id);
  const sigOf = (id: string) => sign.signatures.find((s) => s.id === id);
</script>

{#snippet toolBtn(id: ToolId, icon: string, label: string, shortcut?: string, hint?: string)}
  <button class="tool" class:on={tool === id} onclick={(e) => pick(id, e)} use:tip={[hint ? `${label} · ${hint}` : label, shortcut]} aria-label={label} aria-pressed={tool === id}>
    <Icon name={icon} /><span class="lbl">{label}</span>
  </button>
{/snippet}
{#snippet cmdBtn(id: string, icon: string, label?: string)}
  {@const c = cmd(id)}
  <button class="tool" disabled={!enabled(id)} onclick={() => run(id)} use:tip={[t(c.title), k(c.shortcut)]} aria-label={t(c.title)}>
    <Icon name={icon} /><span class="lbl">{label ?? t(c.title)}</span>
  </button>
{/snippet}
{#snippet menuBtn(icon: string, label: string, items: () => MenuItem[], shortcut?: string, on = false)}
  <button class="tool" class:on onclick={(e) => open(e, items())} use:tip={[label, shortcut]} aria-label={label} aria-haspopup="menu">
    <Icon name={icon} /><span class="lbl">{label}</span><span class="caret"><Icon name="chevron-down" /></span>
  </button>
{/snippet}

<div id="modebar">
  <div class="seg" id="modes" role="tablist" aria-label={t('mode.label')}>
    {#each MODES as md (md)}
      <button role="tab" class:on={mode === md} aria-selected={mode === md} onclick={() => session.setMode(md)} use:tip={md === 'organise' ? [t('mode.organise'), k('Mod+Shift+O')] : undefined}>
        <Icon name={MODE_ICON[md]} /><span class="lbl2">{t(`mode.${md}`)}</span>
      </button>
    {/each}
  </div>
  <div class="grow"></div>
  <button class="ib" disabled={!hs.canUndo} onclick={() => session.undo()} use:tip={[t('cmd.undo'), k('Mod+Z')]} aria-label={t('cmd.undo')}><Icon name="undo-2" /></button>
  <button class="ib" disabled={!hs.canRedo} onclick={() => session.redo()} use:tip={[t('cmd.redo'), k('Mod+Shift+Z')]} aria-label={t('cmd.redo')}><Icon name="redo-2" /></button>
  <button class="btn ghost" onclick={() => run('edit.find')} use:tip={[t('cmd.find'), k('Mod+F')]}><Icon name="search" /><span class="lbl2">{t('ui.find')}</span></button>
  <div class="savegrp">
    <button class="btn primary" onclick={() => run('file.save')} use:tip={[t('cmd.save'), k('Mod+S')]}><Icon name="save" /><span class="lbl2">{t('cmd.save')}</span></button>
    <button
      class="btn primary"
      aria-label={t('action.more')}
      aria-haspopup="menu"
      onclick={(e) =>
        open(e, [
          { icon: 'save', label: t('cmd.save'), shortcut: k('Mod+S'), run: () => void run('file.save') },
          { icon: 'save-all', label: t('cmd.saveAs'), shortcut: k('Mod+Shift+S'), run: () => void run('file.saveAs') },
          { icon: 'copy', label: t('cmd.exportCopy'), run: () => void run('file.exportCopy') },
          { icon: 'file-output', label: t('cmd.flattenedCopy'), run: () => void run('export.flattenedCopy') },
          { kind: 'sep' },
          { icon: 'file-image', label: t('cmd.exportImages'), run: () => void run('export.images') },
          { icon: 'info', label: t('cmd.properties'), run: () => void run('file.properties') },
        ])}><Icon name="chevron-down" /></button>
  </div>
</div>

<div id="toolbar" role="toolbar" aria-label={t(`mode.${mode}`)}>
  {#if mode === 'view'}
    {@render toolBtn('select', 'mouse-pointer-2', t('tool.select'), 'V')}
    {@render toolBtn('snapshot', 'camera', t('tool.snapshot'))}
    <span class="vsep"></span>
    {@render menuBtn('columns-2', t('tool.layout'), layoutMenu)}
    {@render cmdBtn('view.zoomOut', 'zoom-out')}
    {@render cmdBtn('view.zoomIn', 'zoom-in')}
    {@render cmdBtn('view.fitWidth', 'move-horizontal')}
    <span class="vsep"></span>
    <button class="tool" class:on={session.view.theme === 'dark'} aria-pressed={session.view.theme === 'dark'} onclick={() => session.setTheme(session.view.theme === 'dark' ? 'normal' : 'dark')} use:tip={t('tool.darkPages')}>
      <Icon name="moon" /><span class="lbl">{t('tool.darkPages')}</span>
    </button>
    {@render cmdBtn('file.print', 'printer')}
    {#if session.view.rotation !== 0}{@render cmdBtn('view.applyRotation', 'rotate-cw-square')}{/if}
  {:else if mode === 'organise'}
    {@render cmdBtn('pages.rotateCcw', 'rotate-ccw', t('tool.rotateLeft'))}
    {@render cmdBtn('pages.rotateCw', 'rotate-cw', t('tool.rotateRight'))}
    {@render cmdBtn('edit.delete', 'trash-2')}
    {@render cmdBtn('pages.duplicate', 'copy', t('tool.duplicate'))}
    {@render cmdBtn('pages.extract', 'file-output', t('tool.extract'))}
    <span class="vsep"></span>
    {@render menuBtn('file-plus', t('tool.insert'), insertMenu)}
    {@render cmdBtn('pages.replace', 'replace', t('tool.replace'))}
    <span class="vsep"></span>
    {@render cmdBtn('task.merge', 'files', t('tool.merge'))}
    {@render cmdBtn('task.split', 'scissors', t('tool.split'))}
    <span class="grow"></span>
    <span class="chip acc">{t('ui.selected', { count: selCount })}</span>
    <button class="btn ghost sm" onclick={() => m.organise.selectAll()}>{t('ui.selectAll')}</button>
  {:else if mode === 'annotate'}
    {@render toolBtn('select', 'mouse-pointer-2', t('tool.select'), 'V')}
    <span class="vsep"></span>
    {@render toolBtn('highlight', 'highlighter', t('tool.highlight'), 'H', t('tool.sticky'))}
    {@render toolBtn('underline', 'underline', t('tool.underline'))}
    {@render toolBtn('strikeout', 'strikethrough', t('tool.strikeout'))}
    {@render toolBtn('squiggly', 'spline', t('tool.squiggly'))}
    {@render toolBtn('note', 'message-square', t('tool.note'), 'N')}
    {@render toolBtn('textbox', 'type', t('tool.textbox'), 'T')}
    {@render menuBtn('square', t('tool.shapes'), shapeMenu, 'S', ['rect', 'ellipse', 'line', 'arrow', 'polyline'].includes(tool))}
    <span class="vsep"></span>
    <button class="tool" onclick={() => (session.setSidebarTab('annotations'), !ui.sidebarOpen && ui.toggleSidebar())} use:tip={t('tool.comments')}><Icon name="messages-square" /><span class="lbl">{t('tool.comments')}</span></button>
    {@render cmdBtn('export.flattenAnnotations', 'layers', t('tool.flatten'))}
    <span class="grow"></span>
    <span class="tbhint">{t('tool.colour')}</span>
    {#if ['highlight'].includes(tool) || tool === 'select'}
      {#each HL as c (c)}
        <button class="swatch" class:on={colorToHex(opts.highlightColor) === c} style="background:{c}" aria-label={c} onclick={() => m.tools.setOptions({ highlightColor: hexToColor(c) })}></button>
      {/each}
    {:else}
      {#each INK as c (c)}
        <button class="swatch" class:on={colorToHex(opts.color) === c} style="background:{c}" aria-label={c} onclick={() => m.tools.setOptions({ color: hexToColor(c), textColor: hexToColor(c) })}></button>
      {/each}
    {/if}
  {:else if mode === 'fill'}
    {@render toolBtn('select', 'text-cursor-input', t('tool.fillForm'), 'Tab')}
    {@render toolBtn('cover-type', 'type', t('tool.coverType'), undefined, t('tool.coverHint'))}
    {@render toolBtn('check', 'check', t('tool.check'))}
    {@render toolBtn('cross', 'x', t('tool.cross'))}
    <button class="tool" class:on={m.form.highlight} aria-pressed={m.form.highlight} onclick={() => m.form.toggleHighlight()} use:tip={t('tool.highlightFields')}><Icon name="scan-line" /><span class="lbl">{t('tool.highlightFields')}</span></button>
    <span class="vsep"></span>
    {@render menuBtn('signature', t('cmd.sign'), signMenu, 'G')}
    {@render cmdBtn('sign.date', 'calendar', t('tool.date'))}
    {@render menuBtn('stamp', t('tool.stamp'), stampMenu)}
    <button class="tool" onclick={addImage} use:tip={t('tool.image')}><Icon name="image" /><span class="lbl">{t('tool.image')}</span></button>
    <span class="vsep"></span>
    <button class="tool" disabled={m.form.fillableCount === 0} onclick={() => m.form.flatten()} use:tip={t('tool.flattenForm')}><Icon name="layers" /><span class="lbl">{t('tool.flattenForm')}</span></button>
    <span class="grow"></span>
    <button class="tool accent" onclick={() => (!ui.inspectorOpen && ui.toggleInspector(), void m.smart.start())} use:tip={t('banner.autoFill')}><Icon name="sparkles" /><span class="lbl">{t('tool.smartFill')}</span></button>
  {:else}
    {@render toolBtn('select', 'mouse-pointer-2', t('tool.select'), 'V')}
    {@render toolBtn('edit-text', 'text-cursor', t('tool.editText'), 'E')}
    {@render toolBtn('add-text', 'type', t('tool.addText'))}
    {@render toolBtn('whiteout', 'eraser', t('tool.whiteout'), undefined, t('tool.whiteoutHint'))}
    <span class="vsep"></span>
    <button class="tool" onclick={addImage} use:tip={t('tool.addImage')}><Icon name="image-plus" /><span class="lbl">{t('tool.addImage')}</span></button>
    <button class="tool" disabled={session.selection.kind !== 'object'} onclick={replaceImage} use:tip={t('tool.replaceImage')}><Icon name="replace" /><span class="lbl">{t('tool.replaceImage')}</span></button>
    {@render cmdBtn('edit.delete', 'trash-2')}
    <span class="grow"></span>
    {#if tool === 'whiteout'}
      <label class="tbhint"><input type="checkbox" checked={opts.removeUnderWhiteout} onchange={(e) => m.tools.setOptions({ removeUnderWhiteout: e.currentTarget.checked })} />{t('tool.removeUnder')}</label>
      <span class="tbhint"><Icon name="info" />{t('tool.whiteoutHint')}</span>
    {:else if tool === 'add-text'}
      <label class="tbhint"><input type="checkbox" checked={opts.addAsPageContent} onchange={(e) => m.tools.setOptions({ addAsPageContent: e.currentTarget.checked })} />{t('tool.asPageContent')}</label>
    {/if}
  {/if}
</div>

{#if menu}
  <Menu items={menu.items} anchor={menu} onclose={() => (menu = null)}>
    {#snippet custom(id: string)}
      {@const sig = sigOf(id)}
      {@const def = stampDef(id)}
      {#if sig}
        <button class="sigprev" style="width:calc(100% - 8px);padding:2px 8px" onclick={() => ((menu = null), void sign.place(m.tools, sig))} aria-label={sig.name}>
          <img use:png={sig.png} alt={sig.name} style="height:28px;max-width:200px;object-fit:contain" />
        </button>
      {:else if def}
        <button class="mi" role="menuitem" onclick={() => ((menu = null), sign.placeStamp(m.tools, def))}>
          {#if def.style}
            <span class="stp" style="color:rgb({def.style.color.r},{def.style.color.g},{def.style.color.b});border-color:currentColor;{def.style.border ? '' : 'border-color:transparent'}">{def.kind === 'builtin' ? t(def.name) : def.style.text}</span>
          {:else if def.mark}
            <Icon name={def.mark === 'check' ? 'check' : def.mark === 'cross' ? 'x' : 'circle'} /><span class="grow">{t(def.name)}</span>
          {:else}
            <Icon name="image" /><span class="grow">{def.name}</span>
          {/if}
        </button>
      {/if}
    {/snippet}
  </Menu>
{/if}
