<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { DocumentSession, SignCorner } from '@folio/app';
  import { t, tm } from '#lib/i18n/index.ts';
  import { dep, track, ui, wizards } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  let { session }: { session: DocumentSession } = $props();
  // svelte-ignore state_referenced_locally
  const w = wizards.digitalSign(session);
  const v = $derived(track());
  const CORNERS: SignCorner[] = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];
  $effect(() => {
    // The form appears once the certificates are known; focus moves to it then, so Esc and Tab keep working.
    untrack(() =>
      w
        .start()
        .then(tick)
        .then(() => document.querySelector<HTMLElement>('.dialog [data-autofocus], .dialog select')?.focus()),
    );
  });
  async function go(): Promise<void> {
    if (await w.run()) ui.closeDialog();
  }
  function openCertificates(): void {
    ui.openDialog('settings');
  }
</script>

<Dialog title={t('dsig.title')} width={600} onclose={() => ui.closeDialog()}>
  {#if w.encrypted}<div class="callout warn" role="alert"><Icon name="lock" /><span>{t('dsig.encrypted')}</span></div>{/if}
  {#if w.alreadySigned}<div class="callout info"><Icon name="info" /><span>{t('dsig.alreadySigned')}</span></div>{/if}
  {#if dep(v, w.stage) !== 'idle' && dep(v, w.identities).length === 0}
    <div class="callout" data-testid="dsig-noid"><Icon name="info" /><span>{t('dsig.noIdentity')}</span></div>
  {:else}
    <div class="field"><label for="dsi">{t('dsig.identity')}</label>
      <select id="dsi" value={dep(v, w.identity)} onchange={(e) => w.setIdentity(e.currentTarget.value)}>
        {#each dep(v, w.identities) as c (c.fingerprint)}<option value={c.fingerprint}>{c.commonName}</option>{/each}
      </select>
    </div>
    <div class="field"><span class="lab" id="dsp-l">{t('dsig.placement')}</span>
      <div class="radios" role="radiogroup" aria-labelledby="dsp-l">
        {#if w.openFields.length}
          <label><input type="radio" name="dsp" checked={w.placement === 'field'} onchange={() => w.setPlacement('field')} />{t('dsig.placement.field')}</label>
        {/if}
        <label><input type="radio" name="dsp" checked={w.placement === 'new'} onchange={() => w.setPlacement('new')} />{t('dsig.placement.new')}</label>
        <label><input type="radio" name="dsp" checked={w.placement === 'invisible'} onchange={() => w.setPlacement('invisible')} />{t('dsig.placement.invisible')}</label>
      </div>
    </div>
    {#if w.placement === 'field'}
      <div class="field"><label for="dsf">{t('dsig.field')}</label>
        <select id="dsf" value={w.fieldName} onchange={(e) => w.setField(e.currentTarget.value)}>{#each w.openFields as f (f.name)}<option value={f.name}>{f.name}</option>{/each}</select>
      </div>
    {:else if w.placement === 'new'}
      <div class="g2">
        <div class="field"><label for="dspg">{t('dsig.page')}</label><input id="dspg" type="number" min="1" max={w.pageCount} value={w.page + 1} onchange={(e) => w.setPage(Number(e.currentTarget.value) - 1)} /></div>
        <div class="field"><label for="dsc">{t('dsig.corner')}</label>
          <select id="dsc" value={w.corner} onchange={(e) => w.setCorner(e.currentTarget.value as SignCorner)}>{#each CORNERS as c (c)}<option value={c}>{t(`dsig.corner.${c}`)}</option>{/each}</select>
        </div>
      </div>
    {/if}
    {#if w.placement !== 'invisible'}
      <div class="togrow"><div>{t('dsig.showDate')}</div><input type="checkbox" class="tog" aria-label={t('dsig.showDate')} checked={w.showDate} onchange={(e) => w.set({ showDate: e.currentTarget.checked })} /></div>
      {#if w.artworkChoices.length}
        <div class="field"><label for="dsa">{t('dsig.artwork')}</label>
          <select id="dsa" value={w.artwork ?? ''} onchange={(e) => w.set({ artwork: e.currentTarget.value || null })}><option value="">{t('dsig.artwork.none')}</option>{#each w.artworkChoices as a (a.id)}<option value={a.id}>{a.name}</option>{/each}</select>
        </div>
      {/if}
    {/if}
    <div class="g2">
      <div class="field"><label for="dsr">{t('dsig.reason')}</label><input id="dsr" type="text" value={w.reason} oninput={(e) => w.set({ reason: e.currentTarget.value })} /></div>
      <div class="field"><label for="dsl">{t('dsig.location')}</label><input id="dsl" type="text" value={w.location} oninput={(e) => w.set({ location: e.currentTarget.value })} /></div>
    </div>
    <div class="field"><label for="dsk">{t('dsig.contact')}</label><input id="dsk" type="text" value={w.contact} oninput={(e) => w.set({ contact: e.currentTarget.value })} /></div>
    <div class="togrow"><div>{t('dsig.timestamp')}<small>{w.timestampReady ? w.tsaUrl : t('dsig.timestampOff')}</small></div><input type="checkbox" class="tog" aria-label={t('dsig.timestamp')} disabled={!w.timestampReady} checked={w.timestamp} onchange={(e) => w.set({ timestamp: e.currentTarget.checked })} /></div>
    <div class="togrow"><div>{t('dsig.embed')}<small>{t('dsig.embedHint')}</small></div><input type="checkbox" class="tog" aria-label={t('dsig.embed')} disabled={!w.networkAvailable} checked={w.embedValidation} onchange={(e) => w.set({ embedValidation: e.currentTarget.checked })} /></div>
    <div class="field"><span class="lab" id="dst-l">{t('dsig.save')}</span>
      <div class="radios" role="radiogroup" aria-labelledby="dst-l">
        <label><input type="radio" name="dst" checked={w.target === 'copy'} onchange={() => w.setTarget('copy')} />{t('dsig.copy')}</label>
        <label><input type="radio" name="dst" checked={w.target === 'replace'} disabled={!w.canReplace} onchange={() => w.setTarget('replace')} />{t('dsig.replace')}</label>
      </div>
    </div>
    <p class="note">{t('dsig.hint')}</p>
  {/if}
  {#if w.error}<div class="callout warn" role="alert"><Icon name="triangle-alert" /><span>{tm(dep(v, w.error)!)}</span></div>{/if}
  {#snippet footer()}
    {#if dep(v, w.identities).length === 0 && w.stage !== 'idle'}<button class="btn" data-autofocus onclick={openCertificates}>{t('dsig.openCertificates')}</button>{/if}
    <button class="btn" onclick={() => ui.closeDialog()}>{t('action.cancel')}</button>
    <button class="btn primary" disabled={!dep(v, w.canSign)} onclick={go}>{w.stage === 'running' ? t('dsig.running') : t('dsig.run')}</button>
  {/snippet}
</Dialog>
