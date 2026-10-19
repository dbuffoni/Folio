<script lang="ts">
  import type { DocumentSession } from '@folio/app';
  import type { HiddenDataInventory, HiddenDataOptions, HiddenDataReport } from '@folio/ports';
  import { t } from '#lib/i18n/index.ts';
  import { app, ui } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  let { session }: { session: DocumentSession } = $props();
  let found = $state<HiddenDataInventory | null>(null);
  let report = $state<HiddenDataReport | null>(null);
  let busy = $state(false);
  // Everything is on by default; attachments are listed so that nothing goes silently.
  let opts = $state<HiddenDataOptions>({ info: true, xmp: true, thumbnails: true, scripts: true, annotationAuthors: true, attachments: true });
  const signed = $derived(session.meta.hasSignatures);
  $effect(() => {
    void session.doc.inspectHiddenData().then((f) => (found = f));
  });
  const KINDS = ['info', 'xmp', 'thumbnails', 'scripts', 'annotationAuthors'] as const;
  const count = (k: (typeof KINDS)[number]): string => {
    if (!found) return '';
    const v = found[k];
    if (!found.structural && k !== 'info') return t('hidden.unavailable');
    if (Array.isArray(v)) return v.length ? t('hidden.found', { count: v.length }) : t('hidden.none');
    if (typeof v === 'boolean') return v ? t('hidden.present') : t('hidden.none');
    return v > 0 ? t('hidden.found', { count: v }) : t('hidden.none');
  };
  const anySelected = $derived(Object.values(opts).some(Boolean));
  async function run(copy: boolean): Promise<void> {
    busy = true;
    try {
      report = (copy ? await app.saveCleanedCopy(session, $state.snapshot(opts)) : await app.removeHiddenData(session, $state.snapshot(opts))) ?? null;
      if (report && !copy) found = await session.doc.inspectHiddenData();
    } finally {
      busy = false;
    }
  }
  const lines = $derived.by((): string[] => {
    if (!report) return [];
    const r = report.removed;
    const out: string[] = [];
    if (r.info) out.push(t('hidden.done.info'));
    if (r.xmp) out.push(t('hidden.done.xmp'));
    if (r.thumbnails) out.push(t('hidden.done.thumbnails', { count: r.thumbnails }));
    if (r.scripts) out.push(t('hidden.done.scripts', { count: r.scripts }));
    if (r.annotationAuthors) out.push(t('hidden.done.authors', { count: r.annotationAuthors }));
    if (r.attachments) out.push(t('hidden.done.attachments', { count: r.attachments }));
    return out;
  });
</script>

<Dialog title={t('hidden.title')} width={520} onclose={() => ui.closeDialog()}>
  {#if report}
    <div role="status">
      <p><strong>{lines.length ? t('hidden.done.head') : t('hidden.done.nothing')}</strong></p>
      <ul class="plain">
        {#each lines as line (line)}<li><Icon name="check" /> {line}</li>{/each}
      </ul>
      {#if report.skipped.length}
        <div class="callout"><Icon name="triangle-alert" /><span>{t('hidden.skipped', { list: report.skipped.map((k) => t(`hidden.kind.${k}`)).join(', ') })}</span></div>
      {/if}
      <p class="note">{t('hidden.rewrite')}</p>
    </div>
  {:else}
    <p class="note">{t('hidden.intro')}</p>
    {#if signed}
      <div class="callout"><Icon name="triangle-alert" /><span>{t('hidden.signed')}</span></div>
    {/if}
    {#if found && !found.structural}
      <div class="callout info"><Icon name="info" /><span>{t('hidden.protected')}</span></div>
    {/if}
    <fieldset class="field" style="border:0;padding:0;margin:8px 0 0">
      <legend class="sr-only">{t('hidden.title')}</legend>
      <label class="row"><input type="checkbox" bind:checked={opts.attachments} /><span class="grow">{t('hidden.kind.attachments')}</span><span class="note">{found ? (found.attachments.length ? t('hidden.found', { count: found.attachments.length }) : t('hidden.none')) : ''}</span></label>
      {#if found?.attachments.length}
        <ul class="plain" style="margin:0 0 6px 26px">
          {#each found.attachments as a (a.index)}<li class="note">{a.name}</li>{/each}
        </ul>
      {/if}
      {#each KINDS as k (k)}
        <label class="row"><input type="checkbox" bind:checked={opts[k]} /><span class="grow">{t(`hidden.kind.${k}`)}</span><span class="note">{count(k)}</span></label>
      {/each}
    </fieldset>
  {/if}
  {#snippet footer()}
    {#if report}
      <button class="btn primary" data-autofocus onclick={() => ui.closeDialog()}>{t('action.close')}</button>
    {:else}
      <button class="btn" onclick={() => ui.closeDialog()}>{t('action.cancel')}</button>
      {#if signed}<button class="btn" disabled={busy || !anySelected} onclick={() => run(true)}>{t('hidden.saveCopy')}</button>{/if}
      <button class="btn danger" disabled={busy || !anySelected} onclick={() => run(false)}>{signed ? t('hidden.removeSigned') : t('hidden.remove')}</button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
  }
  .plain {
    list-style: none;
    padding: 0;
    margin: 6px 0;
  }
  .plain :global(svg) {
    width: 14px;
    height: 14px;
    vertical-align: -2px;
    color: var(--color-ok, currentColor);
  }
</style>
