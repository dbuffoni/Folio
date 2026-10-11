<script lang="ts">
  import type { DocumentSession } from '@folio/app';
  import { describePageSize } from '@folio/core';
  import { t } from '#lib/i18n/index.ts';
  import { dep, models, run, track, ui } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import Menu, { type MenuItem } from './Menu.svelte';
  import Thumb from './Thumb.svelte';
  import { tip } from './tip.ts';

  let { session }: { session: DocumentSession } = $props();
  const org = $derived(models(session).organise);
  const v = $derived(track());
  const selected = $derived(dep(v, org.selected));
  const count = $derived(dep(v, session.pageCount));
  const sv = $derived(dep(v, session.structureVersion));
  const size = $derived(dep(v, org.thumbSize));
  const dropBefore = $derived(dep(v, org.dropBefore));
  const mixed = $derived(dep(v, new Set(session.pageInfos.map((p) => `${Math.round(p.size.width)}x${Math.round(p.size.height)}`)).size > 1));
  let dragging = $state<number | null>(null);
  let menu = $state<{ x: number; y: number; page: number } | null>(null);
  let grid: HTMLDivElement | undefined = $state();
  let band = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const sizeLabel = (i: number): string => {
    const s = session.pageInfos[i]?.size;
    if (!s) return '';
    const d = describePageSize(s);
    return d.name ?? `${Math.round(s.width / 2.835)}×${Math.round(s.height / 2.835)} mm`;
  };
  function ondragover(e: DragEvent, i: number): void {
    if (dragging === null) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    org.dragOver(e.clientX > r.left + r.width / 2 ? i + 1 : i);
  }
  function ondrop(e: DragEvent): void {
    e.preventDefault();
    if (dragging !== null && org.dropBefore !== null) void org.drop(dragging, org.dropBefore);
    dragging = null;
  }
  function context(e: MouseEvent, page: number): void {
    e.preventDefault();
    if (!selected.includes(page)) org.click(page);
    menu = { x: e.clientX, y: e.clientY, page };
  }
  const items = $derived.by((): MenuItem[] => [
    { icon: 'rotate-cw', label: t('ui.rotate'), shortcut: 'R', run: () => void org.rotate(90) },
    { icon: 'rotate-ccw', label: t('cmd.rotateCcw'), shortcut: 'Shift+R', run: () => void org.rotate(270) },
    { icon: 'trash-2', label: t('action.delete'), shortcut: 'Del', danger: true, run: () => void org.delete() },
    { icon: 'copy', label: t('cmd.duplicate'), run: () => void org.duplicate() },
    { icon: 'file-output', label: t('ui.extractNew'), run: () => void org.extract(false) },
    { icon: 'file-output', label: t('ui.extractRemove'), run: () => void org.extract(true) },
    { kind: 'sep' },
    { icon: 'file-plus', label: t('ui.blankBefore'), run: () => void org.insertBlank('before') },
    { icon: 'file-plus', label: t('ui.blankAfter'), run: () => void org.insertBlank('after') },
    { icon: 'file-input', label: t('cmd.insertFromFile'), run: () => void run('pages.insertFile') },
    { icon: 'replace', label: t('cmd.replacePages'), run: () => void run('pages.replace') },
  ]);
  // Rubber-band selection on the empty part of the grid.
  function bandStart(e: PointerEvent): void {
    if (e.target !== grid || e.button !== 0) return;
    grid!.setPointerCapture(e.pointerId);
    band = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
  }
  function bandMove(e: PointerEvent): void {
    if (!band) return;
    band = { ...band, x1: e.clientX, y1: e.clientY };
    const [l, r, tp, b] = [Math.min(band.x0, band.x1), Math.max(band.x0, band.x1), Math.min(band.y0, band.y1), Math.max(band.y0, band.y1)];
    const hit: number[] = [];
    grid!.querySelectorAll<HTMLElement>('.ocard').forEach((el) => {
      const c = el.getBoundingClientRect();
      if (c.left < r && c.right > l && c.top < b && c.bottom > tp) hit.push(Number(el.dataset.page));
    });
    org.selectBand(hit);
  }
  function onkeydown(e: KeyboardEvent, i: number): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      org.click(i, { shift: e.shiftKey, mod: e.ctrlKey || e.metaKey });
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (e.altKey) return; // Alt+Arrow reorders (handled as a shortcut)
      e.preventDefault();
      const next = Math.max(0, Math.min(count - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
      org.click(next, { shift: e.shiftKey });
      grid?.querySelector<HTMLElement>(`[data-page="${next}"] .op`)?.focus();
    }
  }
