<script lang="ts">
  import { untrack } from 'svelte';
  import type { DocumentSession } from '@folio/app';
  import { formatPageRanges } from '@folio/core';
  import { exportPixelSize } from '@folio/services';
  import { t } from '#lib/i18n/index.ts';
  import { track, ui, wizards } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';

  let { session }: { session: DocumentSession } = $props();
  // svelte-ignore state_referenced_locally
  const w = wizards.exportImages(session);
  const v = $derived(track());
  // svelte-ignore state_referenced_locally
  const selected = session.selection.kind === 'pages' ? session.selection.pages : [];
  let which = $state<'all' | 'current' | 'selected' | 'range'>('all');
  let range = $state('');
  let px = $state({ width: 0, height: 0 });
  const current = $derived(session.view.page);
  $effect(() => {
    const r = which === 'all' ? '' : which === 'current' ? String(current + 1) : which === 'selected' ? formatPageRanges(selected) : range;
    untrack(() => w.set({ range: r }));
  });
  $effect(() => {
    void v;
    const dpi = w.dpi;
    untrack(() => void exportPixelSize(session.doc, current, dpi).then((s) => (px = s)));
  });
  async function go(): Promise<void> {
    if ((await w.run()) > 0) ui.closeDialog();
  }
</script>

<Dialog title={t('export.title')} width={520} onclose={() => ui.closeDialog()}>
  <div class="field">
    <span class="lab">{t('export.pages')}</span>
    <div class="radios" style="flex-direction:row;flex-wrap:wrap" role="radiogroup">
      <label><input type="radio" name="ep" bind:group={which} value="all" />{t('export.all', { count: session.pageCount })}</label>
      <label><input type="radio" name="ep" bind:group={which} value="current" />{t('export.current')}</label>
      {#if selected.length}<label><input type="radio" name="ep" bind:group={which} value="selected" />{t('export.selected', { count: selected.length })}</label>{/if}
      <label><input type="radio" name="ep" bind:group={which} value="range" />{t('export.range')}</label>
    </div>
    {#if which === 'range'}<input type="text" bind:value={range} placeholder="1-3,7" aria-label={t('export.range')} aria-invalid={!w.rangeValid} style={w.rangeValid ? '' : 'border-color:var(--color-danger)'} />{/if}
  </div>
  <div class="g2">
    <div class="field"><label for="exf">{t('export.format')}</label><select id="exf" value={w.format} onchange={(e) => w.set({ format: e.currentTarget.value as 'png' })}>{#each w.formats as f (f)}<option value={f}>{f.toUpperCase()}</option>{/each}</select></div>
    <div class="field"><label for="exd">{t('export.resolution')}</label><select id="exd" value={String(w.dpi)} onchange={(e) => w.set({ dpi: Number(e.currentTarget.value) })}>{#each [72, 96, 150, 200, 300, 600] as d (d)}<option value={String(d)}>{t('export.dpi', { dpi: d })}</option>{/each}</select><span class="hint">{t('export.size', px)}</span></div>
  </div>
  <div class="field"><label for="exq">{t('export.quality')}</label><input id="exq" type="range" min="10" max="100" value={Math.round(w.quality * 100)} disabled={w.format === 'png'} oninput={(e) => w.set({ quality: Number(e.currentTarget.value) / 100 })} /><span class="hint">{t('export.qualityHint')}</span></div>
  <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" checked={w.asZip} onchange={(e) => w.set({ asZip: e.currentTarget.checked })} />{t('export.zip')}</label>
  {#if w.busy}<div class="progress" role="progressbar" aria-valuenow={Math.round(w.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style="width:{w.progress * 100}%"></i></div>{/if}
  {#snippet footer()}
    <button class="btn" onclick={() => ui.closeDialog()}>{t('action.cancel')}</button>
    <button class="btn primary" disabled={!w.rangeValid || w.busy} onclick={go}>{w.busy ? t('export.exporting') : t('export.run')}</button>
  {/snippet}
</Dialog>
