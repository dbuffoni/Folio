<script lang="ts">
  import type { DocumentSession } from '@folio/app';
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, models, track, ui } from '#lib/state.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import { tip } from './tip.ts';

  let { session }: { session: DocumentSession } = $props();
  const sf = $derived(dep(track(), models(session).smart));
  const v = $derived(track());
  const stage = $derived(dep(v, sf.stage));
  const list = $derived(dep(v, sf.suggestions));
  const ai = $derived(dep(v, app.settings.ai));
  let dontAsk = $state(false);
  let adding = $state<{ ref: string; label: string; value: string } | null>(null);
  const host = $derived.by(() => {
    try {
      return new URL(ai.baseUrl).host;
    } catch {
      return ai.baseUrl;
    }
  });
  const conf = { high: 'h', medium: 'm', low: 'l' } as const;
</script>

<div class="ins-h"><Icon name="sparkles" /><span class="grow">{t('smartfill.title')}</span><button class="ib" onclick={() => sf.cancel()} aria-label={t('action.close')}><Icon name="x" /></button></div>
<div class="ins-s">
  <div class="row"><label for="sfp" style="width:auto">{t('smartfill.profile')}</label>
    <select id="sfp" value={sf.profile?.id} onchange={(e) => (sf.setProfile(e.currentTarget.value), void sf.analyse(false))}>
      {#each sf.profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
    </select>
  </div>
  <div class="row" role="radiogroup" aria-label={t('export.pages')}>
    <label style="width:auto"><input type="radio" name="sfs" checked={sf.scope === 'current'} onchange={() => (sf.setScope('current'), void sf.analyse(false))} /> {t('smartfill.scope.current')}</label>
    <label style="width:auto"><input type="radio" name="sfs" checked={sf.scope === 'all'} onchange={() => (sf.setScope('all'), void sf.analyse(false))} /> {t('smartfill.scope.all')}</label>
  </div>
  {#if sf.result}
    <div class="callout info"><Icon name="shield-check" /><span>{t(sf.result.source === 'heuristic' && sf.result.fallbackReason && !['notConfigured', 'offline'].includes(sf.result.fallbackReason) ? 'smartfill.source.afterRequest' : `smartfill.source.${sf.result.source}`)} {#if sf.result.source === 'ai'}{t(ai.mode === 'mapping_only' ? 'smartfill.privacy.mapping' : 'smartfill.privacy.values')}{/if} <button class="link" onclick={() => ui.openDialog('settings')}>{t('smartfill.change')}</button></span></div>
  {/if}
</div>
{#if stage === 'analysing'}
  <div class="ins-s"><p class="note" role="status">{t('smartfill.analysing')}</p><div class="progress"><i style="width:60%"></i></div></div>
{:else if stage === 'empty'}
  <div class="ins-s"><p class="note">{t('smartfill.empty')}</p></div>
{:else if stage === 'review'}
  <div class="ins-s" style="gap:0">
    <div class="kv" style="padding-bottom:6px"><span>{t('smartfill.found', { count: list.length })}</span><span class="note">{t('smartfill.legend')}</span></div>
    {#each list as s (s.ref)}
      <div class="sfitem">
        <input type="checkbox" checked={s.accepted} disabled={s.value === ''} aria-label={s.label} onchange={(e) => sf.toggle(s.ref, e.currentTarget.checked)} />
        <div class="l">
          <span class="conf {conf[s.confidence]}" title={s.confidence}></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{s.label}</span>{s.confidence === 'low' && s.profileKey ? ` · ${t('smartfill.review')}` : ''}
          <span class="grow"></span>
          <button class="link" onclick={() => sf.locate(sf.located === s.ref ? null : s.ref)} use:tip={t('smartfill.locate')} aria-label={t('smartfill.locate')}><Icon name="locate-fixed" size={14} /></button>
        </div>
        {#if s.fieldType === 'checkbox'}
          <select style="grid-column:2;height:28px" value={s.value} aria-label={s.label} onchange={(e) => sf.setValue(s.ref, e.currentTarget.value)}><option value="">—</option><option value="true">✓</option><option value="false">✗</option></select>
        {:else if s.candidate.options?.length}
          <select style="grid-column:2;height:28px" value={s.value} aria-label={s.label} onchange={(e) => sf.setValue(s.ref, e.currentTarget.value)}><option value="">—</option>{#each s.candidate.options as o (o)}<option value={o}>{o}</option>{/each}</select>
        {:else}
          <input type="text" value={s.value} aria-label={s.label} placeholder={t('smartfill.noMatch')} onchange={(e) => sf.setValue(s.ref, e.currentTarget.value)} />
        {/if}
        <div style="grid-column:2;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <select style="height:24px;font-size:12px;flex:1 1 120px;min-width:0" value={s.profileKey ?? ''} aria-label={t('smartfill.key')} onchange={(e) => sf.setKey(s.ref, e.currentTarget.value || null)}>
            <option value="">{t('smartfill.noMatch')}</option>
            {#each sf.profile?.fields ?? [] as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
          </select>
          {#if !s.profileKey}<button class="link" style="font-size:12px;white-space:nowrap" onclick={() => (adding = { ref: s.ref, label: s.label, value: s.value })}>{t('smartfill.addToProfile')}</button>{/if}
        </div>
      </div>
    {/each}
  </div>
  {#if !sf.signWith}
    <div class="ins-s"><p class="note">{t('smartfill.sign.none')}</p></div>
  {:else if sf.signFields === 0}
    <div class="ins-s"><p class="note">{t('smartfill.sign.noLine')}</p></div>
  {/if}
  {#if sf.signWith}
    <div class="ins-s"><label style="display:flex;gap:8px;align-items:center;width:auto"><input type="checkbox" checked={sf.signIt} onchange={(e) => sf.setSignIt(e.currentTarget.checked)} />{t('smartfill.sign', { count: sf.signFields, name: sf.signWith.name })}</label>
      {#if sf.signIt && sf.dateLines > 0}<p class="note" style="margin:4px 0 0">{t('smartfill.signDates', { count: sf.dateLines })}</p>{/if}</div>
  {/if}
  <div class="ins-s">
    <button class="btn primary" disabled={sf.acceptedCount === 0 && !(sf.signIt && sf.signWith)} onclick={() => sf.apply(false)}>{t('smartfill.applySelected', { count: sf.acceptedCount })}</button>
    <button class="btn" onclick={() => sf.apply(true)}>{t('smartfill.applyHigh')}</button>
    <button class="btn ghost" onclick={() => sf.analyse(true)}><Icon name="refresh-cw" />{t('smartfill.reanalyse')}</button>
    <button class="btn ghost" onclick={() => sf.cancel()}>{t('action.cancel')}</button>
  </div>
{/if}

{#if stage === 'preflight' && sf.preflight}
  {@const p = sf.preflight}
  <Dialog title={t('smartfill.preflight.title')} width={520} onclose={() => sf.cancel()}>
    <p style="margin:0">{p.destination?.local ? t('smartfill.preflight.introLocal', { host: p.destination.host }) : t('smartfill.preflight.intro', { host })}</p>
    <ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px">
      <li>{t('smartfill.preflight.pages')}: {p.pages.join(', ')}</li>
      <li>{t('smartfill.preflight.fields', { count: p.candidateCount, examples: p.sampleLabels.slice(0, 4).join(', ') || '—' })}</li>
      <li>{t('smartfill.preflight.text', { count: p.textLineCount })}</li>
      <li>{t('smartfill.preflight.keys', { count: p.keyCount })}</li>
      <li><b>{p.valueKeys.length ? t('smartfill.preflight.values', { keys: p.valueKeys.join(', ') }) : t('smartfill.preflight.noValues')}</b></li>
      {#if p.withheldKeys.length}<li>{t('smartfill.preflight.withheld', { keys: p.withheldKeys.join(', ') })}</li>{/if}
      {#if p.includesImage}<li>{t('smartfill.preflight.image')}</li>{/if}
    </ul>
    <p class="note">{t('smartfill.preflight.tokens', { count: p.estimatedTokens })}</p>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" bind:checked={dontAsk} />{t('smartfill.preflight.dontAsk')}</label>
    {#snippet footer()}
      <button class="btn" onclick={() => sf.cancel()}>{t('action.cancel')}</button>
      <button class="btn primary" data-autofocus onclick={() => sf.confirmPreflight(dontAsk)}>{t('smartfill.preflight.send')}</button>
    {/snippet}
  </Dialog>
{/if}
{#if adding}
  {@const a = adding}
  <Dialog title={t('smartfill.addToProfile')} width={420} onclose={() => (adding = null)}>
    <div class="field"><label for="nl">{t('smartfill.newKeyLabel')}</label><input id="nl" type="text" bind:value={a.label} /></div>
    <div class="field"><label for="nv">{t('smartfill.newKeyValue')}</label><input id="nv" type="text" bind:value={a.value} data-autofocus /></div>
    {#snippet footer()}
      <button class="btn" onclick={() => (adding = null)}>{t('action.cancel')}</button>
      <button class="btn primary" disabled={!a.label.trim() || !a.value} onclick={() => (void sf.addToProfile(a.ref, a.label, a.label, a.value), (adding = null))}>{t('action.add')}</button>
    {/snippet}
  </Dialog>
{/if}
