<script lang="ts" module>
  export type MenuItem =
    | { kind?: 'item'; icon?: string; label: string; shortcut?: string; checked?: boolean; disabled?: boolean; danger?: boolean; run: () => void }
    | { kind: 'sep' }
    | { kind: 'head'; label: string }
    | { kind: 'swatches'; colors: string[]; current?: string; pick: (c: string) => void }
    | { kind: 'custom'; id: string };
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  let { items, anchor, onclose, custom }: { items: MenuItem[]; anchor: { x: number; y: number; right?: boolean }; onclose: () => void; custom?: Snippet<[string]> } = $props();
  let el: HTMLDivElement | undefined = $state();
  let pos = $state({ left: 0, top: 0 });

  $effect(() => {
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    pos = { left: Math.max(6, Math.min(window.innerWidth - w - 6, anchor.right ? anchor.x - w : anchor.x)), top: Math.max(6, Math.min(window.innerHeight - h - 6, anchor.y)) };
    el.querySelector<HTMLElement>('.mi:not([disabled])')?.focus();
  });
  function onkeydown(e: KeyboardEvent): void {
    const list = [...(el?.querySelectorAll<HTMLElement>('.mi:not([disabled]), .sigprev, .swatch') ?? [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') onclose();
    else if (e.key === 'ArrowDown') list[(at + 1) % list.length]?.focus();
    else if (e.key === 'ArrowUp') list[(at - 1 + list.length) % list.length]?.focus();
    else if (e.key === 'Home') list[0]?.focus();
    else if (e.key === 'End') list[list.length - 1]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="menuwrap" onpointerdown={(e) => e.target === e.currentTarget && onclose()} oncontextmenu={(e) => (e.preventDefault(), onclose())}>
  <div id="menu" role="menu" tabindex="-1" bind:this={el} style="left:{pos.left}px;top:{pos.top}px" {onkeydown}>
    {#each items as item, i (i)}
      {#if item.kind === 'sep'}
        <div class="msep" role="separator"></div>
      {:else if item.kind === 'head'}
        <div class="mh">{item.label}</div>
      {:else if item.kind === 'swatches'}
        <div class="msw">
          {#each item.colors as c (c)}
            <button class="swatch" class:on={c === item.current} style="background:{c}" aria-label={c} onclick={() => (item.pick(c), onclose())}></button>
          {/each}
        </div>
      {:else if item.kind === 'custom'}
        {@render custom?.(item.id)}
      {:else}
        <button class="mi" class:on={item.checked} class:danger={item.danger} role="menuitem" disabled={item.disabled} onclick={() => (onclose(), item.run())}>
          {#if item.icon}<Icon name={item.icon} />{/if}
          <span class="grow">{item.label}</span>
          {#if item.shortcut}<kbd>{item.shortcut}</kbd>{/if}
          {#if item.checked}<Icon name="check" />{/if}
        </button>
      {/if}
    {/each}
  </div>
</div>
