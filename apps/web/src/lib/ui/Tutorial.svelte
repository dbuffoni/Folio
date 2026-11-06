<script lang="ts">
  import { TUTORIAL_SLIDES } from '@folio/app';
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, desktop, track, ui } from '#lib/state.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  const v = $derived(track());
  const step = $derived(dep(v, ui.tutorial));
  const s = $derived(dep(v, app.settings));
  const last = TUTORIAL_SLIDES - 1;

  async function next(): Promise<void> {
    if (!ui.nextTutorial()) await app.endTutorial(ui);
  }
  const close = (): Promise<void> => app.endTutorial(ui);
</script>

{#if step !== null}
  <Dialog title={t('tutorial.title')} width={540} onclose={close}>
    <div class="tut" data-slide={step + 1}>
      <h3>{t(`tutorial.${step + 1}.title`)}</h3>
      <p>{t(`tutorial.${step + 1}.body`)}</p>
      {#if step === 1}
        <p class="note">{t('tutorial.2.note')}</p>
      {:else if step === 2}
        <button class="btn sm" onclick={() => app.tutorialToSettings(ui, 'profiles')}><Icon name="user" />{t('tutorial.3.link')}</button>
      {:else if step === 3}
        <ul>
          <li>{t('tutorial.4.sent')}</li>
          <li>{t('tutorial.4.off')}</li>
        </ul>
        <button class="btn sm" onclick={() => app.tutorialToSettings(ui, 'smartFill')}><Icon name="sparkles" />{t('tutorial.4.link')}</button>
      {:else if step === 4}
        {#if desktop}
          <div class="togrow"><div>{t('settings.keepBackup')}<small>{t('tutorial.5.backupHint')}</small></div><input type="checkbox" class="tog" aria-label={t('settings.keepBackup')} checked={s.keepBackup} onchange={(e) => app.setSetting('keepBackup', e.currentTarget.checked)} /></div>
          {#if app.canCheckUpdates}
            <div class="togrow"><div>{t('settings.updates.check')}<small>{t('tutorial.5.updatesHint')}</small></div><input type="checkbox" class="tog" aria-label={t('settings.updates.check')} checked={s.updates.check} onchange={(e) => app.setSetting('updates', { ...app.settings.updates, check: e.currentTarget.checked })} /></div>
          {/if}
        {/if}
      {/if}
    </div>
    {#snippet footer()}
      <span class="note" aria-live="polite">{t('tutorial.step', { n: step + 1, total: TUTORIAL_SLIDES })}</span>
      <span class="grow"></span>
      {#if step < last}<button class="btn ghost" onclick={close}>{t('action.skip')}</button>{/if}
      {#if step > 0}<button class="btn" onclick={() => ui.backTutorial()}>{t('action.back')}</button>{/if}
      <button class="btn primary" data-autofocus onclick={next}>{step === last ? t('action.done') : t('action.next')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .tut h3 { margin: 0 0 8px; font-size: 16px; }
  .tut p { margin: 0 0 10px; color: var(--color-fg-2); }
  .tut ul { margin: 0 0 10px; padding-left: 18px; color: var(--color-fg-2); }
  .tut li { margin-bottom: 4px; }
</style>
