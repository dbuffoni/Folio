<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, services, track, ui, wizards } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  const w = wizards.merge();
  const v = $derived(track());
  const items = $derived(dep(v, w.items));
  let drag = $state<string | null>(null);
  let pwFor = $state<string | null>(null);
  let pw = $state('');
  const COLORS = ['#2563eb', '#16803c', '#a15c00', '#7c3aed', '#db2777', '#0d9488'];
  // Start with the saved files of the open tabs (merge "two open files", epic E1).
  $effect(() => {
    untrack(() => void w.addFiles(app.sessions.filter((s) => s.ref).map((s) => s.ref!)));
  });
  function ondrop(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const files = services.platform.files as unknown as { adopt?(f: Iterable<File>): import('@folio/ports').FileRef[] };
    if (e.dataTransfer?.files.length && files.adopt) void w.addFiles(files.adopt(e.dataTransfer.files));
  }
  async function go(save: boolean): Promise<void> {
    const ok = save ? await w.mergeAndSave() : await w.mergeAndOpen();
    if (ok) ui.closeDialog();
  }
</script>

<Dialog title={t('merge.title')} width={900} onclose={() => (w.cancel(), ui.closeDialog())}>
  <div class="two">
    <div style="display:flex;flex-direction:column;gap:10px">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="dz small" ondragover={(e) => e.preventDefault()} {ondrop}><Icon name="plus" />{t('merge.drop')} <button class="link" onclick={() => w.addFiles()}>{t('merge.add')}</button></div>
      {#each items as item, i (item.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="fcard" class:warn={!!item.info.problem} draggable="true" ondragstart={() => (drag = item.id)} ondragover={(e) => drag && e.preventDefault()} ondrop={(e) => (e.stopPropagation(), drag && w.move(drag, i), (drag = null))}>
          <span class="grip"><Icon name="grip-vertical" /></span>
          <div class="ft"><Icon name={item.info.kind === 'image' ? 'image' : 'file-text'} /></div>
          <div class="fi">
            <b style="word-break:break-all">{item.name}</b>
            {#if item.info.problem}
              <span class="chip warn"><Icon name={item.info.problem.includes('assword') ? 'lock' : 'triangle-alert'} size={13} />{t(`merge.problem.${item.info.problem}`)}</span>
            {:else}
              <small>{item.info.kind === 'image' ? t('merge.image') : t('merge.pages', { count: item.info.totalPages })}</small>
            {/if}
          </div>
          {#if item.info.problem === 'passwordRequired' || item.info.problem === 'wrongPassword'}
            <button class="btn sm" onclick={() => ((pwFor = item.id), (pw = ''))}>{t('merge.enterPassword')}</button>
          {:else if item.info.kind === 'pdf' && item.info.problem !== 'invalid' && item.info.problem !== 'empty'}
            <input type="text" value={item.range ?? ''} placeholder={`1-${item.info.totalPages}`} title={t('merge.rangeHint')} aria-label="{t('merge.range')} {item.name}" onchange={(e) => w.setRange(item.id, e.currentTarget.value)} />
          {/if}
          <button class="ib" onclick={() => w.remove(item.id)} aria-label="{t('action.remove')} {item.name}"><Icon name="x" /></button>
          <button class="ib" disabled={i === 0} onclick={() => w.move(item.id, i - 1)} aria-label="↑ {item.name}"><Icon name="chevron-up" /></button>
          <button class="ib" disabled={i === items.length - 1} onclick={() => w.move(item.id, i + 1)} aria-label="↓ {item.name}"><Icon name="chevron-down" /></button>
        </div>
      {/each}
      {#if items.length === 0}<p class="note">{t('merge.empty')}</p>{/if}
      {#if items.length > 1}
        <div class="row"><button class="btn sm ghost" onclick={() => w.sort('name')}>{t('merge.sortName')}</button><button class="btn sm ghost" onclick={() => w.sort('date')}>{t('merge.sortDate')}</button></div>
      {/if}
    </div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="lab">{t('merge.preview', { count: w.totalPages })}</div>
      <div class="strip">
        {#each w.usable as item, i (item.id)}{#each { length: Math.min(item.info.pageCount, 40) } as _, k (k)}<div class="sp" style="--c:{COLORS[i % COLORS.length]}"></div>{/each}{/each}
      </div>
      <p class="note">{t('merge.help')}</p>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" checked={w.options.bookmarks} onchange={(e) => w.setOptions({ bookmarks: e.currentTarget.checked })} />{t('merge.bookmarks')}</label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" checked={w.options.keepFormFields} onchange={(e) => w.setOptions({ keepFormFields: e.currentTarget.checked })} />{t('merge.keepForms')}</label>
      {#if w.busy}<div class="progress" role="progressbar" aria-valuenow={Math.round(w.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style="width:{w.progress * 100}%"></i></div>{/if}
    </div>
  </div>
  {#snippet footer()}
    <span class="l">{t('merge.summary', { pages: w.totalPages, files: w.usable.length })}</span>
    <button class="btn" onclick={() => (w.cancel(), ui.closeDialog())}>{t('action.cancel')}</button>
    <button class="btn" disabled={!w.canMerge} onclick={() => go(true)}>{t('merge.saveAs')}</button>
    <button class="btn primary" disabled={!w.canMerge} onclick={() => go(false)}>{w.busy ? t('merge.merging') : t('merge.open')}</button>
  {/snippet}
</Dialog>
{#if pwFor}
  <Dialog title={t('dialog.password.title')} width={380} onclose={() => (pwFor = null)}>
    <form class="field" onsubmit={(e) => (e.preventDefault(), void w.setPassword(pwFor!, pw), (pwFor = null))}>
      <label for="mpw">{t('dialog.password.label')}</label><input id="mpw" type="password" bind:value={pw} data-autofocus autocomplete="off" />
    </form>
    {#snippet footer()}
      <button class="btn" onclick={() => (pwFor = null)}>{t('action.cancel')}</button>
      <button class="btn primary" onclick={() => (void w.setPassword(pwFor!, pw), (pwFor = null))}>{t('dialog.password.unlock')}</button>
    {/snippet}
  </Dialog>
{/if}
