<script lang="ts">
  import type { DocumentSession, SidebarTab } from '@folio/app';
  import type { AttachmentInfo, OutlineNode } from '@folio/ports';
  import type { ListedAnnotation } from '@folio/services';
  import { formatBytes, parsePdfDate } from '@folio/core';
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, models, services, track } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import Thumb from './Thumb.svelte';
  import { rgb } from './raster.ts';
  import { tip } from './tip.ts';

  let { session }: { session: DocumentSession } = $props();
  const m = $derived(models(session));
  const tab = $derived(dep(track(), session.sidebarTab));
  const page = $derived(dep(track(), session.view.page));
  const count = $derived(dep(track(), session.pageCount));
  const sv = $derived(dep(track(), session.structureVersion));
  const find = $derived(dep(track(), m.find));
  const TABS: Array<[SidebarTab, string, string]> = [['thumbnails', 'layout-list', 'ui.thumbnails'], ['outline', 'list-tree', 'ui.outline'], ['annotations', 'messages-square', 'ui.annotations'], ['attachments', 'paperclip', 'ui.attachments'], ['search', 'search', 'ui.searchResults']];
  const ICON: Record<string, string> = { highlight: 'highlighter', underline: 'underline', strikeout: 'strikethrough', squiggly: 'spline', text: 'message-square', freetext: 'type', line: 'minus', square: 'square', circle: 'circle', polyline: 'waypoints', polygon: 'waypoints', ink: 'pen-line', stamp: 'stamp', other: 'paperclip' };
  const LABEL: Record<string, string> = { highlight: 'ui.highlight', underline: 'ui.underline', strikeout: 'ui.strikeout', squiggly: 'ui.squiggly', text: 'ui.note', freetext: 'ui.textbox', line: 'ui.line', square: 'ui.rectangle', circle: 'ui.ellipse', polyline: 'ui.polyline', polygon: 'ui.polyline', ink: 'ui.line', stamp: 'ui.stamp', other: 'ui.other' };

  let outline = $state<OutlineNode[]>([]);
  let collapsed = $state(new Set<string>());
  let annots = $state<ListedAnnotation[]>([]);
  let attachments = $state<AttachmentInfo[]>([]);
  let filter = $state<string>('all');
  const flat = $derived(session.nav.flatten(outline, collapsed));
  const shown = $derived(annots.filter((a) => filter === 'all' || a.annotation.type === filter));
  const types = $derived([...new Set(annots.map((a) => a.annotation.type))]);

  $effect(() => {
    void sv;
    if (tab === 'outline') void session.nav.outline().then((o) => (outline = o));
    if (tab === 'attachments') void session.doc.listAttachments().then((a) => (attachments = a));
  });
  // The annotation list follows every change of the document.
  $effect(() => {
    void track();
    if (tab === 'annotations') void services.annotations.list(session.doc).then((a) => (annots = a));
  });
  function toggle(path: string): void {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsed = next;
  }
  function selectAnnot(a: ListedAnnotation): void {
    session.goToPage(a.page);
    if (a.annotation.id) session.select({ kind: 'annotations', page: a.page, ids: [a.annotation.id] });
  }
  async function bulkDelete(): Promise<void> {
    const items = shown.filter((a) => !a.annotation.locked);
    if (items.length) await app.guard(() => session.run(services.annotations.remove(items)));
  }
  async function saveAttachment(a: AttachmentInfo): Promise<void> {
    // Attachments are saved only after an explicit action; they are never opened (FR-SEC-05).
    const ref = await services.platform.files.pickSave({ suggestedName: a.name, kind: 'any' });
    if (ref) await app.guard(async () => services.platform.files.write(ref, await session.doc.getAttachment(a.index), { atomic: true }));
  }
  const when = (s?: string): string => parsePdfDate(s)?.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) ?? '';
  let thumbBody: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (tab === 'thumbnails') thumbBody?.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'nearest' });
  });
</script>

