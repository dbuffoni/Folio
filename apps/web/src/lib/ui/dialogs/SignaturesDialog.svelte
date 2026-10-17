<script lang="ts">
  import { untrack } from 'svelte';
  import { formatDate } from '@folio/core';
  import type { DocumentSession } from '@folio/app';
  import { t } from '#lib/i18n/index.ts';
  import { app, dep, track, ui, wizards } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  let { session }: { session: DocumentSession } = $props();
  // svelte-ignore state_referenced_locally
  const w = wizards.signatures(session);
  const v = $derived(track());
  $effect(() => {
    untrack(() => void w.validate());
  });
  const when = (iso?: string): string => (iso ? formatDate(new Date(iso), app.settings.dateFormat, 'en') + ' ' + new Date(iso).toISOString().slice(11, 16) + ' UTC' : '—');
  const icon = (s: string): string => (s === 'valid' ? 'shield-check' : s === 'invalid' ? 'shield-x' : 'shield-alert');
  const cur = $derived(dep(v, w.current));
</script>

<Dialog title={t('sigpanel.title')} width={640} onclose={() => ui.closeDialog()}>
  {#if dep(v, w.loading)}
    <p role="status" style="margin:0">{t('sigpanel.checking')}</p>
  {:else if dep(v, w.reports).length === 0}
    <div class="callout info" data-testid="sig-none"><Icon name="info" /><span>{t('sigpanel.none')}</span></div>
  {:else}
    <div class="callout {w.summary === 'valid' ? 'info' : 'warn'}" role="status" data-testid="sig-summary"><Icon name={w.summary === 'valid' ? 'shield-check' : 'triangle-alert'} /><span>{t(`sigpanel.summary.${w.summary}`)}</span></div>
    <ul class="rlist" aria-label={t('sigpanel.list')}>
      {#each dep(v, w.reports) as r (r.index)}
        <li>
          <button class="rowbtn" class:on={w.selected === r.index} aria-pressed={w.selected === r.index} onclick={() => w.select(r.index)}>
            <Icon name={icon(r.status)} /><b>{r.signer?.commonName ?? r.fieldName}</b>
          </button>
          <span class="chip {r.status === 'valid' ? 'ok' : 'warn'}">{t(`sigpanel.status.${r.status}`)}</span>
          <small>{when(r.signingTime)}</small>
        </li>
      {/each}
    </ul>
    {#if cur}
      <dl class="kv" data-testid="sig-detail">
        <dt>{t('sigpanel.integrity')}</dt><dd>{t(`sigpanel.integrity.${cur.integrity}`)}</dd>
        <dt>{t('sigpanel.trust')}</dt><dd>{t(`sigpanel.trustState.${cur.trust}`)}</dd>
        <dt>{t('sigpanel.after')}</dt><dd>{cur.changedAfterSigning ? t('sigpanel.after.changed') : t('sigpanel.after.none')}</dd>
        <dt>{t('sigpanel.revocation')}</dt><dd>{t(`sigpanel.revocationState.${cur.revocation}`)}</dd>
        {#if cur.timestamp}<dt>{t('sigpanel.timestamp')}</dt><dd>{when(cur.timestamp.time)}{cur.timestamp.authority ? ` · ${cur.timestamp.authority}` : ''} · {cur.timestamp.verified ? t('sigpanel.ts.ok') : t('sigpanel.ts.bad')}</dd>{/if}
        {#if cur.signer}<dt>{t('cert.issuer')}</dt><dd>{cur.signer.issuer}</dd>{/if}
        {#if cur.reason}<dt>{t('dsig.reason')}</dt><dd>{cur.reason}</dd>{/if}
        {#if cur.location}<dt>{t('dsig.location')}</dt><dd>{cur.location}</dd>{/if}
        {#if cur.message}<dt>{t('sigpanel.note')}</dt><dd>{cur.message}</dd>{/if}
      </dl>
      {#if cur.status === 'valid-untrusted' && cur.signerDer}
        <div class="row"><button class="btn" onclick={() => w.trustSigner()}><Icon name="shield-check" />{t('sigpanel.trust')}</button></div>
      {/if}
    {/if}
  {/if}
  {#snippet footer()}<button class="btn primary" data-autofocus onclick={() => ui.closeDialog()}>{t('action.close')}</button>{/snippet}
</Dialog>

<style>
  .rowbtn { display: flex; align-items: center; gap: 8px; background: none; border: 0; color: inherit; font: inherit; padding: 0; cursor: pointer; text-align: left; flex: 1; }
  .rowbtn.on b { text-decoration: underline; text-underline-offset: 3px; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
  .kv dt { color: var(--color-fg-3); }
  .kv dd { margin: 0; word-break: break-word; }
</style>
