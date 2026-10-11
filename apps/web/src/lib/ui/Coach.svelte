<script lang="ts">
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, track, ui } from '#lib/state.svelte.ts';

  const step = $derived(dep(track(), ui.coach));
  const hasDoc = $derived(dep(track(), app.active !== null));
  // Each mark points at a fixed area of the window: mode bar, Sign, palette button.
  const POS = ['left:16px;top:136px', 'left:50%;top:136px;transform:translateX(-50%)', 'right:56px;top:44px'];
  async function next(): Promise<void> {
    if (ui.nextCoach()) await app.setSetting('onboardingDone', true);
  }
  async function skip(): Promise<void> {
    ui.skipCoach();
    await app.setSetting('onboardingDone', true);
  }
</script>

{#if step !== null && hasDoc}
  <div class="coach" style={POS[step]} role="dialog" aria-label={t(`ui.coach.${step + 1}.title`)}>
    <h3>{t(`ui.coach.${step + 1}.title`)}</h3>
    <p>{t(`ui.coach.${step + 1}.body`)}</p>
    <div class="cf">
      <span class="note">{t('ui.coach.step', { n: step + 1 })}</span><span class="grow"></span>
      <button class="btn ghost sm" onclick={skip}>{t('action.skip')}</button>
      <button class="btn primary sm" onclick={next}>{step === 2 ? t('action.done') : t('action.next')}</button>
    </div>
  </div>
{/if}
