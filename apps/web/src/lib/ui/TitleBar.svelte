<script lang="ts">
  import { formatChord } from '@folio/app';
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, isMac, run, track, ui } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import Menu, { type MenuItem } from './Menu.svelte';
  import { tip } from './tip.ts';

  const sessions = $derived(dep(track(), app.sessions));
  const activeId = $derived(dep(track(), app.activeId));
  const theme = $derived(dep(track(), app.settings.theme));
  let menu = $state<{ x: number; y: number } | null>(null);
  let dragId = $state<string | null>(null);
  let recents = $state<Awaited<ReturnType<typeof app.recentFiles>>>([]);
  const k = (s: string): string => formatChord(s, isMac);
  let strip: HTMLElement | undefined = $state();
  // With many documents open the active tab may be outside the strip: bring it into view.
  $effect(() => {
    void activeId;
    void sessions.length;
    const host = strip;
    if (!host) return;
    requestAnimationFrame(() =>
      host.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }),
    );
  });

  async function openMenu(e: MouseEvent): Promise<void> {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    recents = (await app.recentFiles()).slice(0, 5);
    menu = { x: r.left, y: r.bottom + 4 };
  }
  const items = $derived.by((): MenuItem[] => {
    const has = !!activeId;
    return [
      { icon: 'folder-open', label: t('cmd.open'), shortcut: k('Mod+O'), run: () => void run('file.open') },
      ...(recents.length ? ([{ kind: 'head', label: t('home.recent') }, ...recents.map((r): MenuItem => ({ icon: 'file-text', label: r.displayName, run: () => void app.openRecent(r) }))] as MenuItem[]) : []),
      { kind: 'sep' },
      { icon: 'save', label: t('cmd.save'), shortcut: k('Mod+S'), disabled: !has, run: () => void run('file.save') },
      { icon: 'save-all', label: t('cmd.saveAs'), shortcut: k('Mod+Shift+S'), disabled: !has, run: () => void run('file.saveAs') },
      { icon: 'copy', label: t('cmd.exportCopy'), disabled: !has, run: () => void run('file.exportCopy') },
      { kind: 'sep' },
      { icon: 'files', label: t('cmd.merge'), run: () => void run('task.merge') },
      { icon: 'scissors', label: t('cmd.split'), disabled: !has, run: () => void run('task.split') },
      { icon: 'images', label: t('cmd.imagesToPdf'), run: () => void run('task.images') },
      { icon: 'file-image', label: t('cmd.exportImages'), disabled: !has, run: () => void run('export.images') },
      { icon: 'scan-text', label: t('cmd.ocr.open'), disabled: !has, run: () => void run('tool.ocr') },
      { icon: 'file-down', label: t('cmd.compress'), disabled: !has, run: () => void run('export.compress') },
      { kind: 'sep' },
      { icon: 'info', label: t('cmd.properties'), disabled: !has, run: () => void run('file.properties') },
      { icon: 'history', label: t('cmd.history'), disabled: !has, run: () => void run('edit.history') },
      { icon: 'printer', label: t('cmd.print'), shortcut: k('Mod+P'), disabled: !has, run: () => void run('file.print') },
      { kind: 'sep' },
      { icon: 'keyboard', label: t('cmd.shortcuts'), run: () => void run('help.shortcuts') },
      { icon: 'settings', label: t('cmd.settings'), run: () => void run('settings.open') },
      { icon: 'x', label: t('cmd.closeTab'), shortcut: k('Mod+W'), disabled: !has, run: () => void run('file.close') },
    ];
  });
  const dark = $derived(theme === 'dark' || (theme === 'system' && typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches));
</script>

<header id="titlebar">
  <button class="ib" onclick={openMenu} use:tip={t('ui.mainMenu')} aria-label={t('ui.mainMenu')} aria-haspopup="menu"><Icon name="menu" /></button>
  <button class="brand" onclick={() => app.showHome()} use:tip={t('ui.home')}><i class="logo">F</i><span>Folio</span></button>
  <nav id="tabs" bind:this={strip} aria-label={t('ui.openDocuments')}>
    {#each sessions as s, i (s.id)}
      <!-- Document tabs are navigation buttons with a sibling close button: a control nested in a tab cannot be reached by assistive technology. -->
      <div
        class="tab"
        class:on={s.id === activeId}
        role="presentation"
        draggable="true"
        onauxclick={(e) => e.button === 1 && (e.preventDefault(), void app.closeTab(s.id))}
        ondragstart={() => (dragId = s.id)}
        ondragover={(e) => dragId && e.preventDefault()}
        ondrop={() => (dragId && app.moveTab(dragId, i), (dragId = null))}
      >
        <button class="tabb" aria-current={s.id === activeId ? 'page' : undefined} title={s.name} onclick={() => app.activate(s.id)}>
          <Icon name="file-text" />
          <span class="nm">{s.title}</span>
          {#if s.dirty}<i class="dot" title={t('ui.unsaved')}></i>{/if}
        </button>
        <button class="x" style="border:0;background:none;color:inherit;cursor:pointer;padding:0" onclick={() => void app.closeTab(s.id)} aria-label={t('ui.closeTab', { name: s.name })}><Icon name="x" /></button>
      </div>
    {/each}
  </nav>
  <button class="ib" onclick={() => app.showHome()} use:tip={t('ui.newTab')} aria-label={t('ui.newTab')}><Icon name="plus" /></button>
  <button class="btn ghost sm" onclick={() => ui.togglePalette(true)} use:tip={t('cmd.palette')}><Icon name="command" /><kbd>{k('Mod+K')}</kbd></button>
  <button class="ib" onclick={() => run('view.theme')} use:tip={t('ui.theme')} aria-label={t('ui.theme')}><Icon name={dark ? 'sun' : 'moon'} /></button>
  <button class="ib" onclick={() => run('settings.open')} use:tip={t('cmd.settings')} aria-label={t('cmd.settings')}><Icon name="settings" /></button>
</header>
{#if menu}<Menu {items} anchor={menu} onclose={() => (menu = null)} />{/if}
