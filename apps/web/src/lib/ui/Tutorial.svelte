<script lang="ts">
  import { MODES, TUTORIAL_SLIDES } from '@folio/app';
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, desktop, track, ui } from '#lib/state.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  const v = $derived(track());
  const step = $derived(dep(v, ui.tutorial));
  const s = $derived(dep(v, app.settings));
  const last = TUTORIAL_SLIDES - 1;
  const MODE_ICON: Record<string, string> = { view: 'eye', organise: 'layout-grid', annotate: 'highlighter', fill: 'pen-line', edit: 'file-pen' };

  async function next(): Promise<void> {
    if (!ui.nextTutorial()) await app.endTutorial(ui);
  }
  const close = (): Promise<void> => app.endTutorial(ui);
</script>

{#snippet formMock(filled: boolean)}
  <div class="form" aria-hidden="true">
    {#each [60, 85, 45] as w, i (i)}
      <div class="frow"><span class="flab"></span><span class="fbox" class:filled><i style="width:{filled ? w : 0}%"></i></span></div>
    {/each}
  </div>
{/snippet}

{#if step !== null}
  <Dialog title={t('tutorial.title')} width={640} onclose={close}>
    <div class="tut" data-slide={step + 1}>
      <div class="hero" aria-hidden="true">
        {#if step === 0}
          <div class="modes">
            {#each MODES as md, i (md)}
              <span class="chip" class:on={i === 3}><Icon name={MODE_ICON[md] ?? 'eye'} /><b>{t(`mode.${md}`)}</b></span>
            {/each}
          </div>
        {:else if step === 1}
          <div class="flow">
            {@render formMock(false)}
            <span class="arrow"><span class="pill"><Icon name="sparkles" />{t('tool.smartFill')}</span><Icon name="arrow-right" /></span>
            {@render formMock(true)}
          </div>
        {:else if step === 2}
          <div class="flow">
            <div class="card"><span class="avatar"><Icon name="user" /></span>
              {#each [70, 90, 55] as w, i (i)}<span class="line" style="width:{w}%"></span>{/each}
            </div>
            <span class="arrow"><Icon name="arrow-right" /></span>
            {@render formMock(true)}
          </div>
        {:else if step === 3}
          <div class="flow two">
            <div class="side ok"><Icon name="sparkles" /><b>{t('tutorial.4.on')}</b><span>{t('tutorial.4.onSub')}</span></div>
            <div class="side off"><Icon name="shield-check" /><b>{t('tutorial.4.offTitle')}</b><span>{t('tutorial.4.offSub')}</span></div>
          </div>
        {:else if step === 4}
          <div class="flow shield">
            <span class="big"><Icon name="shield-check" /></span>
            <div class="tags"><span class="chip"><Icon name="check" />{t('tutorial.5.tag1')}</span><span class="chip"><Icon name="check" />{t('tutorial.5.tag2')}</span><span class="chip"><Icon name="check" />{t('tutorial.5.tag3')}</span></div>
          </div>
        {:else}
          <div class="flow shield">
            <span class="big ok"><Icon name="circle-check" /></span>
            <div class="tags"><span class="chip"><Icon name="file-up" />{t('tutorial.6.tag1')}</span><span class="chip"><Icon name="keyboard" />{t('tutorial.6.tag2')}</span></div>
          </div>
        {/if}
      </div>
      <h3>{t(`tutorial.${step + 1}.title`)}</h3>
      <p>{t(`tutorial.${step + 1}.body`)}</p>
      {#if step === 1}
        <p class="note">{t('tutorial.2.note')}</p>
      {:else if step === 2}
        <button class="btn primary" onclick={() => app.tutorialToSettings(ui, 'profiles')}><Icon name="user" />{t('tutorial.3.link')}</button>
        <p class="note">{t('tutorial.3.back')}</p>
      {:else if step === 3}
        <ul>
          <li>{t('tutorial.4.sent')}</li>
          <li>{t('tutorial.4.off')}</li>
        </ul>
        <button class="btn" onclick={() => app.tutorialToSettings(ui, 'smartFill')}><Icon name="sparkles" />{t('tutorial.4.link')}</button>
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
      <div class="dots" role="group" aria-label={t('tutorial.title')}>
        {#each Array.from({ length: TUTORIAL_SLIDES }, (_, i) => i) as i (i)}
          <button class="dot" class:on={i === step} aria-label={t('tutorial.goto', { n: i + 1 })} aria-current={i === step ? 'step' : undefined} onclick={() => ui.gotoTutorial(i)}></button>
        {/each}
      </div>
      <span class="note" aria-live="polite">{t('tutorial.step', { n: step + 1, total: TUTORIAL_SLIDES })}</span>
      <span class="grow"></span>
      {#if step < last}<button class="btn ghost" onclick={close}>{t('action.skip')}</button>{/if}
      {#if step > 0}<button class="btn" onclick={() => ui.backTutorial()}><Icon name="arrow-left" />{t('action.back')}</button>{/if}
      <button class="btn primary" data-autofocus onclick={next}>{step === last ? t('action.done') : t('action.next')}{#if step < last}<Icon name="arrow-right" />{/if}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .tut h3 { margin: 14px 0 6px; font-size: 18px; }
  .tut p { margin: 0 0 10px; color: var(--color-fg-2); }
  .tut ul { margin: 0 0 10px; padding-left: 18px; color: var(--color-fg-2); }
  .tut li { margin-bottom: 4px; }
  .hero { height: 170px; border-radius: 12px; background: var(--color-accent-soft); color: var(--color-accent-text); display: grid; place-items: center; padding: 14px; overflow: hidden; }
  .flow { display: flex; align-items: center; justify-content: center; gap: 14px; width: 100%; }
  .flow.two { gap: 12px; align-items: stretch; }
  .modes { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; background: var(--color-surface); color: var(--color-fg-2); font-size: 12px; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
  .chip.on { background: var(--color-accent); color: #fff; }
  .chip :global(svg) { width: 14px; height: 14px; }
  .form { background: var(--color-surface); border-radius: 8px; padding: 10px; width: 150px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15); }
  .frow { display: flex; flex-direction: column; gap: 3px; }
  .flab { height: 4px; width: 40%; border-radius: 2px; background: var(--color-fg-3, #9aa); opacity: 0.6; }
  .fbox { height: 14px; border-radius: 3px; border: 1px solid var(--color-accent); background: var(--color-accent-soft); display: block; overflow: hidden; }
  .fbox i { display: block; height: 100%; background: var(--color-accent); opacity: 0.55; }
  .arrow { display: flex; flex-direction: column; align-items: center; gap: 4px; color: var(--color-accent); }
  .arrow :global(svg) { width: 22px; height: 22px; }
  .pill { display: inline-flex; align-items: center; gap: 4px; padding: 4px 9px; border-radius: 999px; background: var(--color-accent); color: #fff; font-size: 11px; font-weight: 600; }
  .pill :global(svg) { width: 12px; height: 12px; }
  .card { background: var(--color-surface); border-radius: 8px; padding: 12px; width: 150px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15); }
  .avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--color-accent); color: #fff; display: grid; place-items: center; }
  .avatar :global(svg) { width: 18px; height: 18px; }
  .line { height: 6px; border-radius: 3px; background: var(--color-border-strong, var(--color-border)); display: block; }
  .side { flex: 1; background: var(--color-surface); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 4px; align-items: flex-start; font-size: 12px; color: var(--color-fg-2); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15); }
  .side b { color: var(--color-fg); font-size: 13px; }
  .side :global(svg) { width: 22px; height: 22px; color: var(--color-accent); }
  .side.off :global(svg) { color: var(--color-success, #16a34a); }
  .shield { flex-direction: column; gap: 10px; }
  .big :global(svg) { width: 64px; height: 64px; color: var(--color-accent); }
  .big.ok :global(svg) { color: var(--color-success, #16a34a); }
  .tags { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .dots { display: flex; gap: 6px; align-items: center; }
  .dot { width: 9px; height: 9px; padding: 0; border-radius: 50%; border: 0; background: var(--color-border-strong, var(--color-border)); cursor: pointer; }
  .dot.on { background: var(--color-accent); width: 22px; border-radius: 5px; }
  @media (max-width: 700px) { .hero { height: 140px; } .form, .card { width: 110px; } }
  @media (prefers-reduced-motion: no-preference) { .dot { transition: width 0.15s; } }
</style>
