<script lang="ts">
  import { themeFilter } from '@folio/app';
  import { t, tm } from '#lib/i18n/index.ts';
  import { dep, app, boot, commandContext, isMac, models, registry, services, sign, start, track, ui } from '#lib/state.svelte.ts';
  import Canvas from '#lib/ui/Canvas.svelte';
  import Coach from '#lib/ui/Coach.svelte';
  import ExportDialog from '#lib/ui/dialogs/ExportDialog.svelte';
  import ImagesDialog from '#lib/ui/dialogs/ImagesDialog.svelte';
  import MergeDialog from '#lib/ui/dialogs/MergeDialog.svelte';
  import PropertiesDialog from '#lib/ui/dialogs/PropertiesDialog.svelte';
  import SettingsDialog from '#lib/ui/dialogs/SettingsDialog.svelte';
  import SignatureDialog from '#lib/ui/dialogs/SignatureDialog.svelte';
  import SmallDialogs from '#lib/ui/dialogs/SmallDialogs.svelte';
  import SplitDialog from '#lib/ui/dialogs/SplitDialog.svelte';
  import StampsDialog from '#lib/ui/dialogs/StampsDialog.svelte';
  import AiDebugDialog from '#lib/ui/dialogs/AiDebugDialog.svelte';
  import CompressDialog from '#lib/ui/dialogs/CompressDialog.svelte';
  import DigitalSignDialog from '#lib/ui/dialogs/DigitalSignDialog.svelte';
  import SignaturesDialog from '#lib/ui/dialogs/SignaturesDialog.svelte';
  import OcrDialog from '#lib/ui/dialogs/OcrDialog.svelte';
  import TablesDialog from '#lib/ui/dialogs/TablesDialog.svelte';
  import Dialog from '#lib/ui/Dialog.svelte';
  import FindBar from '#lib/ui/FindBar.svelte';
  import Home from '#lib/ui/Home.svelte';
  import Icon from '#lib/ui/Icon.svelte';
  import Inspector from '#lib/ui/Inspector.svelte';
  import Organise from '#lib/ui/Organise.svelte';
  import Palette from '#lib/ui/Palette.svelte';
  import PromptHost from '#lib/ui/PromptHost.svelte';
  import Sidebar from '#lib/ui/Sidebar.svelte';
  import StatusBar from '#lib/ui/StatusBar.svelte';
  import TitleBar from '#lib/ui/TitleBar.svelte';
  import Toasts from '#lib/ui/Toasts.svelte';
  import Toolbar from '#lib/ui/Toolbar.svelte';

  import { untrack } from 'svelte';
  void start();
  const v = $derived(track());
  const session = $derived(dep(v, boot.ready ? app.active : null));
  const dialog = $derived(dep(v, ui.dialog));
  const m = $derived(session ? models(session) : null);
  const tablesOpen = $derived(dep(v, !!m && m.tables.open));
  const banner = $derived(dep(v, m && session?.mode === 'fill' ? m.form.banner : null));
  let bannerOff = $state<string | null>(null);
  let ocrBannerOff = $state<string | null>(null);
  const scanBanner = $derived(dep(v, !!m && m.ocr.available && m.ocr.scannedHere));
  $effect(() => {
    void v;
    const model = m?.ocr;
    const page = session?.view.page;
    if (model && page !== undefined) untrack(() => void model.refreshBanner());
  });
  let dropping = $state(false);

  // Theme, accent colour, UI scale and motion follow the settings (FR-APP-10, §7.1).
  $effect(() => {
    void v;
    if (!boot.ready) return;
    const s = app.settings;
    const root = document.documentElement;
    if (s.theme === 'system') root.removeAttribute('data-theme');
    else root.dataset.theme = s.theme;
    root.style.setProperty('--ui-scale', String(s.uiScale));
    root.style.setProperty('--color-accent', s.accentColor === '#2563eb' ? '' : s.accentColor);
    if (s.accentColor === '#2563eb') root.style.removeProperty('--color-accent');
    root.classList.toggle('reduce-motion', s.reduceMotion);
    document.body.classList.toggle('edit', session?.mode === 'edit');
  });
  // The one-time signature note (FR-STM-12) and the sign intent of the home tile.
  const note = $derived(dep(v, boot.ready && sign.showNote));
  $effect(() => {
    void v;
    if (boot.ready && app.pendingIntent === 'sign' && session) {
      app.pendingIntent = null;
      void sign.sign(models(session).tools).then((r) => r === 'creating' && ui.openDialog('signature'));
    }
  });

  function onkeydown(e: KeyboardEvent): void {
    if (!boot.ready) return;
    // Hidden developer window: the AI requests of this session (not in the menus or the palette).
    if (e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyD') {
      e.preventDefault();
      ui.openDialog('aiDebug');
      return;
    }
    const target = e.target as HTMLElement;
    const typing = !!target.closest('input, textarea, select, [contenteditable]');
    const cmd = registry.match(e, commandContext(), { isMac, typing });
    if (!cmd) return;
    // Escape belongs to open menus, dialogs and editors first.
    if (cmd.id === 'edit.cancel' && (typing || ui.dialog || ui.palette)) return;
    e.preventDefault();
    void Promise.resolve(cmd.run(commandContext())).catch((err) => app.reportError(err));
  }
  // Paste: annotations copied in Folio, or an image from the clipboard as page content.
  async function onpaste(e: ClipboardEvent): Promise<void> {
    if (!session || (e.target as HTMLElement).closest('input, textarea')) return;
    const tools = models(session).tools;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text && (await tools.paste(text, session.view.page)) > 0) return void e.preventDefault();
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    const prepared = await app.guard(async () => services.objects.prepare(new Uint8Array(await file.arrayBuffer())));
    if (!prepared) return;
    session.setMode('edit');
    const w = Math.min(240, prepared.width * 0.75);
    tools.beginPlacement({ kind: 'image', size: { width: w, height: (w * prepared.height) / prepared.width }, make: (rect) => ({ image: { image: prepared.image, rect } }) });
    app.toast('info', { key: 'toast.placeHint' });
  }
  // Drop files anywhere on the window (the desktop shell delivers drops through Rust instead).
  function ondragover(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dropping = true;
  }
  function ondrop(e: DragEvent): void {
    dropping = false;
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    const files = services.platform.files as unknown as { adopt?(f: Iterable<File>): import('@folio/ports').FileRef[] };
    if (files.adopt) void app.openRefs(files.adopt(e.dataTransfer.files));
  }
