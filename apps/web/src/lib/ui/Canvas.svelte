<script lang="ts">
  import { layoutPages, renderWindow, sameSet, scrollTopFor, wheelZoom, type DocumentSession, type RenderWindow } from '@folio/app';
  import { t, tm } from '#lib/i18n/index.ts';
  import { untrack } from 'svelte';
  import { dep, models, raw, run, track } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import PageView from './PageView.svelte';

  let { session }: { session: DocumentSession } = $props();
  const m = $derived(models(session));
  const v = $derived(track());
  // Primitives: a derived that returns an unchanged number stops the model-change counter from
  // re-running the layout of every page on each keystroke or click.
  const viewLayout = $derived(dep(v, session.view.layout));
  const viewZoom = $derived(dep(v, session.view.zoom));
  const viewPage = $derived(dep(v, session.view.page));
  const viewRotation = $derived(dep(v, session.view.rotation));
  const viewZoomMode = $derived(dep(v, session.view.zoomMode));
  const sv = $derived(dep(v, session.structureVersion));
  const hint = $derived(dep(v, m.tools.hint));
  const snapshot = $derived(['snapshot', 'table'].includes(dep(v, m.tools.tool)));
  let scroller: HTMLDivElement | undefined = $state();
  let viewport = $state({ width: 800, height: 600 });
  // Scrolling stays out of the reactive graph: the position is a plain variable and the window below
  // changes only when a page enters or leaves it.
  let scrollTop = 0;

  // Single-page layout shows only the current page; the others lay out every page.
  const pages = $derived.by(() => {
    void sv;
    const all = raw(session).pageInfos.map((p, index) => ({ index, size: p.size, rotation: p.rotation }));
    return viewLayout === 'single' ? all.filter((p) => p.index === viewPage) : all;
  });
  const layout = $derived(layoutPages(pages, viewZoom, viewLayout === 'single' ? 'continuous' : viewLayout, viewRotation));
  const boxes = $derived(layout.boxes.map((b) => ({ ...b, index: pages[b.index]!.index })));
  // Pages in the viewport render at once; the margin around it waits until scrolling stops, so a
  // fast scroll does not queue full-resolution renders of pages that are about to leave.
  let win = $state.raw<RenderWindow>({ inView: new Set(), near: new Set(), mounted: new Set(), current: 0 });
  let scrolling = $state(false);
  // The part of the canvas on screen, published when scrolling stops: pages too large for one bitmap
  // redraw only this part sharp.
  let viewWin = $state.raw({ left: 0, top: 0, right: 0, bottom: 0 });
  function publishWindow(): void {
    if (!scroller) return;
    const next = { left: scroller.scrollLeft, top: scroller.scrollTop, right: scroller.scrollLeft + scroller.clientWidth, bottom: scroller.scrollTop + scroller.clientHeight };
    if (next.left !== viewWin.left || next.top !== viewWin.top || next.right !== viewWin.right || next.bottom !== viewWin.bottom) viewWin = next;
  }
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  const renders = (i: number): boolean => viewLayout === 'single' || win.inView.has(i) || (!scrolling && win.near.has(i));
  let reported = -1;
  // Dragging the scrollbar jumps over many pages per frame. Mounting a full page view for each (about
  // twenty reactive values, engine calls for annotations and links) costs more than a frame, so while
  // the position moves faster than `FAST` viewports per update, pages not yet mounted stay as plain
  // white boxes; they become real views when the scroll slows down.
  const FAST = 0.4;
  let heavy = $state.raw<ReadonlySet<number>>(new Set());
  let lastTop = 0;
  let streak = 0;
  let lite = false;
  function update(): void {
    frame = 0;
    if (scroller) scrollTop = scroller.scrollTop;
    // Two fast updates in a row: a single jump (Page Down, a bookmark) is not a drag and mounts at once.
    streak = Math.abs(scrollTop - lastTop) > viewport.height * FAST ? streak + 1 : 0;
    lite = streak >= 2;
    lastTop = scrollTop;
    const next = renderWindow(boxes, scrollTop, viewport.height, win.mounted);
    if (!sameSet(next.mounted, win.mounted) || !sameSet(next.inView, win.inView) || !sameSet(next.near, win.near)) win = next;
    const allowed = lite ? new Set([...next.mounted].filter((i) => heavy.has(i))) : next.mounted;
    if (!sameSet(allowed, heavy)) heavy = allowed;
    if (viewLayout === 'single') return;
    // Scrolling reports the current page; a page change from elsewhere scrolls to it.
    if (next.current !== raw(session).view.page) {
      reported = next.current;
      session.reportPage(next.current);
    }
  }
  $effect(() => {
    void boxes;
    void viewport;
    void viewLayout;
    untrack(() => (update(), publishWindow()));
  });
  $effect(() => () => (clearTimeout(idleTimer), frame && cancelAnimationFrame(frame)));

  $effect(() => {
    if (!scroller) return;
    const ro = new ResizeObserver(() => {
      viewport = { width: scroller!.clientWidth, height: scroller!.clientHeight };
    });
    ro.observe(scroller);
    return () => ro.disconnect();
  });
  // Fit modes follow the viewport and the page being read.
  $effect(() => {
    void viewZoomMode;
    void viewLayout;
    void viewPage;
    void viewRotation;
    void sv;
    session.fit(viewport);
  });
  function onscroll(): void {
    if (!scroller) return; // a late scroll event while the canvas is being replaced
    scrollTop = scroller.scrollTop;
    scrolling = true;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ((scrolling = false), (streak = 0), update(), publishWindow()), 80);
    if (!frame) frame = requestAnimationFrame(update);
  }
  $effect(() => {
    const page = viewPage;
    void viewZoom;
    void viewLayout;
    if (!scroller || page === reported) return;
    reported = page;
    scroller.scrollTop = viewLayout === 'single' ? 0 : scrollTopFor(boxes, page);
  });
  // The current search match is brought into view below the floating find bar.
  const findOpen = $derived(dep(v, m.find.open));
  const matchIndex = $derived(dep(v, m.find.open ? m.find.current : -1));
  $effect(() => {
    if (matchIndex < 0 || !scroller) return;
    void viewZoom;
    const host = scroller;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const hit = host.querySelector<HTMLElement>('.hit.cur');
        if (!hit) return;
        const a = hit.getBoundingClientRect();
        const b = host.getBoundingClientRect();
        const top = a.top - b.top;
        const FIND_BAR = 64;
        if (top < FIND_BAR || a.bottom - b.top > b.height - 16) host.scrollTop += top - b.height / 3;
      }),
    );
  });
  function onwheel(e: WheelEvent): void {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    session.setZoom('custom', wheelZoom(session.view.zoom, e.deltaY));
  }
  function onkeydown(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    if (e.key === ' ') {
      e.preventDefault();
      scroller?.scrollBy({ top: (e.shiftKey ? -0.9 : 0.9) * viewport.height });
    } else if (e.key.startsWith('Arrow') && session.selection.kind === 'annotations') {
      e.preventDefault();
      void m.tools.nudgeSelection(e.key as 'ArrowLeft', e.shiftKey);
    } else if (e.key === 'Tab' && session.mode === 'fill' && !(e.target as HTMLElement).closest('.fld')) {
      // The first Tab on the canvas moves into the first field (FR-FRM-02).
      const stop = m.form.tab(e.shiftKey ? -1 : 1);
      if (stop) {
        e.preventDefault();
        requestAnimationFrame(() => scroller?.querySelector<HTMLElement>('.fld')?.focus());
      }
    } else if (
      e.key === 'Enter' &&
      !e.repeat &&
      !m.tools.typing &&
      (m.tools.tool !== 'select' || session.selection.kind === 'text')
    ) {
      // Keyboard path for every click-to-place tool: place it at the centre of the page, then use the arrows.
      e.preventDefault();
      void m.tools.placeWithKeyboard(session.view.page);
    } else if (e.key === 'Enter' && m.tools.ghost === null && session.selection.kind === 'annotations') {
      session.select({ kind: 'none' });
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div id="canvas" class:finding={findOpen} bind:this={scroller} tabindex="0" role="region" aria-label={t('ui.document')} {onscroll} {onwheel} {onkeydown}>
  {#if hint}
    <div class="callout canvashint" role="status">
      <Icon name="info" /><span>{tm(hint)}</span>
      <button class="link" onclick={() => run('tool.cover-type')}>{t('banner.useCover')}</button>
    </div>
  {:else if snapshot}
    <div class="callout canvashint" role="status"><Icon name="info" /><span>{t('hint.snapshot')}</span></div>
  {/if}
  <div class="pages" style="width:{Math.max(layout.width, viewport.width)}px;height:{layout.height}px">
    {#each boxes as b (`${sv}-${b.index}`)}
      {#if viewLayout !== 'single' && win.mounted.has(b.index) && !heavy.has(b.index)}
        <div class="pv" style="left:{b.x + Math.max(0, (viewport.width - layout.width) / 2)}px;top:{b.y}px;width:{b.width}px;height:{b.height}px" aria-hidden="true"></div>
      {:else if heavy.has(b.index) || viewLayout === 'single'}
        <PageView {session} page={b.index} box={{ ...b, x: b.x + Math.max(0, (viewport.width - layout.width) / 2) }} visible={renders(b.index)} {scrolling} urgent={win.inView.has(b.index)} {viewWin} />
      {/if}
    {/each}
  </div>
</div>
