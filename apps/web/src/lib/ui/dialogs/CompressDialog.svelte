<script lang="ts">
  import { untrack } from 'svelte';
  import type { DocumentSession } from '@folio/app';
  import { formatBytes } from '@folio/core';
  import { t } from '#lib/i18n/index.ts';
  import { dep, track, ui, wizards } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  let { session }: { session: DocumentSession } = $props();
  // svelte-ignore state_referenced_locally
  const w = wizards.compress(session);
  const v = $derived(track());
  const PRESETS = ['light', 'balanced', 'strong', 'custom'] as const;
  $effect(() => {
    untrack(() => void w.start());
    return () => w.cancel();
  });
  const est = (p: (typeof PRESETS)[number]): string => {
    const n = w.estimates[p];
    return n === undefined ? t('compress.measuring') : t('compress.estimate', { size: formatBytes(n) });
  };
  async function go(): Promise<void> {
    if (await w.run()) ui.closeDialog();
  }
</script>

<Dialog title={t('compress.title')} width={560} onclose={() => ui.closeDialog()}>
  <p style="margin:0">{t('compress.current', { size: formatBytes(dep(v, w.size)) })}</p>
  {#if w.signed}<div class="callout warn"><Icon name="triangle-alert" /><span>{t('compress.signed')}</span></div>{/if}
  {#if w.encrypted}<div class="callout info"><Icon name="lock" /><span>{t('compress.encrypted')}</span></div>{/if}
  <div class="radios" role="radiogroup" aria-label={t('compress.title')}>
    {#each PRESETS as p (p)}
      <label><input type="radio" name="cp" checked={dep(v, w.preset) === p} disabled={w.stage === 'running' || w.stage === 'analysing'} onchange={() => w.setPreset(p)} />
        <div><b>{t(`compress.preset.${p}`)}</b><small>{t(`compress.preset.${p}.d`)}{#if !(p === 'custom' && w.preset !== 'custom')} · <span data-testid="estimate-{p}">{est(p)}</span>{/if}</small></div>
      </label>
    {/each}
  </div>
  {#if w.preset === 'custom'}
    <div class="g2">
      <div class="field"><label for="cdc">{t('compress.colorDpi')}</label><input id="cdc" type="number" min="36" max="600" value={w.custom.colorDpi} onchange={(e) => w.setCustom({ colorDpi: Number(e.currentTarget.value) })} /></div>
      <div class="field"><label for="cdg">{t('compress.grayDpi')}</label><input id="cdg" type="number" min="36" max="600" value={w.custom.grayDpi} onchange={(e) => w.setCustom({ grayDpi: Number(e.currentTarget.value) })} /></div>
    </div>
    <div class="field"><label for="cjq">{t('compress.quality')}</label><input id="cjq" type="range" min="30" max="95" value={Math.round(w.custom.jpegQuality * 100)} oninput={(e) => w.setCustom({ jpegQuality: Number(e.currentTarget.value) / 100 })} /></div>
  {/if}
  <div class="field"><span class="lab">{t('compress.save')}</span>
    <div class="radios" role="radiogroup" aria-label={t('compress.save')}>
      <label><input type="radio" name="ct" checked={w.target === 'copy'} onchange={() => w.setTarget('copy')} />{t('compress.copy')}</label>
      <label><input type="radio" name="ct" checked={w.target === 'replace'} disabled={!w.canReplace} onchange={() => w.setTarget('replace')} />{t('compress.replace')}</label>
    </div>
  </div>
  <p class="note">{t('compress.hint')}</p>
  {#if w.stage === 'running'}<div class="progress" role="progressbar" aria-valuenow={Math.round(w.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style="width:{w.progress * 100}%"></i></div>{/if}
  {#snippet footer()}
    <button class="btn" onclick={() => (w.cancel(), ui.closeDialog())}>{t('action.cancel')}</button>
    <button class="btn primary" disabled={w.stage !== 'ready'} onclick={go}>{w.stage === 'running' ? t('compress.running') : t('compress.run')}</button>
  {/snippet}
</Dialog>