</script>

<svelte:window {onkeydown} {onpaste} {ondragover} {ondrop} ondragleave={(e) => !e.relatedTarget && (dropping = false)} oncontextmenu={(e) => !(e.target as HTMLElement).closest('input, textarea') && e.preventDefault()} />

{#if !boot.ready}
  <div class="splash" role="status">
    <div class="box">
      <div class="logo">F</div>
      {#if boot.error}
        <b>{t('ui.engineFailed')}</b><code style="font-size:12px;word-break:break-all">{boot.error}</code>
      {:else}
        <span>{t('ui.starting')}</span>
      {/if}
    </div>
  </div>
{:else}
  <div id="app" class:home={!session}>
    <TitleBar />
    {#if session && m}
      {#key session.id}
        <Toolbar {session} />
        <div id="main">
          {#if ui.sidebarOpen && session.mode !== 'organise'}<Sidebar {session} />{/if}
          <div id="canvaswrap">
            {#if banner && banner.kind !== 'none' && bannerOff !== session.id}
              <div id="banner" role="status">
                <Icon name="text-cursor-input" />
                <b>{banner.kind === 'xfa' && banner.count === 0 ? t('banner.xfaOnly') : t('banner.form', { count: banner.count })}</b>
                <span class="grow note">{banner.kind === 'xfa' ? t('banner.xfa') : t('banner.formHint')}</span>
                {#if banner.count > 0}
                  <button class="btn sm" aria-pressed={m.form.highlight} onclick={() => m.form.toggleHighlight()}><Icon name="scan-line" />{t('tool.highlightFields')}</button>
                  <button class="btn sm primary" onclick={() => (!ui.inspectorOpen && ui.toggleInspector(), void m.smart.start())}><Icon name="sparkles" />{t('banner.autoFill')}</button>
                {/if}
                <button class="ib" onclick={() => (bannerOff = session.id)} aria-label={t('action.dismiss')}><Icon name="x" /></button>
              </div>
            {/if}
            {#if scanBanner && ocrBannerOff !== session.id}
              <div id="ocrbanner" role="status">
                <Icon name="scan-text" />
                <b>{t('ocr.banner')}</b>
                <span class="grow"></span>
                <button class="btn sm primary" onclick={() => ui.openDialog('ocr')}>{t('ocr.bannerAction')}</button>
                <button class="ib" onclick={() => (ocrBannerOff = session.id)} aria-label={t('action.dismiss')}><Icon name="x" /></button>
              </div>
            {/if}
            <FindBar {session} />
            {#if session.mode === 'organise'}<Organise {session} />{:else}<Canvas {session} />{/if}
          </div>
          {#if ui.inspectorOpen}<Inspector {session} />{/if}
        </div>
        <StatusBar {session} />
      {/key}
    {:else}
      <Home />
    {/if}
  </div>

  {#if dialog === 'merge'}<MergeDialog />
  {:else if dialog === 'split' && session}<SplitDialog {session} />
  {:else if dialog === 'images'}<ImagesDialog />
  {:else if dialog === 'exportImages' && session}<ExportDialog {session} />
  {:else if dialog === 'compress' && session}<CompressDialog {session} />
  {:else if dialog === 'digitalSign' && session}<DigitalSignDialog {session} />
  {:else if dialog === 'signatures' && session}<SignaturesDialog {session} />
  {:else if dialog === 'ocr' && session}<OcrDialog {session} />
  {:else if (dialog === 'tables' || tablesOpen) && session}<TablesDialog {session} />
  {:else if dialog === 'aiDebug'}<AiDebugDialog />
  {:else if dialog === 'signature'}<SignatureDialog />
  {:else if dialog === 'stampEditor'}<StampsDialog />
  {:else if (dialog === 'properties' || dialog === 'metadata') && session}<PropertiesDialog {session} />
  {:else if dialog === 'settings' || dialog === 'profiles' || dialog === 'privacy' || dialog === 'about'}<SettingsDialog initial={dialog} />
  {:else}<SmallDialogs {session} />{/if}
  {#if ui.palette}<Palette />{/if}
  {#if note}
    <Dialog title={t('cmd.sign')} width={420} onclose={() => sign.dismissNote()}>
      <div class="callout info"><Icon name="info" /><span>{t('sign.note')}</span></div>
      {#snippet footer()}<button class="btn primary" data-autofocus onclick={() => sign.dismissNote()}>{t('sign.noteOk')}</button>{/snippet}
    </Dialog>
  {/if}
  <PromptHost />
  <Coach />
  <Toasts />
  {#if dropping}<div class="dropveil">{t('ui.dropHere')}</div>{/if}
{/if}
<span hidden>{themeFilter('normal')}{tm({ key: 'app.name' })}</span>
