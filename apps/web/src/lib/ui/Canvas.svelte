<script lang="ts">
  import { layoutPages, scrollTopFor, visibleRange, wheelZoom, type DocumentSession } from '@folio/app';
  import { t, tm } from '#lib/i18n/index.ts';
  import { dep, models, run, track } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import PageView from './PageView.svelte';

  let { session }: { session: DocumentSession } = $props();
  const m = $derived(models(session));
  const v = $derived(track());
  const view = $derived(dep(v, session.view));
  const sv = $derived(dep(v, session.structureVersion));
  const hint = $derived(dep(v, m.tools.hint));
  let scroller: HTMLDivElement | undefined = $state();
  let viewport = $state({ width: 800, height: 600 });
  let scrollTop = $state(0);

  // Single-page layout shows only the current page; the others lay out every page.
  const pages = $derived.by(() => {
    void sv;
    const all = session.pageInfos.map((p, index) => ({ index, size: p.size, rotation: p.rotation }));
    return view.layout === 'single' ? all.filter((p) => p.index === view.page) : all;
  });
  const layout = $derived(layoutPages(pages, view.zoom, view.layout === 'single' ? 'continuous' : view.layout, view.rotation));
  const boxes = $derived(layout.boxes.map((b) => ({ ...b, index: pages[b.index]!.index })));
  const range = $derived(visibleRange(boxes, scrollTop, viewport.height));

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
    void view.zoomMode;
    void view.layout;
    void view.page;
    void view.rotation;
    void sv;
    session.fit(viewport);
  });
  // Scrolling reports the current page; a page change from elsewhere scrolls to it.
  let reported = -1;
  function onscroll(): void {
    scrollTop = scroller!.scrollTop;
    if (view.layout === 'single') return;
    const current = visibleRange(boxes, scrollTop, viewport.height).current;
    if (current !== session.view.page) {
      reported = current;
      session.goToPage(current);
    }
  }
  $effect(() => {
    const page = view.page;
    void view.zoom;
    void view.layout;
    if (!scroller || page === reported) return;
    reported = page;
    scroller.scrollTop = view.layout === 'single' ? 0 : scrollTopFor(boxes, page);
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
      scroller!.scrollBy({ top: (e.shiftKey ? -0.9 : 0.9) * viewport.height });
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
    } else if (e.key === 'Enter' && m.tools.ghost === null && session.selection.kind === 'annotations') {
      session.select({ kind: 'none' });
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div id="canvas" bind:this={scroller} tabindex="0" role="region" aria-label={t('ui.document')} {onscroll} {onwheel} {onkeydown}>
  {#if hint}
    <div class="callout canvashint" role="status">
      <Icon name="info" /><span>{tm(hint)}</span>
      <button class="link" onclick={() => run('tool.cover-type')}>{t('banner.useCover')}</button>
    </div>
  {/if}
  <div class="pages" style="width:{Math.max(layout.width, viewport.width)}px;height:{layout.height}px">
    {#each boxes as b (`${sv}-${b.index}`)}
      {#if range.mounted.includes(b.index) || view.layout === 'single'}
        <PageView {session} page={b.index} box={{ ...b, x: b.x + Math.max(0, (viewport.width - layout.width) / 2) }} visible={true} />
      {/if}
    {/each}
  </div>
</div>
