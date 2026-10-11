<script lang="ts">
  import { untrack } from 'svelte';
  import type { DocumentSession } from '@folio/app';
  import { formatBytes, parsePdfDate } from '@folio/core';
  import type { DocumentProperties } from '@folio/services';
  import { t } from '#lib/i18n/index.ts';
  import { app, services, ui } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';

  let { session }: { session: DocumentSession } = $props();
  let info = $state<DocumentProperties | null>(null);
  // svelte-ignore state_referenced_locally
  let title = $state(session.meta.title);
  // svelte-ignore state_referenced_locally
  let author = $state(session.meta.author);
  // svelte-ignore state_referenced_locally
  let subject = $state(session.meta.subject);
  // svelte-ignore state_referenced_locally
  let keywords = $state(session.meta.keywords);
  $effect(() => {
    untrack(() => void services.documents.properties(session.doc, session.byteSize).then((p) => (info = p)));
  });
  const date = (s: string): string => parsePdfDate(s)?.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) ?? '—';
  const sizes = $derived(info ? (info.pageSizes.length > 1 ? t('props.mixed') : `${info.pageSizes[0]?.name ?? `${Math.round(info.pageSizes[0]?.size.width ?? 0)} × ${Math.round(info.pageSizes[0]?.size.height ?? 0)} pt`}`) : '');
  async function apply(): Promise<void> {
    const m = session.meta;
    const changes = Object.fromEntries(Object.entries({ title, author, subject, keywords }).filter(([k, val]) => val !== m[k as 'title']));
    if (Object.keys(changes).length) {
      await app.guard(() => session.run(services.documents.setMetadata(m, changes)));
      app.toast('success', { key: 'toast.propertiesUpdated' });
    }
    ui.closeDialog();
  }
  async function removeAll(): Promise<void> {
    await app.guard(() => session.run(services.documents.removeAllMetadata()));
    ui.closeDialog();
  }
</script>

<Dialog title={t('props.title')} width={620} onclose={() => ui.closeDialog()}>
  <div class="field"><label for="m1">{t('props.docTitle')}</label><input id="m1" type="text" bind:value={title} /></div>
  <div class="g2">
    <div class="field"><label for="m2">{t('props.author')}</label><input id="m2" type="text" bind:value={author} /></div>
    <div class="field"><label for="m3">{t('props.subject')}</label><input id="m3" type="text" bind:value={subject} /></div>
  </div>
  <div class="field"><label for="m4">{t('props.keywords')}</label><input id="m4" type="text" bind:value={keywords} /><span class="hint">{t('props.keywordsHint')}</span></div>
  <div class="g2">
    <div class="field"><label for="m5">{t('props.creator')}</label><input id="m5" type="text" value={session.meta.creator} readonly /></div>
    <div class="field"><label for="m6">{t('props.producer')}</label><input id="m6" type="text" value={session.meta.producer} readonly /></div>
    <div class="field"><label for="m7">{t('props.created')}</label><input id="m7" type="text" value={date(session.meta.creationDate)} readonly /></div>
    <div class="field"><label for="m8">{t('props.modified')}</label><input id="m8" type="text" value={date(session.meta.modDate)} readonly /></div>
  </div>
  <div class="kvlist">
    <div class="kv"><span>{t('props.version')} · {t('props.pages')} · {t('props.pageSize')} · {t('props.fileSize')}</span><b>{session.meta.pdfVersion} · {session.pageCount} · {sizes} · {session.byteSize ? formatBytes(session.byteSize) : '—'}</b></div>
    <div class="kv"><span>{t('props.encryption')}</span><b>{session.meta.isEncrypted ? t('props.encrypted') : t('props.notEncrypted')}</b></div>
    <div class="kv"><span>{t('props.signatures')}</span><b>{session.meta.hasSignatures ? t('props.present') : t('props.none')}</b></div>
    <div class="kv" style="align-items:flex-start"><span>{t('props.fonts')}</span>
      <b>{#each info?.fonts ?? [] as f (f.name)}<div>{f.name} <span class="note">({f.embedded ? (f.subset ? t('props.subset') : t('props.embedded')) : t('props.notEmbedded')})</span></div>{:else}—{/each}</b>
    </div>
  </div>
  {#snippet footer()}
    <span class="l">{t('props.applied')}</span>
    <button class="btn danger" onclick={removeAll}>{t('props.removeAll')}</button>
    <button class="btn" onclick={() => ui.closeDialog()}>{t('action.cancel')}</button>
    <button class="btn primary" onclick={apply}>{t('action.apply')}</button>
  {/snippet}
</Dialog>
