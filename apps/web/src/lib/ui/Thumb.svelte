<script lang="ts">
  import type { DocumentSession } from '@folio/app';
  import { untrack } from 'svelte';
  import { paint } from './raster.ts';

  let { session, page, width = 132, version = 0 }: { session: DocumentSession; page: number; width?: number; version?: number } = $props();
  let canvas: HTMLCanvasElement | undefined = $state();
  let box: HTMLDivElement | undefined = $state();
  let seen = $state(false);

  // Lazy: render only once the thumbnail scrolls into view (FR-ORG-01).
  $effect(() => {
    if (!box) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && (seen = true), { rootMargin: '300px' });
    io.observe(box);
    return () => io.disconnect();
  });
  $effect(() => {
    void version;
    if (!seen || !canvas) return;
    const ac = new AbortController();
    const target = canvas;
    const px = Math.min(200, Math.round(width * Math.min(2, window.devicePixelRatio || 1)));
    untrack(
      () =>
        void session.renderer
          .thumbnail(page, px, ac.signal)
          .then((img) => !ac.signal.aborted && paint(target, img))
          .catch(() => undefined),
    );
    return () => ac.abort();
  });
  const info = $derived(session.pageInfos[page]);
  const ratio = $derived.by(() => {
    if (!info) return 1.294;
    const rot = info.rotation % 180 !== 0;
    return rot ? info.size.width / info.size.height : info.size.height / info.size.width;
  });
</script>

<div bind:this={box} style="width:{width}px;height:{Math.round(width * ratio)}px;background:#fff">
  <canvas bind:this={canvas} style="width:100%;height:100%"></canvas>
</div>
