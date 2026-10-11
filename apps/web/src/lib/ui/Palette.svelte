<script lang="ts">
  import { formatChord } from '@folio/app';
  import { t } from '#lib/i18n/index.ts';
  import { dep, commandContext, isMac, registry, track, ui } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';

  let query = $state('');
  let index = $state(0);
  let list: HTMLDivElement | undefined = $state();
  const items = $derived(dep(track(), registry.search(query, commandContext(), t, 60).filter((i) => i.command.id !== 'view.palette' && i.command.id !== 'edit.cancel')));
  $effect(() => {
    void query;
    index = 0;
  });
  $effect(() => {
    list?.querySelector('.pi.on')?.scrollIntoView({ block: 'nearest' });
  });
  async function runItem(i: number): Promise<void> {
    const item = items[i];
    if (!item) return;
    ui.togglePalette(false);
    await registry.run(item.command.id, commandContext());
  }
  function onkeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'ArrowDown') index = Math.min(items.length - 1, index + 1);
    else if (e.key === 'ArrowUp') index = Math.max(0, index - 1);
    else if (e.key === 'Enter') void runItem(index);
    else if (e.key === 'Escape') ui.togglePalette(false);
    else return;
    e.preventDefault();
  }
  function focus(node: HTMLInputElement) {
    node.focus();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay top" onpointerdown={(e) => e.target === e.currentTarget && ui.togglePalette(false)}>
  <div class="dialog palette" role="dialog" aria-modal="true" aria-label={t('cmd.palette')}>
    <input type="text" bind:value={query} use:focus {onkeydown} placeholder={t('ui.palettePlaceholder')} aria-label={t('ui.palettePlaceholder')} role="combobox" aria-expanded="true" aria-controls="plist" aria-activedescendant={items[index] ? `pi-${index}` : undefined} />
    <div class="plist" id="plist" role="listbox" bind:this={list}>
      {#each items as item, i (item.command.id)}
        <button class="pi" class:on={i === index} id="pi-{i}" role="option" aria-selected={i === index} onpointermove={() => (index = i)} onclick={() => runItem(i)}>
          <Icon name={item.command.icon ?? 'chevron-right'} />
          <span class="grow">{item.title}</span>
          <small>{t(`mode.${item.command.group}`) === `mode.${item.command.group}` ? '' : ''}</small>
          {#if item.command.shortcut}<kbd>{formatChord(item.command.shortcut, isMac)}</kbd>{/if}
        </button>
      {/each}
      {#if items.length === 0}<p class="note" style="padding:12px">{t('ui.paletteEmpty')}</p>{/if}
    </div>
    <div class="pfoot"><span>{t('ui.paletteHint.run')}</span><span>{t('ui.paletteHint.move')}</span><span>{t('ui.paletteHint.close')}</span></div>
  </div>
</div>