</script>

<div class="row" style="padding:8px 14px;background:var(--color-surface);border-bottom:1px solid var(--color-border);gap:10px">
  <Icon name="layout-grid" /><label for="tsz" class="note" style="width:auto">{t('ui.thumbSize')}</label>
  <input id="tsz" type="range" min="90" max="320" value={size} oninput={(e) => org.setThumbSize(Number(e.currentTarget.value))} style="max-width:180px;flex:none" />
  <span class="grow"></span>
  <button class="btn ghost sm" onclick={() => org.selectOdd()}>{t('cmd.selectOdd')}</button>
  <button class="btn ghost sm" onclick={() => org.selectEven()}>{t('cmd.selectEven')}</button>
  <button class="btn ghost sm" onclick={() => org.selectNone()}>{t('cmd.selectNone')}</button>
</div>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div id="orggrid" bind:this={grid} style="grid-template-columns:repeat(auto-fill,minmax({size + 18}px,1fr));position:relative" onpointerdown={bandStart} onpointermove={bandMove} onpointerup={() => (band = null)} ondragover={(e) => dragging !== null && e.preventDefault()} {ondrop}>
  {#each { length: count } as _, i (`${sv}-${i}`)}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="ocard"
      class:sel={selected.includes(i)}
      class:ins={dropBefore === i}
      class:insafter={dropBefore === count && i === count - 1}
      class:drag={dragging !== null && (dragging === i || (selected.includes(dragging) && selected.includes(i)))}
      data-page={i}
      role="group"
      aria-label="{t('ui.page')} {i + 1}"
      draggable="true"
      onclick={(e) => org.click(i, { shift: e.shiftKey, mod: e.ctrlKey || e.metaKey })}
      oncontextmenu={(e) => context(e, i)}
      onkeydown={(e) => onkeydown(e, i)}
      ondragstart={(e) => ((dragging = i), e.dataTransfer?.setData('text/plain', String(i)))}
      ondragend={() => ((dragging = null), org.dragOver(null))}
      ondragover={(e) => ondragover(e, i)}
    >
      <span class="chk"><Icon name="check" /></span>
      {#if mixed}<span class="chip badge">{sizeLabel(i)}</span>{/if}
      <button class="op" aria-pressed={selected.includes(i)} aria-label="{t('ui.page')} {i + 1}"><Thumb {session} page={i} width={size} version={sv} /></button>
      <div class="mab">
        <button class="ib" onclick={(e) => (e.stopPropagation(), void org.rotate(270, i))} use:tip={t('cmd.rotateCcw')} aria-label={t('cmd.rotateCcw')}><Icon name="rotate-ccw" /></button>
        <button class="ib" onclick={(e) => (e.stopPropagation(), void org.rotate(90, i))} use:tip={t('cmd.rotateCw')} aria-label={t('cmd.rotateCw')}><Icon name="rotate-cw" /></button>
        <button class="ib" onclick={(e) => (e.stopPropagation(), void org.duplicate(i))} use:tip={t('cmd.duplicate')} aria-label={t('cmd.duplicate')}><Icon name="copy" /></button>
        <button class="ib" onclick={(e) => (e.stopPropagation(), void org.delete(i))} use:tip={t('action.delete')} aria-label={t('action.delete')}><Icon name="trash-2" /></button>
      </div>
      <div class="num">{session.pageInfos[i]?.label ?? i + 1}</div>
    </div>
  {/each}
  {#if band}
    {@const g = grid!.getBoundingClientRect()}
    <div class="band" style="left:{Math.min(band.x0, band.x1) - g.left + grid!.scrollLeft}px;top:{Math.min(band.y0, band.y1) - g.top + grid!.scrollTop}px;width:{Math.abs(band.x1 - band.x0)}px;height:{Math.abs(band.y1 - band.y0)}px"></div>
  {/if}
</div>
{#if menu}<Menu {items} anchor={menu} onclose={() => (menu = null)} />{/if}
