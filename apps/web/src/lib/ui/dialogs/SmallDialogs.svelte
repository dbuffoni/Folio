<script lang="ts">
  import { formatChord, type DocumentSession } from '@folio/app';
  import { isValidPageRanges, mmToPt, parsePageRanges, PAGE_SIZES, type PageSizeName } from '@folio/core';
  import { t, tm } from '#lib/i18n/index.ts';
  import { dep, app, isMac, models, registry, track, ui } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  let { session }: { session: DocumentSession | null } = $props();
  const v = $derived(track());
  const dialog = $derived(dep(v, ui.dialog));
  // print
  let which = $state<'all' | 'current' | 'range'>('all');
  let range = $state('');
  let copies = $state(1);
  const copiesOk = $derived(Number.isInteger(copies) && copies >= 1 && copies <= 99);
  const rangeOk = $derived(which !== 'range' || (!!session && range.trim() !== '' && isValidPageRanges(range, session.pageCount)));
  async function print(): Promise<void> {
    if (!session) return;
    const pages = which === 'all' ? undefined : which === 'current' ? [session.view.page] : parsePageRanges(range, session.pageCount);
    ui.closeDialog();
    await app.print({ pages, copies }, session);
  }
  // insert blank
  let where = $state<'before' | 'after'>('after');
  let sizeKind = $state<'neighbour' | PageSizeName | 'custom'>('neighbour');
  let landscape = $state(false);
  let cw = $state(210);
  let ch = $state(297);
  async function insert(): Promise<void> {
    if (!session) return;
    const spec = sizeKind === 'neighbour' ? ({ kind: 'neighbour' } as const) : sizeKind === 'custom' ? ({ kind: 'custom', size: { width: mmToPt(cw), height: mmToPt(ch) } } as const) : ({ kind: 'preset', name: sizeKind, landscape } as const);
    ui.closeDialog();
    await models(session).organise.insertBlank(where, spec);
  }
  // history
  const hs = $derived(dep(v, session?.historyState));
  // shortcuts: every command that has one, grouped as in the registry
  const shortcuts = $derived(registry.all().filter((c) => c.shortcut && c.id !== 'edit.cancel'));
</script>

{#if dialog === 'print' && session}
  <Dialog title={t('dialog.print.title')} width={440} onclose={() => ui.closeDialog()}>
    <div class="field">
      <span class="lab">{t('dialog.print.pages')}</span>
      <div class="radios" style="flex-direction:row;flex-wrap:wrap" role="radiogroup">
        <label><input type="radio" name="pp" bind:group={which} value="all" />{t('dialog.print.all')}</label>
        <label><input type="radio" name="pp" bind:group={which} value="current" />{t('dialog.print.current')}</label>
        <label><input type="radio" name="pp" bind:group={which} value="range" />{t('dialog.print.range')}</label>
      </div>
      {#if which === 'range'}<input type="text" bind:value={range} placeholder="1-3,7" aria-label={t('dialog.print.range')} aria-invalid={!rangeOk} style={rangeOk ? '' : 'border-color:var(--color-danger)'} />{/if}
    </div>
    <div class="field"><label for="pc">{t('dialog.print.copies')}</label><input id="pc" type="number" min="1" max="99" step="1" bind:value={copies} aria-invalid={!copiesOk} style={copiesOk ? '' : 'border-color:var(--color-danger)'} /></div>
    {#snippet footer()}
      <button class="btn" onclick={() => ui.closeDialog()}>{t('action.cancel')}</button>
      <button class="btn primary" disabled={!rangeOk || !copiesOk} onclick={print}><Icon name="printer" />{t('dialog.print.print')}</button>
    {/snippet}
  </Dialog>
{:else if dialog === 'insertBlank' && session}
  <Dialog title={t('dialog.insert.title')} width={440} onclose={() => ui.closeDialog()}>
    <div class="g2">
      <div class="field"><label for="ibw">{t('dialog.insert.where')}</label><select id="ibw" bind:value={where}><option value="before">{t('dialog.insert.before')}</option><option value="after">{t('dialog.insert.after')}</option></select></div>
      <div class="field"><label for="ibs">{t('dialog.insert.size')}</label>
        <select id="ibs" bind:value={sizeKind}><option value="neighbour">{t('dialog.insert.neighbour')}</option>{#each Object.keys(PAGE_SIZES) as n (n)}<option value={n}>{n}</option>{/each}<option value="custom">{t('dialog.insert.custom')}</option></select>
      </div>
    </div>
    {#if sizeKind === 'custom'}
      <div class="g2">
        <div class="field"><label for="ibcw">{t('dialog.insert.widthMm')}</label><input id="ibcw" type="number" min="26" max="5000" bind:value={cw} /></div>
        <div class="field"><label for="ibch">{t('dialog.insert.heightMm')}</label><input id="ibch" type="number" min="26" max="5000" bind:value={ch} /></div>
      </div>
    {:else if sizeKind !== 'neighbour'}
      <div class="field"><label for="ibo">{t('dialog.insert.orientation')}</label><select id="ibo" value={landscape ? 'l' : 'p'} onchange={(e) => (landscape = e.currentTarget.value === 'l')}><option value="p">{t('dialog.insert.portrait')}</option><option value="l">{t('dialog.insert.landscape')}</option></select></div>
    {/if}
    {#snippet footer()}
      <button class="btn" onclick={() => ui.closeDialog()}>{t('action.cancel')}</button>
      <button class="btn primary" onclick={insert}>{t('dialog.insert.insert')}</button>
    {/snippet}
  </Dialog>
{:else if dialog === 'history' && session && hs}
  <Dialog title={t('dialog.history.title')} width={420} onclose={() => ui.closeDialog()}>
    <ul class="hist">
      <li class:cur={hs.done.length === 0}><button onclick={() => session!.history.goTo(0)}><Icon name="file-text" />{t('dialog.history.start')}</button></li>
      {#each hs.done as entry, i (i)}
        <li class:cur={i === hs.done.length - 1}><button onclick={() => session!.history.goTo(i + 1)}><Icon name="check" />{tm(entry.label)}</button></li>
      {/each}
      {#each hs.undone as entry, i (i)}
        <li class="undone"><button onclick={() => session!.history.goTo(hs!.done.length + i + 1)}><Icon name="redo-2" />{tm(entry.label)}</button></li>
      {/each}
    </ul>
    {#if hs.done.length + hs.undone.length === 0}<p class="note">{t('dialog.history.empty')}</p>{/if}
    {#snippet footer()}<button class="btn primary" onclick={() => ui.closeDialog()}>{t('action.done')}</button>{/snippet}
  </Dialog>
{:else if dialog === 'shortcuts'}
  <Dialog title={t('dialog.shortcuts.title')} width={700} onclose={() => ui.closeDialog()}>
    <div class="sctable">
      {#each shortcuts as c (c.id)}<div><span>{t(c.title)}</span><kbd>{formatChord(c.shortcut!, isMac)}</kbd></div>{/each}
      <div><span>{t('ui.nextMatch')} / {t('ui.prevMatch')}</span><kbd>Enter / Shift+Enter</kbd></div>
      <div><span>{t('tool.fillForm')}</span><kbd>Tab / Shift+Tab</kbd></div>
      <div><span>{t('cmd.cancel')}</span><kbd>Esc</kbd></div>
    </div>
    {#snippet footer()}<span class="l">{t('dialog.shortcuts.mac')}</span><button class="btn primary" onclick={() => ui.closeDialog()}>{t('action.done')}</button>{/snippet}
  </Dialog>
{/if}
