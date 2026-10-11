<script lang="ts">
  import { t, tm } from '#lib/i18n/index.ts';
  import { dep, app, services, track } from '#lib/state.svelte.ts';

  const toasts = $derived(dep(track(), app.toasts));
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  // Plain toasts go away by themselves; errors and progress stay until dismissed or finished.
  $effect(() => {
    for (const toast of toasts) {
      if (timers.has(toast.id) || toast.kind === 'error' || toast.progress !== undefined) continue;
      timers.set(toast.id, setTimeout(() => app.dismissToast(toast.id), toast.action ? 7000 : 4000));
    }
  });
  let copied = $state<number | null>(null);
  async function copyDiagnostics(id: number, detail: string): Promise<void> {
    await services.platform.clipboard.writeText(`${detail}\n\n${services.platform.log.dump()}`).catch(() => undefined);
    copied = id;
  }
</script>

<div id="toasts" aria-live="polite">
  {#each toasts as toast (toast.id)}
    <div class="toast {toast.kind}" role={toast.kind === 'error' ? 'alert' : 'status'}>
      <div class="msg">
        {tm(toast.message)}
        {#if toast.detail}
          <details>
            <summary>{t('action.details')}</summary>
            <pre>{toast.detail}</pre>
            <button onclick={() => copyDiagnostics(toast.id, toast.detail!)}>{copied === toast.id ? t('action.copied') : t('action.copyDiagnostics')}</button>
          </details>
        {/if}
      </div>
      {#if toast.progress !== undefined}<span class="pb"><i style="width:{Math.round(toast.progress * 100)}%"></i></span>{/if}
      {#if toast.action}<button onclick={() => (toast.action!.run(), app.dismissToast(toast.id))}>{tm(toast.action.label)}</button>{/if}
      {#if toast.cancel}<button onclick={toast.cancel}>{t('action.cancel')}</button>{/if}
      {#if toast.kind === 'error' || toast.kind === 'warning'}<button onclick={() => app.dismissToast(toast.id)} aria-label={t('action.dismiss')}>✕</button>{/if}
    </div>
  {/each}
</div>
