<script lang="ts">
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, track } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';

  const update = $derived(dep(track(), app.update));
</script>

{#if update}
  <div id="updatebanner" role="status">
    <Icon name="download" />
    <b>{t('updates.banner', { version: update.version })}</b>
    <span class="grow note">{t('updates.bannerHint')}</span>
    <button class="btn sm primary" onclick={() => app.openUpdate()}>{t('updates.view')}</button>
    <button class="btn sm" onclick={() => app.skipUpdate()}>{t('updates.skip')}</button>
    <button class="ib" onclick={() => app.dismissUpdate()} aria-label={t('action.dismiss')}><Icon name="x" /></button>
  </div>
{/if}
