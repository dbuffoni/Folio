<script lang="ts">
  import { untrack } from 'svelte';
  import type { DocumentSession } from '@folio/app';
  import { MAX_OCR_LANGUAGES } from '@folio/services';
  import { formatBytes } from '@folio/core';
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, track, ui, wizards } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  let { session }: { session: DocumentSession } = $props();
  // svelte-ignore state_referenced_locally
  const w = wizards.ocr(session);
  const v = $derived(track());
  let aiOk = $state(false);
  $effect(() => {
    untrack(() => void w.start().then(() => w.aiAvailable().then((ok) => (aiOk = ok))));
    return () => w.cancel();
  });
  const stage = $derived(dep(v, w.stage));
  const selected = $derived(session.selection.kind === 'pages' ? session.selection.pages.length : 0);
  const done = $derived(dep(v, w.run?.outcomes.filter((o) => o.status === 'done').length ?? 0));
  const skippedText = $derived(dep(v, w.run?.outcomes.filter((o) => o.status === 'skippedText').length ?? 0));
  const skippedLayer = $derived(dep(v, w.run?.outcomes.filter((o) => o.status === 'skippedLayer').length ?? 0));
  const busy = $derived(stage === 'running' || !!w.downloading);
</script>

<Dialog title={t('ocr.title')} width={560} onclose={() => (w.cancel(), ui.closeDialog())}>
  <p class="note" style="margin:0">{t('ocr.hint')}</p>
  {#if !w.available}<div class="callout warn"><Icon name="triangle-alert" /><span>{t('ocr.unavailable')}</span></div>{/if}

  <div class="field"><span class="lab">{t('export.pages')}</span>
    <div class="radios" role="radiogroup" aria-label={t('export.pages')}>
      <label><input type="radio" name="op" checked={w.scope === 'current'} onchange={() => (w.scope = 'current')} />{t('ocr.pagesCurrent')}</label>
      {#if selected > 0}<label><input type="radio" name="op" checked={w.scope === 'selected'} onchange={() => (w.scope = 'selected')} />{t('ocr.pagesSelected')} ({selected})</label>{/if}
      <label><input type="radio" name="op" checked={w.scope === 'all'} onchange={() => (w.scope = 'all')} />{t('ocr.pagesAll')} ({session.pageCount})</label>
    </div>
  </div>

  <div class="field"><span class="lab">{t('ocr.engine')}</span>
    <div class="radios" role="radiogroup" aria-label={t('ocr.engine')}>
      <label><input type="radio" name="oe" checked={w.engine === 'local'} onchange={() => (w.engine = 'local')} />{t('ocr.engine.local')}</label>
      <label><input type="radio" name="oe" checked={w.engine === 'ai'} disabled={!aiOk} onchange={() => (w.engine = 'ai')} />{t('ocr.engine.ai')}{#if !aiOk}<small>{t('ocr.engine.aiOff')}</small>{/if}</label>
    </div>
  </div>

  {#if w.engine === 'local'}
    <div class="field"><span class="lab">{t('ocr.languages')}</span>
      <div class="radios" role="group" aria-label={t('ocr.languages')}>
        {#each dep(v, w.packs) as p (p.code)}
          {@const on = w.languages.includes(p.code)}
          <label style="display:flex;gap:8px;align-items:center">
            <input type="checkbox" checked={on} disabled={!on && w.languages.length >= MAX_OCR_LANGUAGES} onchange={() => w.toggleLanguage(p.code)} />
            <span style="flex:1">{p.name}{#if on && w.languages.indexOf(p.code) === 0} · <b>1</b>{:else if on} · {w.languages.indexOf(p.code) + 1}{/if}</span>
            <small>{p.bundled ? t('ocr.included') : p.installed ? t('ocr.installed') : formatBytes(p.size)}</small>
            {#if on && w.languages.length > 1}
              <button class="ib" onclick={(e) => (e.preventDefault(), w.moveLanguage(p.code, -1))} aria-label={`${p.name} ↑`}><Icon name="arrow-up" size={14} /></button>
              <button class="ib" onclick={(e) => (e.preventDefault(), w.moveLanguage(p.code, 1))} aria-label={`${p.name} ↓`}><Icon name="arrow-down" size={14} /></button>
            {/if}
            {#if !p.bundled && !p.installed}<button class="btn sm" onclick={(e) => (e.preventDefault(), w.install(p.code))} disabled={busy}>{t('ocr.download')}</button>{/if}
            {#if !p.bundled && p.installed}<button class="btn sm" onclick={(e) => (e.preventDefault(), w.remove(p.code))} disabled={busy}>{t('ocr.remove')}</button>{/if}
          </label>
        {/each}
      </div>
      {#if w.languages.length >= MAX_OCR_LANGUAGES}<span class="hint">{t('ocr.languagesMax')}</span>{/if}
      {#if w.downloading}<div class="progress" role="progressbar" aria-valuenow={Math.round((w.downloading.received / Math.max(1, w.downloading.total)) * 100)} aria-valuemin={0} aria-valuemax={100}><i style="width:{(w.downloading.received / Math.max(1, w.downloading.total)) * 100}%"></i></div>{/if}
    </div>
  {/if}

  <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" bind:checked={w.redo} />{t('ocr.redo')}</label>

  {#if stage === 'running'}<div class="progress" role="progressbar" aria-label={t('ocr.running')} aria-valuenow={Math.round(w.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style="width:{w.progress * 100}%"></i></div>{/if}
  {#if stage === 'done' && w.run}
    <div class="callout info" role="status" data-testid="ocr-result"><Icon name="check" /><span>
      {t(done ? 'toast.ocrDone' : 'toast.ocrNothing', { count: done })}
      {#if skippedText}{t('ocr.result.skippedText', { count: skippedText })}.{/if}
      {#if skippedLayer}{t('ocr.result.skippedLayer', { count: skippedLayer })}.{/if}
    </span></div>
    {#if w.retry.length && aiOk}<button class="btn" onclick={() => w.retryWithAi()}><Icon name="sparkles" />{t('ocr.retryAi', { count: w.retry.length })}</button>{/if}
  {/if}

  {#snippet footer()}
    <button class="btn" onclick={() => (w.cancel(), ui.closeDialog())}>{stage === 'done' ? t('action.close') : t('action.cancel')}</button>
    <button class="btn primary" disabled={busy || (w.engine === 'local' && !w.available)} onclick={() => w.execute()}>{stage === 'running' ? t('ocr.running') : t('ocr.run')}</button>
  {/snippet}
</Dialog>
