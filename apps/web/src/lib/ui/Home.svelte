<script lang="ts">
  import { HOME_TILES, formatChord, type RecentCard, type Tile } from '@folio/app';
  import { t } from '#lib/i18n/index.ts';
  import { app, desktop, isMac, services, sign, models, track, ui } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import Menu, { type MenuItem } from './Menu.svelte';
  import { png } from './raster.ts';

  const ICON: Record<Tile, string> = { merge: 'files', split: 'scissors', organise: 'layout-grid', fill: 'text-cursor-input', sign: 'signature', images: 'images' };
  let query = $state('');
  let cards = $state<RecentCard[]>([]);
  let menu = $state<{ x: number; y: number; card: RecentCard } | null>(null);
  const v = $derived(track());

  $effect(() => {
    void v;
    const q = query;
    const exists = desktop ? (path: string) => (services.platform.files as unknown as { pathExists(p: string): Promise<boolean> }).pathExists(path) : undefined;
    void app.recentFiles(q, exists).then((list) => (cards = list));
  });
  async function tile(id: Tile): Promise<void> {
    const res = await app.startTile(id);
    if (res !== 'wizard' && res !== 'opened') return;
    if (id === 'merge') ui.openDialog('merge');
    else if (id === 'images') ui.openDialog('images');
    else if (id === 'split') ui.openDialog('split');
    else if (id === 'sign' && app.active) {
      app.pendingIntent = null;
      if ((await sign.sign(models(app.active).tools)) === 'creating') ui.openDialog('signature');
    }
  }
  async function sample(): Promise<void> {
    // The bundled sample is a static file of the app, never downloaded from elsewhere.
    const res = await fetch(new URL('sample.pdf', document.baseURI));
    if (!res.ok) return;
    const files = services.platform.files as unknown as { adoptBytes?(name: string, bytes: Uint8Array): { id: string; name: string } };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (files.adoptBytes) await app.openRef(files.adoptBytes('Sample form.pdf', bytes));
    else await app.adopt(await services.engine.open(bytes), 'Sample form.pdf');
  }
  const items = $derived.by((): MenuItem[] =>
    menu
      ? [
          { icon: 'file-text', label: t('action.open'), disabled: menu.card.missing, run: () => void app.openRecent(menu!.card) },
          ...(services.platform.files.capabilities.reveal ? ([{ icon: 'folder', label: t('home.reveal'), disabled: menu.card.missing, run: () => void app.revealRecent(menu!.card) }] as MenuItem[]) : []),
          { icon: 'x', label: t('home.removeFromList'), run: () => void app.removeRecent(menu!.card.id) },
        ]
      : [],
  );
  const when = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
</script>

<div id="home">
  <div class="hwrap">
    <div>
      <h1>{t(app.greeting())}</h1>
      <p class="note" style="margin-top:4px;font-size:14px">{t('home.subtitle')}</p>
    </div>
    <div class="dz">
      <div class="big"><Icon name="file-up" /></div>
      <div style="font-size:15px;color:var(--color-fg);font-weight:500">{t('home.drop')} <button class="link" style="font-size:15px" onclick={() => app.openDialog()}>{t('home.openLink')}</button></div>
      <div class="note">{formatChord('Mod+O', isMac)} · {t('home.hint')} · <button class="link" onclick={sample}>{t('home.sample')}</button></div>
    </div>
    <section style="display:flex;flex-direction:column;gap:12px">
      <h2>{t('home.tasks')}</h2>
      <div class="tiles">
        {#each HOME_TILES as id (id)}
          <button class="tile" onclick={() => tile(id)}>
            <span class="ti"><Icon name={ICON[id]} /></span>
            <span>{t(`home.tile.${id}`)}<small>{t(`home.tile.${id}.d`)}</small></span>
          </button>
        {/each}
      </div>
    </section>
    <section style="display:flex;flex-direction:column;gap:12px">
      <div class="rhead">
        <h2>{t('home.recent')}</h2>
        <input type="text" bind:value={query} placeholder={t('home.searchRecent')} aria-label={t('home.searchRecent')} />
      </div>
      {#if cards.length === 0}
        <p class="note">{query ? t('home.noMatch', { query }) : t('home.noRecent')}</p>
      {/if}
      <div class="rgrid">
        {#each cards as card (card.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="rcard" class:missing={card.missing} role="button" tabindex="0" onclick={() => app.openRecent(card)} onkeydown={(e) => e.key === 'Enter' && app.openRecent(card)} oncontextmenu={(e) => (e.preventDefault(), (menu = { x: e.clientX, y: e.clientY, card }))}>
            <div class="rt">{#if card.thumbnail}<img use:png={card.thumbnail} alt="" />{:else}<Icon name="file-text" />{/if}</div>
            <b>{card.displayName}</b>
            {#if card.missing || card.folder}<small>{card.missing ? t('home.missing') : card.folder}</small>{/if}
            <small>{when(card.lastOpenedAt)}{card.pageCount ? ` · ${t('home.pages', { count: card.pageCount })}` : ''}</small>
            <button class="ib more" aria-label={t('action.more')} onclick={(e) => (e.stopPropagation(), (menu = { x: e.clientX, y: e.clientY, card }))}><Icon name="menu" /></button>
          </div>
        {/each}
      </div>
    </section>
  </div>
</div>
{#if menu}<Menu {items} anchor={menu} onclose={() => (menu = null)} />{/if}
