<script lang="ts">
  import { MARGIN_PRESETS } from '@folio/services';
  import { t } from '#lib/i18n/index.ts';
  import { dep, services, track, ui, wizards } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  const w = wizards.images();
  const items = $derived(dep(track(), w.items));
  let drag = $state<string | null>(null);
  function ondrop(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const files = services.platform.files as unknown as { adopt?(f: Iterable<File>): import('@folio/ports').FileRef[] };
    if (e.dataTransfer?.files.length && files.adopt) void w.addFiles(files.adopt(e.dataTransfer.files));
  }
  async function go(): Promise<void> {
    if (await w.create()) ui.closeDialog();
  }
</script>

<Dialog title={t('images.title')} width={620} onclose={() => ui.closeDialog()}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dz small" ondragover={(e) => e.preventDefault()} {ondrop}><Icon name="plus" />{t('images.drop')} <button class="link" onclick={() => w.addFiles()}>{t('images.add')}</button></div>
  {#each items as item, i (item.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fcard" draggable="true" ondragstart={() => (drag = item.id)} ondragover={(e) => drag && e.preventDefault()} ondrop={(e) => (e.stopPropagation(), drag && w.move(drag, i), (drag = null))}>
      <span class="grip"><Icon name="grip-vertical" /></span>
      <div class="ft"><Icon name="image" /></div>
      <div class="fi"><b style="word-break:break-all">{item.name}</b><small>{Math.round(item.bytes.length / 1024)} KB</small></div>
      <button class="ib" disabled={i === 0} onclick={() => w.move(item.id, i - 1)} aria-label="↑ {item.name}"><Icon name="chevron-up" /></button>
      <button class="ib" disabled={i === items.length - 1} onclick={() => w.move(item.id, i + 1)} aria-label="↓ {item.name}"><Icon name="chevron-down" /></button>
      <button class="ib" onclick={() => w.remove(item.id)} aria-label="{t('action.remove')} {item.name}"><Icon name="x" /></button>
    </div>
  {/each}
  {#if items.length === 0}<p class="note">{t('images.empty')}</p>{/if}
  <div class="g2">
    <div class="field"><label for="ips">{t('images.pageSize')}</label>
      <select id="ips" value={w.options.pageSize} onchange={(e) => w.setOptions({ pageSize: e.currentTarget.value as 'A4' })}><option value="image">{t('images.fitImage')}</option><option value="A4">A4</option><option value="Letter">Letter</option><option value="A3">A3</option><option value="A5">A5</option></select>
    </div>
    <div class="field"><label for="ipm">{t('images.margin')}</label>
      <select id="ipm" value={String(w.options.margin)} onchange={(e) => w.setOptions({ margin: Number(e.currentTarget.value) })}>{#each Object.entries(MARGIN_PRESETS) as [k, pt] (k)}<option value={String(pt)}>{t(`images.margin.${k}`)}</option>{/each}</select>
    </div>
    <div class="field"><label for="ipf">{t('images.fit')}</label>
      <select id="ipf" value={w.options.fit} disabled={w.options.pageSize === 'image'} onchange={(e) => w.setOptions({ fit: e.currentTarget.value as 'fit' })}><option value="fit">{t('images.fit.fit')}</option><option value="fill">{t('images.fit.fill')}</option><option value="original">{t('images.fit.original')}</option></select>
    </div>
    <div class="field"><label for="ipo">{t('dialog.insert.orientation')}</label>
      <select id="ipo" value={w.options.orientation} disabled={w.options.pageSize === 'image'} onchange={(e) => w.setOptions({ orientation: e.currentTarget.value as 'auto' })}><option value="auto">Auto</option><option value="portrait">{t('dialog.insert.portrait')}</option><option value="landscape">{t('dialog.insert.landscape')}</option></select>
    </div>
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => ui.closeDialog()}>{t('action.cancel')}</button>
    <button class="btn primary" disabled={items.length === 0 || w.busy} onclick={go}>{t('images.create')}</button>
  {/snippet}
</Dialog>