<aside id="sidebar" aria-label={t('ui.sidebar')}>
  <div class="sbtabs" role="tablist">
    {#each TABS as [id, icon, label] (id)}
      <button class="ib" class:on={tab === id} role="tab" aria-selected={tab === id} onclick={() => session.setSidebarTab(id)} use:tip={t(label)} aria-label={t(label)}><Icon name={icon} /></button>
    {/each}
  </div>
  <div class="sbbody" bind:this={thumbBody}>
    {#if tab === 'thumbnails'}
      {#each { length: count } as _, i (`${sv}-${i}`)}
        <button class="thumb" class:on={page === i} data-page={i} onclick={() => session.goToPage(i)} aria-label="{t('ui.page')} {i + 1}" aria-current={page === i ? 'page' : undefined}>
          <div class="tp"><Thumb {session} page={i} width={132} version={sv} /></div>
          <span class="n">{session.pageInfos[i]?.label ?? i + 1}</span>
        </button>
      {/each}
    {:else if tab === 'outline'}
      {#if flat.length === 0}
        <p class="note">{t('ui.noOutline')}</p>
      {:else}
        <ul class="tree" role="tree">
          {#each flat as item (item.path.join('.'))}
            <li role="treeitem" aria-selected="false" style="padding-left:{8 + item.depth * 14}px" tabindex="0" onclick={() => app.followLink(item.target, session)} onkeydown={(e) => e.key === 'Enter' && app.followLink(item.target, session)}>
              <span style="display:flex;gap:4px;align-items:center;min-width:0">
                {#if item.hasChildren}
                  <button class="link" style="color:inherit;display:inline-flex" aria-label={collapsed.has(item.path.join('.')) ? t('action.show') : t('action.hide')} onclick={(e) => (e.stopPropagation(), toggle(item.path.join('.')))}><Icon name={collapsed.has(item.path.join('.')) ? 'chevron-right' : 'chevron-down'} size={14} /></button>
                {/if}
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{item.title}</span>
              </span>
              {#if item.page !== undefined}<small>{item.page + 1}</small>{/if}
            </li>
          {/each}
        </ul>
        <p class="note" style="padding:8px">{t('ui.outlineReadOnly')}</p>
      {/if}
    {:else if tab === 'annotations'}
      {#if annots.length === 0}
        <p class="note">{t('ui.noAnnotations')}</p>
      {:else}
        <div class="fchips">
          <button class="chip" class:on={filter === 'all'} onclick={() => (filter = 'all')}>{t('ui.all')} {annots.length}</button>
          {#each types as ty (ty)}
            <button class="chip" class:on={filter === ty} onclick={() => (filter = ty)}>{t(LABEL[ty] ?? 'ui.other')}</button>
          {/each}
        </div>
        {#each shown as a (`${a.page}-${a.annotation.id}`)}
          {@const sel = session.selection.kind === 'annotations' && session.selection.ids.includes(a.annotation.id ?? '')}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="ann" class:on={sel} role="button" tabindex="0" onclick={() => selectAnnot(a)} onkeydown={(e) => e.key === 'Enter' && selectAnnot(a)}>
            <span class="ai sm-ic" style="background:{rgb(a.annotation.color) === 'transparent' ? '#dbeafe' : rgb(a.annotation.color)};color:#1b1f27"><Icon name={ICON[a.annotation.type] ?? 'paperclip'} /></span>
            <div style="min-width:0">
              <b>{t(LABEL[a.annotation.type] ?? 'ui.other')}</b>
              {#if a.annotation.contents}<p style="overflow:hidden;text-overflow:ellipsis">{a.annotation.contents}</p>{/if}
              <small>{t('ui.page')} {a.page + 1}{a.annotation.author ? ` · ${a.annotation.author}` : ''}{when(a.annotation.modified) ? ` · ${when(a.annotation.modified)}` : ''}</small>
            </div>
          </div>
        {/each}
        <button class="btn sm danger" style="margin-top:8px" onclick={bulkDelete}><Icon name="trash-2" />{t('ui.bulkDelete')}</button>
      {/if}
    {:else if tab === 'attachments'}
      {#if attachments.length === 0}
        <p class="note">{t('ui.noAttachments')}</p>
      {:else}
        {#each attachments as a (a.index)}
          <div class="ann">
            <span class="ai sm-ic" style="background:var(--color-surface-2)"><Icon name="paperclip" /></span>
            <div style="min-width:0;flex:1"><b style="word-break:break-all">{a.name}</b><small>{formatBytes(a.size)}</small></div>
            <button class="ib" onclick={() => saveAttachment(a)} use:tip={t('ui.attachmentSave')} aria-label={t('ui.attachmentSave')}><Icon name="download" /></button>
          </div>
        {/each}
      {/if}
    {:else}
      <div class="row" style="margin-bottom:8px">
        <input type="text" value={find.query} oninput={(e) => (find.toggle(true), void find.setQuery(e.currentTarget.value))} placeholder={t('ui.findPlaceholder')} aria-label={t('ui.find')} style="flex:1" />
        <span class="note">{find.hits.length}</span>
      </div>
      {#if find.query === ''}
        <p class="note">{t('ui.typeToSearch')}</p>
      {:else if find.hits.length === 0 && !find.searching}
        <p class="note">{t('ui.noResults')}</p>
      {/if}
      {#each find.hits.slice(0, 300) as h, i (i)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="res" class:on={i === find.current} role="button" tabindex="0" onclick={() => find.select(i)} onkeydown={(e) => e.key === 'Enter' && find.select(i)}>
          <small>{t('ui.page')} {h.page + 1}</small>…{h.snippet.before}<mark>{h.snippet.match}</mark>{h.snippet.after}…
        </div>
      {/each}
    {/if}
  </div>
</aside>
