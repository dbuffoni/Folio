<script lang="ts">
  import type { DocumentSession } from '@folio/app';
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, models, track } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';

  let { session }: { session: DocumentSession } = $props();
  const m = $derived(models(session));
  const v = $derived(track());
  const author = $derived(dep(v, m.author));
  const field = $derived(dep(v, author.field));
  const proposals = $derived(dep(v, author.proposals));
  const accepted = $derived(proposals.filter((p) => p.accepted).length);
  const compatible = $derived(dep(v, author.compatible));
  let optionsText = $state('');
  $effect(() => {
    const f = field;
    optionsText = (f?.options ?? []).map((o) => o.label).join('\n');
  });
  const isChoice = $derived(field?.type === 'dropdown' || field?.type === 'listbox');
  const label = (id: string): string => t(`author.convert.${id}`);
  async function convert(kind: string): Promise<void> {
    if (kind === 'multiline') await author.update({ multiline: true });
    else if (kind === 'singleline') await author.update({ multiline: false });
    else if (kind === 'listbox') await author.update({ listbox: true });
    else if (kind === 'dropdown') await author.update({ listbox: false });
  }
  async function commitOptions(): Promise<void> {
    const labels = optionsText.split('\n').map((s) => s.trim()).filter(Boolean);
    await author.update({ options: labels.map((l) => ({ label: l, value: l })) });
  }
</script>

<div class="ins-h"><Icon name="pencil-ruler" /><span class="grow">{t('author.title')}</span><button class="ib" onclick={() => author.toggle()} aria-label={t('action.close')}><Icon name="x" /></button></div>

{#if author.notice}
  <div class="ins-s"><div class="callout"><Icon name="info" /><span>{t(`author.notice.${author.notice}`)}</span></div></div>
{/if}

{#if proposals.length}
  <div class="ins-s" style="gap:0" data-testid="proposals">
    <div class="kv" style="padding-bottom:6px"><span>{t('author.proposals', { count: proposals.length })}</span>
      <button class="link" onclick={() => author.acceptAll(accepted < proposals.length)}>{accepted < proposals.length ? t('author.selectAll') : t('author.selectNone')}</button></div>
    {#each proposals as p (p.id)}
      <label class="sfitem" style="grid-template-columns:auto 1fr">
        <input type="checkbox" checked={p.accepted} onchange={(e) => author.toggleProposal(p.id, e.currentTarget.checked)} />
        <span class="l"><span class="conf {p.confidence >= 0.85 ? 'h' : p.confidence >= 0.6 ? 'm' : 'l'}"></span>{p.label ?? t(`author.type.${p.type}`)} · {t(`author.type.${p.type}`)}{p.source === 'ai' ? ' · AI' : ''}</span>
      </label>
    {/each}
    <div class="row" style="margin-top:8px">
      <button class="btn primary" disabled={accepted === 0} onclick={() => author.createProposals()}>{t('author.createN', { count: accepted })}</button>
      <button class="btn" onclick={() => author.cancelProposals()}>{t('action.cancel')}</button>
    </div>
  </div>
{/if}

{#if field}
  <div class="ins-s">
    <div class="field"><label for="fa-name">{t('author.name')}</label>
      <input id="fa-name" type="text" value={field.name.split('.').pop()} onchange={(e) => author.rename(e.currentTarget.value)} /></div>
    <div class="field"><label for="fa-tip">{t('author.tooltip')}</label>
      <input id="fa-tip" type="text" value={field.label ?? ''} onchange={(e) => author.update({ tooltip: e.currentTarget.value })} /></div>
    <div class="kv"><span>{t('author.type')}</span><b>{t(`author.type.${field.type}`)}{field.multiline ? ` · ${t('author.type.multiline')}` : ''}</b></div>
    {#each compatible as c (c)}
      <button class="btn sm" onclick={() => convert(c)}>{label(c)}</button>
    {/each}
    <label class="row"><input type="checkbox" checked={field.required} onchange={(e) => author.update({ required: e.currentTarget.checked })} />{t('author.required')}</label>
    <label class="row"><input type="checkbox" checked={field.readOnly && field.type !== 'signature' && field.type !== 'button'} onchange={(e) => author.update({ readOnly: e.currentTarget.checked })} />{t('author.readOnly')}</label>
    {#if field.type === 'text'}
      <div class="field"><label for="fa-max">{t('author.maxLength')}</label>
        <input id="fa-max" type="number" min="1" value={field.maxLength ?? ''} onchange={(e) => author.update({ maxLength: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })} /></div>
    {/if}
    {#if isChoice}
      <div class="field"><label for="fa-opt">{t('author.options')}</label>
        <textarea id="fa-opt" rows="4" bind:value={optionsText} onchange={commitOptions}></textarea>
        <span class="hint">{t('author.optionsHint')}</span></div>
    {/if}
    <div class="row"><button class="btn danger" onclick={() => author.remove()}><Icon name="trash-2" />{t('action.delete')}</button></div>
  </div>
{:else if proposals.length === 0}
  <div class="ins-s"><p class="note">{t('author.hint')}</p><p class="note">{t('author.keys')}</p></div>
{/if}
{#if session.meta.hasSignatures}<div class="ins-s"><div class="callout"><Icon name="triangle-alert" /><span>{t('banner.signed')}</span></div></div>{/if}
<span hidden>{app.settings.theme}</span>
