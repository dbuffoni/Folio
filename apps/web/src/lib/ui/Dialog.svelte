<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '#lib/i18n/index.ts';
  import Icon from './Icon.svelte';

  let { title, width = 560, onclose, children, footer, top = false, closable = true }: { title: string; width?: number; onclose: () => void; children: Snippet; footer?: Snippet; top?: boolean; closable?: boolean } = $props();
  let dialog: HTMLDivElement | undefined = $state();
  let previous: Element | null = null;

  // Focus moves into the dialog, is trapped there, and returns to where it was on close.
  $effect(() => {
    previous = document.activeElement;
    const first = dialog?.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]), select, textarea, button.primary');
    (first ?? dialog)?.focus();
    return () => (previous as HTMLElement | null)?.focus?.();
  });
  // A body that scrolls must be reachable with the keyboard even when it holds no control.
  function scrollable(node: HTMLElement) {
    const update = (): void => {
      if (node.scrollHeight > node.clientHeight + 1) node.tabIndex = 0;
      else node.removeAttribute('tabindex');
    };
    const ro = new ResizeObserver(update);
    ro.observe(node);
    for (const child of node.children) ro.observe(child);
    update();
    return { destroy: () => ro.disconnect() };
  }
  function onkeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && closable) {
      e.stopPropagation();
      onclose();
    } else if (e.key === 'Tab' && dialog) {
      const items = [...dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    // Keys typed in a dialog never reach the document shortcuts.
    e.stopPropagation();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" class:top onpointerdown={(e) => e.target === e.currentTarget && closable && onclose()} {onkeydown}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label={title} style="width:{width}px" tabindex="-1" bind:this={dialog}>
    <header>
      <h2>{title}</h2>
      {#if closable}<button class="ib" onclick={onclose} aria-label={t('action.close')}><Icon name="x" /></button>{/if}
    </header>
    <div class="body" use:scrollable>{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  </div>
</div>
