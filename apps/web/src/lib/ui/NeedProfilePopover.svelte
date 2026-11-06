<script lang="ts">
  import { tick } from 'svelte';
  import type { SmartFillModel } from '@folio/app';
  import { t } from '#lib/i18n/index.ts';
  import { dep, track, ui } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';

  let { smart }: { smart: SmartFillModel } = $props();
  const origin = $derived(dep(track(), smart.needProfile));
  let pop: HTMLDivElement | undefined = $state();
  let anchor: HTMLElement | null = null;
  let pos = $state({ top: 0, left: 0 });

  // Anchored under the control that was used; clamped so it never leaves the window.
  async function place(): Promise<void> {
    await tick();
    if (!pop || origin === null) return;
    anchor = document.querySelector<HTMLElement>(`[data-smartfill-origin="${origin}"]`);
    const a = anchor?.getBoundingClientRect();
    const w = pop.offsetWidth;
    const margin = 8;
    const left = a ? a.left + a.width / 2 - w / 2 : window.innerWidth - w - 16;
    pos = { top: a ? a.bottom + 6 : 96, left: Math.max(margin, Math.min(left, window.innerWidth - w - margin)) };
    pop.querySelector<HTMLElement>('button.primary')?.focus();
  }
  $effect(() => {
    if (origin !== null) void place();
  });

  function close(returnFocus = true): void {
    smart.dismissNeedProfile();
    if (returnFocus) anchor?.focus();
  }
  function create(): void {
    smart.dismissNeedProfile();
    ui.openSettings('profiles');
  }
  function onkeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }
  function outside(e: PointerEvent): void {
    if (origin !== null && pop && !pop.contains(e.target as Node) && !anchor?.contains(e.target as Node)) close(false);
  }
</script>

<svelte:window onpointerdown={outside} />

{#if origin !== null}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="needprofile" bind:this={pop} role="dialog" tabindex="-1" aria-label={t('smartfill.needProfile.title')} style="top:{pos.top}px;left:{pos.left}px" {onkeydown}>
    <b>{t('smartfill.needProfile.title')}</b>
    <p>{t('smartfill.needProfile')}</p>
    <div class="row">
      <button class="btn primary sm" onclick={create}><Icon name="user" />{t('smartfill.needProfile.create')}</button>
      <button class="btn ghost sm" onclick={() => close()}>{t('action.dismiss')}</button>
    </div>
  </div>
{/if}

<style>
  .needprofile {
    position: fixed;
    z-index: 90;
    width: 280px;
    max-width: calc(100vw - 16px);
    background: var(--color-surface);
    color: var(--color-fg);
    border: 1px solid var(--color-accent);
    border-radius: var(--radius-md, 10px);
    box-shadow: var(--shadow-float);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .needprofile p { margin: 0; color: var(--color-fg-2); font-size: 13px; }
  .needprofile .row { display: flex; gap: 8px; margin-top: 4px; }
</style>
