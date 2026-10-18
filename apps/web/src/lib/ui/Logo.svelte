<script lang="ts">
  import { assets } from '$app/paths';
  // The Folio symbol (assets/branding): dark-background variant is swapped in by the theme CSS.
  let { size = 20 }: { size?: number } = $props();
</script>

<img class="lg lg-light" src="{assets}/brand/folio-symbol.svg" width={size} height={size} alt="" draggable="false" />
<img class="lg lg-dark" src="{assets}/brand/folio-symbol-dark.svg" width={size} height={size} alt="" draggable="false" />
