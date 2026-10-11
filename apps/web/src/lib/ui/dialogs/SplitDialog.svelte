<script lang="ts">
  import type { DocumentSession } from '@folio/app';
  import { untrack } from 'svelte';
  import { t, tm } from '#lib/i18n/index.ts';
  import { dep, track, ui, wizards } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  let { session }: { session: DocumentSession } = $props();
  // svelte-ignore state_referenced_locally
  const w = wizards.split(session);
  const v = $derived(track());
  const plan = $derived(dep(v, w.plan));
  const mode = $derived(dep(v, w.mode));
  const COLORS = ['#2563eb', '#16803c', '#a15c00', '#7c3aed', '#db2777', '#0d9488'];
  $effect(() => {
    untrack(() => void w.init());
  });
  const partOf = (page: number): number => plan.findIndex((f) => f.pages.includes(page));
  const cutAfter = (page: number): boolean => {
    const a = partOf(page);
    return a >= 0 && a !== partOf(page + 1);
  };
  const strip = $derived(Math.min(session.pageCount, 60));
  async function go(): Promise<void> {
    if (await w.run()) ui.closeDialog();
  }
</script>

<Dialog title={t('split.title')} width={900} onclose={() => (w.cancel(), ui.closeDialog())}>
  <div class="two">
    <div class="radios" role="radiogroup">
      <label>
        <input type="radio" name="sm" checked={mode === 'ranges'} onchange={() => w.setMode('ranges')} />
        <div style="flex:1"><b>{t('split.mode.ranges')}</b><small>{t('split.mode.ranges.d')}</small>
          {#if mode === 'ranges'}
            {#each w.ranges as r, i (i)}
              <div class="row" style="margin-top:8px">
                <input type="text" value={r} placeholder="1-3" aria-label={t('split.range', { n: i + 1 })} aria-invalid={!w.rangeValid(i)} style="flex:1;{w.rangeValid(i) ? '' : 'border-color:var(--color-danger)'}" oninput={(e) => w.setRange(i, e.currentTarget.value)} />
                <button class="ib" onclick={() => w.removeRange(i)} aria-label={t('action.remove')} style="flex:none"><Icon name="x" /></button>
              </div>
            {/each}
            <button class="btn sm" style="margin-top:8px" onclick={() => w.addRange()}><Icon name="plus" />{t('split.addRange')}</button>
          {/if}
        </div>
      </label>
      <label>
        <input type="radio" name="sm" checked={mode === 'everyN'} onchange={() => w.setMode('everyN')} />
        <div style="flex:1"><b>{t('split.mode.everyN')}</b><small>{t('split.mode.everyN.d')}</small>
          {#if mode === 'everyN'}<div class="row" style="margin-top:8px"><label for="spn" style="width:auto">{t('split.pagesPerFile')}</label><input id="spn" type="number" min="1" max={session.pageCount} value={w.everyN} style="max-width:90px" oninput={(e) => w.setEveryN(Number(e.currentTarget.value))} /></div>{/if}
        </div>
      </label>
      <label><input type="radio" name="sm" checked={mode === 'single'} onchange={() => w.setMode('single')} /><div><b>{t('split.mode.single')}</b><small>{t('split.mode.single.d')}</small></div></label>
      <label><input type="radio" name="sm" checked={mode === 'cuts'} onchange={() => w.setMode('cuts')} /><div><b>{t('split.mode.cuts')}</b><small>{t('split.mode.cuts.d')}</small></div></label>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;min-width:0">
      <div class="lab">{t('split.result')}</div>
      {#if w.problem}<div class="callout" role="alert"><Icon name="triangle-alert" /><span>{tm(w.problem)}</span></div>{/if}
      <ul class="rlist" style="max-height:230px;overflow:auto">
        {#each plan.slice(0, 200) as f, i (i)}
          <li><Icon name="file-text" /><b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{f.name}</b>{#if f.conflict}<span class="chip warn">{t('split.exists')}</span>{/if}<small>{f.from === f.to ? t('split.pageOne', { from: f.from }) : t('split.pagesRange', { from: f.from, to: f.to })}</small></li>
        {/each}
      </ul>
    </div>
  </div>
  <div>
    <div class="lab" style="margin-bottom:6px">{t('split.cuts')}</div>
    <div class="strip">
      {#each { length: strip } as _, p (p)}
        <div class="sp" style="--c:{COLORS[Math.max(0, partOf(p)) % COLORS.length]}" title={String(p + 1)}></div>
        {#if p < session.pageCount - 1}
          <button class="cut" class:on={cutAfter(p)} aria-pressed={cutAfter(p)} aria-label={t('split.cutAfter', { page: p + 1 })} onclick={() => w.toggleCut(p)}><Icon name="scissors" /></button>
        {/if}
      {/each}
      {#if session.pageCount > strip}<span class="note" style="align-self:center">…</span>{/if}
    </div>
  </div>
  <div class="g2">
    <div class="field"><label for="spt">{t('split.template')}</label><input id="spt" type="text" value={w.template} oninput={(e) => w.setTemplate(e.currentTarget.value)} /><span class="hint">{t('split.templateHint')}</span></div>
    <div class="field"><label for="spc">{t('split.conflicts')}</label><select id="spc" value={w.policy} onchange={(e) => w.setPolicy(e.currentTarget.value as 'ask')}><option value="autoNumber">{t('split.policy.autoNumber')}</option><option value="overwrite">{t('split.policy.overwrite')}</option><option value="ask">{t('split.policy.ask')}</option></select></div>
  </div>
  <div class="field"><label for="spf">{t('split.saveTo')}</label><div class="row"><input id="spf" type="text" value={w.folder?.path ?? w.folder?.name ?? t('split.noFolder')} readonly /><button class="btn" style="flex:none" onclick={() => w.pickFolder()}><Icon name="folder-open" />{t('action.choose')}</button></div></div>
  {#if w.busy}<div class="progress" role="progressbar" aria-valuenow={Math.round(w.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style="width:{w.progress * 100}%"></i></div>{/if}
  {#snippet footer()}
    <button class="btn" onclick={() => (w.cancel(), ui.closeDialog())}>{t('action.cancel')}</button>
    <button class="btn primary" disabled={!w.canRun} onclick={go}>{w.busy ? t('split.splitting') : t('split.run', { count: plan.length })}</button>
  {/snippet}
</Dialog>
