<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '#lib/i18n/index.ts';
  import { app, dep, track, ui, wizards } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  // svelte-ignore state_referenced_locally
  const w = wizards.aiDebug();
  const v = $derived(track());
  $effect(() => {
    untrack(() => void w.refresh());
  });
  const all = $derived(dep(v, w.entries.length > 0 && w.selected.size === w.entries.length));
  const time = (iso: string): string => new Date(iso).toLocaleTimeString();
  async function copy(): Promise<void> {
    await w.copy();
    app.toast('success', { key: 'aiDebug.copied' });
  }
</script>

<Dialog title={t('aiDebug.title')} width={780} onclose={() => ui.closeDialog()}>
  <p class="note" style="margin:0">{t('aiDebug.intro')}</p>
  {#if dep(v, w.entries).length === 0}
    <p style="margin:0" data-testid="ai-debug-empty">{t('aiDebug.empty')}</p>
  {:else}
    <div class="field">
      <span class="lab">{t('aiDebug.list')}</span>
      <label class="aid-check"><input type="checkbox" checked={all} onchange={(e) => w.selectAll(e.currentTarget.checked)} />{t('aiDebug.selectAll')}</label>
      <ul class="aid-list" aria-label={t('aiDebug.list')}>
        {#each dep(v, w.entries) as e (e.id)}
          <li>
            <label>
              <input type="checkbox" checked={dep(v, w.selected.has(e.id))} onchange={(ev) => w.toggle(e.id, ev.currentTarget.checked)} />
              <b>#{e.id} {e.kind}</b>
              <span>{t('aiDebug.meta', { time: time(e.at), model: e.model, status: e.status === null ? t('aiDebug.status.none') : t('aiDebug.status.http', { code: e.status }), ms: e.durationMs })}</span>
            </label>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  <label class="aid-check"><input type="checkbox" checked={dep(v, w.includeDocumentText)} onchange={(e) => w.setIncludeDocumentText(e.currentTarget.checked)} />{t('aiDebug.includeText')}</label>
  <div class="field">
    <label for="aid-out">{t('aiDebug.output')}</label>
    <textarea id="aid-out" class="aid-out" readonly rows="12" spellcheck="false" value={dep(v, w.output)}></textarea>
  </div>
  {#snippet footer()}
    <button class="btn danger" disabled={dep(v, w.entries).length === 0} onclick={() => w.clear()}>{t('aiDebug.clear')}</button>
    <button class="btn" onclick={() => ui.closeDialog()}>{t('action.close')}</button>
    <button class="btn primary" disabled={!dep(v, w.output)} onclick={copy}><Icon name="copy" />{t('aiDebug.copy')}</button>
  {/snippet}
</Dialog>

<style>
  .aid-list { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow: auto; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .aid-list li { padding: 6px 10px; border-bottom: 1px solid var(--color-border); }
  .aid-list li:last-child { border-bottom: 0; }
  .aid-list label { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
  .aid-list span { color: var(--color-fg-muted, inherit); font-size: 12px; }
  .aid-check { display: flex; align-items: center; gap: 8px; }
  .aid-out { font: 12px/1.45 ui-monospace, monospace; white-space: pre; overflow: auto; width: 100%; box-sizing: border-box; user-select: text; }
</style>
