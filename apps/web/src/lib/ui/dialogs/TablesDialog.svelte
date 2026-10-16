<script lang="ts">
  import { untrack } from 'svelte';
  import type { DocumentSession } from '@folio/app';
  import { t } from '#lib/i18n/index.ts';
  import { dep, models, track, ui } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  let { session }: { session: DocumentSession } = $props();
  const m = $derived(models(session).tables);
  const v = $derived(track());
  let aiOk = $state(false);
  $effect(() => {
    untrack(() => {
      // Opened from the menu: the whole current page. Opened by the area tool: the grid is already there.
      if (!m.open) void m.extract(session.view.page, null);
      void m.aiAvailable().then((ok) => (aiOk = ok));
    });
  });
  const rows = $derived(dep(v, m.rows));
  const cols = $derived(dep(v, m.columns));
  function close(): void {
    m.cancel();
    m.close();
    ui.closeDialog();
  }
</script>

<Dialog title={t('tables.title')} width={760} onclose={close}>
  <p class="note" style="margin:0">{t('tables.hint', { page: m.page + 1 })}</p>
  {#if m.skippedRotated}<div class="callout"><Icon name="info" /><span>{t('tables.rotated')}</span></div>{/if}
  {#if m.busy}<p role="status">{t('tables.working')}</p>{/if}
  {#if !m.busy && m.empty}<div class="callout warn" role="status"><Icon name="triangle-alert" /><span>{t('tables.empty')}</span></div>{/if}
  {#if rows.length}
    <div class="tgrid" role="region" aria-label={t('tables.grid')} style="overflow:auto;max-height:340px">
      <table data-testid="table-grid">
        <thead>
          <tr><th></th>{#each Array.from({ length: cols }, (_, i) => i) as c (c)}
            <th>
              <span class="row" style="gap:2px;justify-content:center">
                <button class="ib" onclick={() => m.mergeColumns(c)} disabled={c >= cols - 1} aria-label={t('tables.mergeColumn', { n: c + 1 })} title={t('tables.mergeColumn', { n: c + 1 })}><Icon name="combine" size={13} /></button>
                <button class="ib" onclick={() => m.splitColumn(c)} aria-label={t('tables.splitColumn', { n: c + 1 })} title={t('tables.splitColumn', { n: c + 1 })}><Icon name="scissors" size={13} /></button>
                <button class="ib" onclick={() => m.deleteColumn(c)} aria-label={t('tables.deleteColumn', { n: c + 1 })} title={t('tables.deleteColumn', { n: c + 1 })}><Icon name="x" size={13} /></button>
              </span>
            </th>
          {/each}</tr>
        </thead>
        <tbody>
          {#each rows as row, r (r)}
            <tr class:header={m.header && r === 0}>
              <th scope="row"><button class="ib" onclick={() => m.deleteRow(r)} aria-label={t('tables.deleteRow', { n: r + 1 })}><Icon name="x" size={13} /></button></th>
              {#each Array.from({ length: cols }, (_, i) => i) as c (c)}
                <td><input type="text" value={row[c] ?? ''} aria-label={t('tables.cell', { row: r + 1, col: c + 1 })} onchange={(e) => m.setCell(r, c, e.currentTarget.value)} /></td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="row" style="gap:16px;flex-wrap:wrap">
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" checked={m.header} onchange={(e) => m.setOptions({ header: e.currentTarget.checked })} />{t('tables.header')}</label>
      <label style="display:flex;gap:6px;align-items:center">{t('tables.separator')}
        <select value={m.delimiter} onchange={(e) => m.setOptions({ delimiter: e.currentTarget.value as ',' })}><option value=",">{t('tables.comma')}</option><option value=";">{t('tables.semicolon')}</option></select></label>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" checked={m.bom} onchange={(e) => m.setOptions({ bom: e.currentTarget.checked })} />{t('tables.bom')}</label>
      <span class="note">{m.source === 'ai' ? t('tables.fromAi') : m.ruled ? t('tables.fromLines') : t('tables.fromAlignment')}</span>
    </div>
  {/if}
  {#snippet footer()}
    <button class="btn" disabled={m.busy || !aiOk} onclick={() => m.useAi()} title={aiOk ? '' : t('ai.gate.noVision')}><Icon name="sparkles" />{t('tables.useAi')}</button>
    <span class="grow"></span>
    <button class="btn" disabled={!rows.length} onclick={() => m.copy()}>{t('tables.copy')}</button>
    <button class="btn primary" disabled={!rows.length} onclick={() => m.saveCsv()}>{t('tables.saveCsv')}</button>
    <button class="btn" onclick={close}>{t('action.close')}</button>
  {/snippet}
</Dialog>
