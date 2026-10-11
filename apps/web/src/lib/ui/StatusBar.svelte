<script lang="ts">
  import { formatChord, parsePageJump, stepZoom, type DocumentSession } from '@folio/app';
  import { formatBytes } from '@folio/core';
  import { t } from '#lib/i18n/index.ts';
  import { dep, isMac, track, ui } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import Menu, { type MenuItem } from './Menu.svelte';
  import { tip } from './tip.ts';

  let { session }: { session: DocumentSession } = $props();
  const view = $derived(dep(track(), session.view));
  const dirty = $derived(dep(track(), session.dirty));
  const count = $derived(dep(track(), session.pageCount));
  let pageText = $state('1');
  const currentPage = $derived(view.page);
  $effect(() => {
    pageText = String(currentPage + 1);
  });
  let menu = $state<{ x: number; y: number } | null>(null);
  const k = (s: string): string => formatChord(s, isMac);
  const zoomItems = $derived.by((): MenuItem[] => [
    { icon: 'move-horizontal', label: t('cmd.fitWidth'), shortcut: k('Mod+0'), checked: view.zoomMode === 'fit-width', run: () => session.setZoom('fit-width') },
    { icon: 'maximize', label: t('cmd.fitPage'), checked: view.zoomMode === 'fit-page', run: () => session.setZoom('fit-page') },
    { icon: 'scan', label: t('cmd.actualSize'), shortcut: k('Mod+1'), checked: view.zoomMode === 'actual', run: () => session.setZoom('actual', 1) },
    { kind: 'sep' },
    ...[50, 75, 125, 150, 200, 400].map((z): MenuItem => ({ icon: 'search', label: `${z}%`, run: () => session.setZoom('custom', z / 100) })),
  ]);
  function jump(): void {
    const p = parsePageJump(pageText, count);
    if (p === null) pageText = String(view.page + 1);
    else session.goToPage(p);
  }
</script>

<footer id="statusbar">
  <button class="ib" class:on={ui.sidebarOpen} onclick={() => ui.toggleSidebar()} use:tip={[t('cmd.toggleSidebar'), 'F4']} aria-label={t('cmd.toggleSidebar')} aria-pressed={ui.sidebarOpen}><Icon name="panel-left" /></button>
  <button class="ib" disabled={view.page === 0} onclick={() => session.goToPage(view.page - 1)} aria-label={t('ui.prevPage')}><Icon name="chevron-left" /></button>
  <span>{t('ui.page')}</span>
  <input type="text" inputmode="numeric" bind:value={pageText} onchange={jump} onkeydown={(e) => e.key === 'Enter' && (jump(), e.currentTarget.blur())} aria-label={t('ui.pageNumber')} />
  <span>{t('ui.pageOf', { count })}</span>
  <button class="ib" disabled={view.page >= count - 1} onclick={() => session.goToPage(view.page + 1)} aria-label={t('ui.nextPage')}><Icon name="chevron-right" /></button>
  <span class="vsep"></span>
  <button class="ib" onclick={() => session.setZoom('custom', stepZoom(view.zoom, -1))} use:tip={[t('cmd.zoomOut'), k('Mod+-')]} aria-label={t('cmd.zoomOut')}><Icon name="minus" /></button>
  <button class="btn ghost sm" style="min-width:74px;justify-content:center" aria-haspopup="menu" aria-label={t('ui.zoom')} onclick={(e) => ((menu = { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().top - 300 }))}>
    {view.zoomMode === 'fit-width' || view.zoomMode === 'fit-page' ? `${t('ui.fit')} ` : ''}{Math.round(view.zoom * 100)}%
  </button>
  <button class="ib" onclick={() => session.setZoom('custom', stepZoom(view.zoom, 1))} use:tip={[t('cmd.zoomIn'), k('Mod+=')]} aria-label={t('cmd.zoomIn')}><Icon name="plus" /></button>
  <span class="vsep"></span>
  <button class="ib" onclick={() => session.rotateView(270)} use:tip={t('ui.rotateLeft')} aria-label={t('ui.rotateLeft')}><Icon name="rotate-ccw" /></button>
  <button class="ib" onclick={() => session.rotateView(90)} use:tip={[t('ui.rotateRight'), k('Mod+Shift+R')]} aria-label={t('ui.rotateRight')}><Icon name="rotate-cw" /></button>
  <span class="st" role="status"><i class="dotok" class:dotun={dirty} style="display:inline-block"></i><span>{dirty ? t('ui.unsaved') : t('ui.saved')}{session.byteSize ? ` · ${formatBytes(session.byteSize)}` : ''}</span></span>
  <button class="ib" class:on={ui.inspectorOpen} onclick={() => ui.toggleInspector()} use:tip={[t('cmd.toggleInspector'), 'F5']} aria-label={t('cmd.toggleInspector')} aria-pressed={ui.inspectorOpen}><Icon name="panel-right" /></button>
</footer>
{#if menu}<Menu items={zoomItems} anchor={menu} onclose={() => (menu = null)} />{/if}
