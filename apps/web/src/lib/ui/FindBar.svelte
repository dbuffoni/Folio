<script lang="ts">
  import type { DocumentSession } from '@folio/app';
  import { t } from '#lib/i18n/index.ts';
  import { dep, models, track, ui } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import { tip } from './tip.ts';

  let { session }: { session: DocumentSession } = $props();
  const find = $derived(dep(track(), models(session).find));
  const pos = $derived(dep(track(), find.position));
  let input: HTMLInputElement | undefined = $state();
  const open = $derived(find.open);
  $effect(() => {
    if (open) input?.select();
  });
</script>

{#if find.open}
  <div id="findbar" role="search">
    <span style="margin-left:6px;color:var(--color-fg-3);display:inline-flex"><Icon name="search" /></span>
    <input
      type="text"
      bind:this={input}
      value={find.query}
      placeholder={t('ui.findPlaceholder')}
      aria-label={t('ui.find')}
      oninput={(e) => find.setQuery(e.currentTarget.value)}
      onkeydown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') find.step(e.shiftKey ? -1 : 1);
        else if (e.key === 'Escape') find.toggle(false);
      }}
    />
    <span class="note" style="white-space:nowrap" aria-live="polite">{find.query === '' ? '' : pos.total ? t('ui.matches', pos) : find.searching ? '…' : t('ui.noMatch')}</span>
    <button class="ib" disabled={!pos.total} onclick={() => find.step(-1)} use:tip={[t('ui.prevMatch'), 'Shift+Enter']} aria-label={t('ui.prevMatch')}><Icon name="chevron-up" /></button>
    <button class="ib" disabled={!pos.total} onclick={() => find.step(1)} use:tip={[t('ui.nextMatch'), 'Enter']} aria-label={t('ui.nextMatch')}><Icon name="chevron-down" /></button>
    <button class="ib" class:on={find.matchCase} aria-pressed={find.matchCase} onclick={() => find.setOptions({ matchCase: !find.matchCase })} use:tip={t('ui.matchCase')} aria-label={t('ui.matchCase')}><Icon name="case-sensitive" /></button>
    <button class="ib" class:on={find.wholeWord} aria-pressed={find.wholeWord} onclick={() => find.setOptions({ wholeWord: !find.wholeWord })} use:tip={t('ui.wholeWord')} aria-label={t('ui.wholeWord')}><Icon name="whole-word" /></button>
    <button class="ib" onclick={() => (session.setSidebarTab('search'), !ui.sidebarOpen && ui.toggleSidebar())} use:tip={t('ui.searchResults')} aria-label={t('ui.searchResults')}><Icon name="layout-list" /></button>
    <button class="ib" onclick={() => find.toggle(false)} aria-label={t('ui.closeFind')}><Icon name="x" /></button>
  </div>
{/if}
