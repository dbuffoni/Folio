<script lang="ts">
  import { untrack } from 'svelte';
  import { formatBytes } from '@folio/core';
  import { t } from '#lib/i18n/index.ts';
  import { dep, services, track } from '#lib/state.svelte.ts';
  import type { OcrLanguagePack } from '@folio/services';
  import { app } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';

  const v = $derived(track());
  let packs = $state<Array<OcrLanguagePack & { installed: boolean }>>([]);
  let busy = $state<string | null>(null);
  let received = $state(0);
  async function load(): Promise<void> {
    packs = await services.ocrLanguages.list();
  }
  $effect(() => {
    void v;
    untrack(() => void load());
  });
  async function download(p: OcrLanguagePack): Promise<void> {
    const ok = await app.prompts.confirm({ key: 'ocr.confirmDownload', params: { name: p.name, size: p.size, host: new URL(p.url!).host } }, { confirmLabel: { key: 'ocr.download' } });
    if (!ok) return;
    busy = p.code;
    received = 0;
    await app.guard(() => services.ocrLanguages.install(p.code, { onProgress: (n) => (received = n) }));
    busy = null;
    await load();
  }
  async function remove(p: OcrLanguagePack): Promise<void> {
    await services.ocrLanguages.remove(p.code);
    await load();
  }
</script>

<p class="note" style="margin:0">{t('settings.ocr.hint')}</p>
<ul class="rlist" aria-label={t('settings.ocr')}>
  {#each dep(v, packs) as p (p.code)}
    <li><Icon name="scan-text" /><b>{p.name}</b>
      <span class="chip {p.installed ? 'acc' : ''}">{p.bundled ? t('ocr.included') : p.installed ? t('ocr.installed') : formatBytes(p.size)}</span>
      <small>{p.code}{p.url ? ` · ${new URL(p.url).host}` : ''}</small>
      {#if busy === p.code}<small role="status">{formatBytes(received)} / {formatBytes(p.size)}</small>
      {:else if !p.bundled && !p.installed}<button class="btn sm" onclick={() => download(p)}>{t('ocr.download')}</button>
      {:else if !p.bundled}<button class="btn sm" onclick={() => remove(p)}>{t('ocr.remove')}</button>{/if}
    </li>
  {/each}
</ul>
