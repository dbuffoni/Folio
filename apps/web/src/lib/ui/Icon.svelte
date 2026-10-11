<script lang="ts">
  import { ICONS } from './icons.ts';
  let { name, size, class: cls = '' }: { name: string; size?: number; class?: string } = $props();
  const Cmp = $derived(ICONS[name]);
</script>

{#if Cmp}<Cmp {size} class={cls} aria-hidden="true" />{/if}
