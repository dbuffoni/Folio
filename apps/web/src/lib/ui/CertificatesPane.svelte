<script lang="ts">
  import { untrack } from 'svelte';
  import { formatDate } from '@folio/core';
  import type { CertificateEntry } from '@folio/services';
  import { t, tm } from '#lib/i18n/index.ts';
  import { app, dep, services, track, wizards } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';

  const m = wizards.certificates();
  const v = $derived(track());
  const s = $derived(dep(v, app.settings));
  const net = !!services.platform.network;
  const set = (patch: Partial<typeof s.signing>): Promise<void> => app.setSetting('signing', { ...app.settings.signing, ...patch });
  $effect(() => {
    untrack(() => void m.load());
  });
  const day = (iso: string): string => formatDate(new Date(iso), s.dateFormat, 'en');
  const cur = $derived(dep(v, m.current));
  const tone = (c: CertificateEntry): string => (c.validity === 'valid' ? '' : 'warn');
</script>

<div class="callout info"><Icon name="shield-check" /><span>{m.keysPersist ? t('cert.info.keychain') : t('cert.info.session')}</span></div>

<div class="field" data-testid="cert-identities">
  <span class="lab" id="cert-id-l">{t('cert.identities')}</span>
  <ul class="rlist" aria-labelledby="cert-id-l">
    {#each dep(v, m.identities) as c (c.fingerprint)}
      <li>
        <button class="rowbtn" class:on={cur?.fingerprint === c.fingerprint} aria-pressed={cur?.fingerprint === c.fingerprint} onclick={() => m.select('identity', c.fingerprint)}>
          <Icon name="badge-check" /><b>{c.commonName}</b>
        </button>
        <span class="chip {tone(c)}">{t(`cert.validity.${c.validity}`)}</span>
        {#if !c.usable}<span class="chip warn">{t('cert.needsFile')}</span>{/if}
        <small>{c.keyAlgorithm}</small>
      </li>
    {:else}<li class="empty">{t('cert.identities.empty')}</li>{/each}
  </ul>
  <div class="row"><button class="btn" disabled={m.busy} onclick={() => m.importIdentity()}><Icon name="upload" />{t('cert.importIdentity')}</button></div>
</div>

<div class="field" data-testid="cert-trusted">
  <span class="lab" id="cert-tr-l">{t('cert.trusted')}</span>
  <ul class="rlist" aria-labelledby="cert-tr-l">
    {#each dep(v, m.trusted) as c (c.fingerprint)}
      <li>
        <button class="rowbtn" class:on={cur?.fingerprint === c.fingerprint} aria-pressed={cur?.fingerprint === c.fingerprint} onclick={() => m.select('trusted', c.fingerprint)}>
          <Icon name="shield-check" /><b>{c.commonName}</b>
        </button>
        <span class="chip {tone(c)}">{t(`cert.validity.${c.validity}`)}</span>
        <small>{c.isCa ? t('cert.ca') : t('cert.signer')}</small>
      </li>
    {:else}<li class="empty">{t('cert.trusted.empty')}</li>{/each}
  </ul>
  <div class="row"><button class="btn" disabled={m.busy} onclick={() => m.importTrusted()}><Icon name="upload" />{t('cert.importTrusted')}</button></div>
  <span class="hint">{t('cert.trusted.hint')}</span>
</div>

{#if m.error}<div class="callout warn" role="alert"><Icon name="triangle-alert" /><span>{tm(dep(v, m.error)!)}</span></div>{/if}

{#if cur}
  <div class="field" data-testid="cert-detail">
    <span class="lab">{t('cert.details')}</span>
    <dl class="kv">
      <dt>{t('cert.subject')}</dt><dd>{cur.subject}</dd>
      <dt>{t('cert.issuer')}</dt><dd>{cur.issuer}</dd>
      <dt>{t('cert.validFrom')}</dt><dd>{day(cur.notBefore)}</dd>
      <dt>{t('cert.validTo')}</dt><dd>{day(cur.notAfter)}</dd>
      <dt>{t('cert.fingerprint')}</dt><dd class="mono">{cur.fingerprint.match(/.{1,2}/g)?.join(':').toUpperCase()}</dd>
    </dl>
    <div class="row"><button class="btn danger" onclick={() => m.remove(cur.kind, cur.fingerprint)}><Icon name="trash-2" />{t('cert.remove')}</button></div>
  </div>
{/if}

<div class="field" data-testid="cert-network">
  <span class="lab">{t('cert.network')}</span>
  {#if !net}<div class="callout"><Icon name="info" /><span>{t('cert.network.unavailable')}</span></div>{/if}
  <div class="togrow"><div>{t('cert.timestamp')}<small>{t('cert.timestampHint')}</small></div><input type="checkbox" class="tog" aria-label={t('cert.timestamp')} disabled={!net} checked={s.signing.timestamp} onchange={(e) => set({ timestamp: e.currentTarget.checked })} /></div>
  <div class="field"><label for="tsa">{t('cert.tsaUrl')}</label><input id="tsa" type="url" inputmode="url" disabled={!net} value={s.signing.tsaUrl} onchange={(e) => set({ tsaUrl: e.currentTarget.value.trim() })} /><span class="hint">{t('cert.tsaHint')}</span></div>
  <div class="togrow"><div>{t('cert.embed')}<small>{t('cert.embedHint')}</small></div><input type="checkbox" class="tog" aria-label={t('cert.embed')} disabled={!net} checked={s.signing.embedValidation} onchange={(e) => set({ embedValidation: e.currentTarget.checked })} /></div>
  <div class="togrow"><div>{t('cert.revocation')}<small>{t('cert.revocationHint')}</small></div><input type="checkbox" class="tog" aria-label={t('cert.revocation')} disabled={!net} checked={s.signing.revocationCheck} onchange={(e) => set({ revocationCheck: e.currentTarget.checked })} /></div>
</div>

<style>
  .rowbtn { display: flex; align-items: center; gap: 8px; background: none; border: 0; color: inherit; font: inherit; padding: 0; cursor: pointer; text-align: left; flex: 1; }
  .rowbtn.on b { text-decoration: underline; text-underline-offset: 3px; }
  .empty { color: var(--color-fg-3); }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
  .kv dt { color: var(--color-fg-3); }
  .kv dd { margin: 0; word-break: break-word; }
  .mono { font-family: var(--font-mono, monospace); font-size: 12px; }
</style>
