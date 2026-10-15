<script lang="ts">
  import type { DocumentSession, SidebarTab } from '@folio/app';
  import type { AttachmentInfo, OutlineNode } from '@folio/ports';
  import type { ListedAnnotation } from '@folio/services';
  import { formatBytes, parsePdfDate } from '@folio/core';
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, models, raw, services, track, trackPage } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import Thumb from './Thumb.svelte';
  import { rgb } from './raster.ts';
  import { tip } from './tip.ts';

  let { session }: { session: DocumentSession } = $props();
  const m = $derived(models(session));
  const tab = $derived(dep(track(), session.sidebarTab));
  const page = $derived(dep(trackPage(), raw(session).view.page));
  const count = $derived(dep(track(), session.pageCount));
  const sv = $derived(dep(track(), session.structureVersion));
  const find = $derived(dep(track(), m.find));
  const TABS: Array<[SidebarTab, string, string]> = [['thumbnails', 'layout-list', 'ui.thumbnails'], ['outline', 'list-tree', 'ui.outline'], ['annotations', 'messages-square', 'ui.annotations'], ['attachments', 'paperclip', 'ui.attachments'], ['search', 'search', 'ui.searchResults']];
  const ICON: Record<string, string> = { highlight: 'highlighter', underline: 'underline', strikeout: 'strikethrough', squiggly: 'spline', text: 'message-square', freetext: 'type', line: 'minus', square: 'square', circle: 'circle', polyline: 'waypoints', polygon: 'waypoints', ink: 'pen-line', stamp: 'stamp', other: 'paperclip' };
  const LABEL: Record<string, string> = { highlight: 'ui.highlight', underline: 'ui.underline', strikeout: 'ui.strikeout', squiggly: 'ui.squiggly', text: 'ui.note', freetext: 'ui.textbox', line: 'ui.line', square: 'ui.rectangle', circle: 'ui.ellipse', polyline: 'ui.polyline', polygon: 'ui.polyline', ink: 'ui.line', stamp: 'ui.stamp', other: 'ui.other' };

  const om = $derived(dep(track(), m.outline));
  const outline = $derived(dep(track(), om.tree));
  const collapsed = $derived(dep(track(), om.collapsed));
  const editing = $derived(dep(track(), om.editing));
  const selPath = $derived(dep(track(), om.selected));
  const renaming = $derived(dep(track(), om.renaming));
  const removed = $derived(dep(track(), om.removed));
  let dragFrom = $state<number[] | null>(null);
  let dropOn = $state<string | null>(null);
  let newTitle = $state('');
  const same = (a: number[] | null, b: number[]): boolean => !!a && a.join('.') === b.join('.');
  function onTreeKey(e: KeyboardEvent, path: number[], target: OutlineNode['target']): void {
    if (e.target instanceof HTMLInputElement) return;
    if (!editing) return void (e.key === 'Enter' && app.followLink(target, session));
    const mod = (k: string): boolean => (e.key === k) && !e.ctrlKey && !e.metaKey;
    if (mod('F2')) om.startRename(path);
    else if (mod('Delete')) void om.remove(path);
    else if (e.key === 'Tab') void om.move(e.shiftKey ? 'outdent' : 'indent', path);
    else if (e.altKey && e.key === 'ArrowUp') void om.move('up', path);
    else if (e.altKey && e.key === 'ArrowDown') void om.move('down', path);
    else if (e.key === 'Enter') app.followLink(target, session);
    else return;
    e.preventDefault();
  }
  let annots = $state<ListedAnnotation[]>([]);
  let attachments = $state<AttachmentInfo[]>([]);
  let filter = $state<string>('all');
  const flat = $derived(session.nav.flatten(outline, collapsed));
  const shown = $derived(annots.filter((a) => filter === 'all' || a.annotation.type === filter));
  const types = $derived([...new Set(annots.map((a) => a.annotation.type))]);

  $effect(() => {
    void sv;
    if (tab === 'outline') void om.load();
    if (tab === 'attachments') void session.doc.listAttachments().then((a) => (attachments = a));
  });
  // The annotation list follows every change of the document.
  $effect(() => {
    void track();
    if (tab === 'annotations') void services.annotations.list(session.doc).then((a) => (annots = a));
  });
  function toggle(path: string): void {
    om.toggleCollapsed(path.split('.').map(Number));
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
      <div class="row" style="padding:4px 8px;gap:4px;flex-wrap:wrap">
        <button class="btn sm" aria-pressed={editing} onclick={() => om.setEditing(!editing)}><Icon name="pencil" />{t('bookmarks.edit')}</button>
        {#if editing}
          <button class="ib" aria-label={t('bookmarks.addSibling')} use:tip={t('bookmarks.addSibling')} onclick={() => om.add(t('bookmarks.newTitle', { page: page + 1 }))}><Icon name="plus" /></button>
          <button class="ib" aria-label={t('bookmarks.addChild')} use:tip={t('bookmarks.addChild')} disabled={!selPath} onclick={() => om.add(t('bookmarks.newTitle', { page: page + 1 }), true)}><Icon name="corner-down-right" /></button>
          <button class="ib" aria-label={t('bookmarks.rename')} use:tip={t('bookmarks.rename')} disabled={!selPath} onclick={() => om.startRename()}><Icon name="text-cursor-input" /></button>
          <button class="ib" aria-label={t('bookmarks.indent')} use:tip={t('bookmarks.indent')} disabled={!selPath} onclick={() => om.move('indent')}><Icon name="indent" /></button>
          <button class="ib" aria-label={t('bookmarks.outdent')} use:tip={t('bookmarks.outdent')} disabled={!selPath} onclick={() => om.move('outdent')}><Icon name="outdent" /></button>
          <button class="ib" aria-label={t('bookmarks.up')} use:tip={t('bookmarks.up')} disabled={!selPath} onclick={() => om.move('up')}><Icon name="arrow-up" /></button>
          <button class="ib" aria-label={t('bookmarks.down')} use:tip={t('bookmarks.down')} disabled={!selPath} onclick={() => om.move('down')}><Icon name="arrow-down" /></button>
          <button class="ib" aria-label={t('bookmarks.target')} use:tip={t('bookmarks.target')} disabled={!selPath} onclick={() => om.setTargetHere()}><Icon name="locate-fixed" /></button>
          <button class="ib" aria-label={t('action.delete')} use:tip={t('action.delete')} disabled={!selPath} onclick={() => om.remove()}><Icon name="trash-2" /></button>
        {/if}
      </div>
      {#if flat.length === 0}
        <p class="note">{t('ui.noOutline')}</p>
      {:else}
        <ul class="tree" role="tree" aria-label={t('ui.outline')}>
          {#each flat as item (item.path.join('.'))}
            {@const key = item.path.join('.')}
            <li role="treeitem" aria-level={item.depth + 1} aria-selected={same(selPath, item.path)} class:on={same(selPath, item.path)} class:drop={dropOn === key}
              style="padding-left:{8 + item.depth * 14}px" tabindex="0" draggable={editing}
              onclick={() => (editing ? om.select(item.path) : app.followLink(item.target, session))}
              ondblclick={() => editing && om.startRename(item.path)}
              onfocus={() => editing && !same(selPath, item.path) && om.select(item.path)}
              onkeydown={(e) => onTreeKey(e, item.path, item.target)}
              ondragstart={() => (dragFrom = item.path)} ondragover={(e) => { if (dragFrom) { e.preventDefault(); dropOn = key; } }}
              ondragend={() => ((dragFrom = null), (dropOn = null))}
              ondrop={(e) => { e.preventDefault(); const from = dragFrom; dragFrom = null; dropOn = null; if (from) void om.drop(from, item.path); }}>
              <span style="display:flex;gap:4px;align-items:center;min-width:0">
                {#if item.hasChildren}
                  <button class="link" style="color:inherit;display:inline-flex" aria-label={collapsed.has(key) ? t('action.show') : t('action.hide')} onclick={(e) => (e.stopPropagation(), toggle(key))}><Icon name={collapsed.has(key) ? 'chevron-right' : 'chevron-down'} size={14} /></button>
                {/if}
                {#if renaming && same(renaming, item.path)}
                  <!-- svelte-ignore a11y_autofocus -->
                  <input type="text" value={item.title} maxlength="512" aria-label={t('bookmarks.rename')} autofocus style="flex:1;min-width:0"
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void om.rename(item.path, e.currentTarget.value); else if (e.key === 'Escape') om.select(item.path), (om.renaming = null); }}
                    onblur={(e) => om.renaming && void om.rename(item.path, e.currentTarget.value)} />
                {:else}
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{item.title}</span>
                {/if}
              </span>
              {#if removed.has(key)}
                <small class="warnc" title={t('bookmarks.removedHint')}>{t('bookmarks.removed')}</small>
              {:else if item.page !== undefined}<small>{item.page + 1}</small>{/if}
            </li>
          {/each}
        </ul>
        {#if editing}
          <p class="note" style="padding:8px">{om.signed ? t('bookmarks.signedNote') : t('bookmarks.keysHint')}</p>
        {/if}
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
        {#if find.query !== ''}<span class="note" style="flex:none">{find.hits.length}</span>{/if}
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
