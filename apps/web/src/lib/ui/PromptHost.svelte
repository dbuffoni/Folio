<script lang="ts">
  import { t, tm } from '#lib/i18n/index.ts';
  import { prompts } from '#lib/state.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  const current = $derived(prompts.queue[0]);
  let password = $state('');
  let show = $state(false);
  let picked = $state<Record<string, boolean>>({});
  $effect(() => {
    if (current?.kind === 'password') password = '';
    if (current?.kind === 'recovery') picked = Object.fromEntries(current.items.map((i) => [i.sessionId, true]));
  });
  const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

{#if current?.kind === 'password'}
  {@const p = current}
  <Dialog title={t('dialog.password.title')} width={420} onclose={() => p.resolve(null)}>
    <div class="callout info"><Icon name="lock" /><span>{t('dialog.password.body', { name: p.fileName })}</span></div>
    {#if p.wrong}<div class="err" role="alert">{t('dialog.password.wrong')}</div>{/if}
    <form class="field" onsubmit={(e) => (e.preventDefault(), p.resolve(password))}>
      <label for="pw">{t('dialog.password.label')}</label>
      <div class="row">
        <input id="pw" type={show ? 'text' : 'password'} bind:value={password} autocomplete="off" data-autofocus style="flex:1" />
        <button type="submit" hidden aria-label={t('dialog.password.unlock')}></button>
        <button type="button" class="ib" onclick={() => (show = !show)} aria-label={show ? t('action.hide') : t('action.show')}><Icon name={show ? 'eye-off' : 'eye'} /></button>
      </div>
    </form>
    {#snippet footer()}
      <button class="btn" onclick={() => p.resolve(null)}>{t('action.cancel')}</button>
      <button class="btn primary" disabled={!password} onclick={() => p.resolve(password)}>{t('dialog.password.unlock')}</button>
    {/snippet}
  </Dialog>
{:else if current?.kind === 'close'}
  {@const p = current}
  <Dialog title={t('dialog.close.title')} width={440} onclose={() => p.resolve('cancel')}>
    <p style="margin:0">{t('dialog.close.body', { name: p.fileName })}</p>
    {#snippet footer()}
      <button class="btn danger" style="margin-right:auto" onclick={() => p.resolve('discard')}>{t('action.dontSave')}</button>
      <button class="btn" onclick={() => p.resolve('cancel')}>{t('action.cancel')}</button>
      <button class="btn primary" data-autofocus onclick={() => p.resolve('save')}>{t('action.save')}</button>
    {/snippet}
  </Dialog>
{:else if current?.kind === 'confirm'}
  {@const p = current}
  <Dialog title={t('confirm.title')} width={440} onclose={() => p.resolve(false)}>
    <p style="margin:0">{tm(p.message)}</p>
    {#snippet footer()}
      <button class="btn" onclick={() => p.resolve(false)}>{t('action.cancel')}</button>
      <button class={p.danger ? 'btn danger' : 'btn primary'} data-autofocus onclick={() => p.resolve(true)}>{p.confirmLabel ? tm(p.confirmLabel) : t('action.apply')}</button>
    {/snippet}
  </Dialog>
{:else if current?.kind === 'signed'}
  {@const p = current}
  <Dialog title={t('dialog.signed.title')} width={500} onclose={() => p.resolve('cancel')}>
    <div class="callout"><Icon name="triangle-alert" /><span>{t('dialog.signed.body', { name: p.fileName })}</span></div>
    {#snippet footer()}
      <button class="btn" onclick={() => p.resolve('cancel')}>{t('action.cancel')}</button>
      <button class="btn" onclick={() => p.resolve('rewrite')}>{t('dialog.signed.rewrite')}</button>
      <button class="btn primary" data-autofocus onclick={() => p.resolve('incremental')}>{t('dialog.signed.incremental')}</button>
    {/snippet}
  </Dialog>
{:else if current?.kind === 'recovery'}
  {@const p = current}
  <Dialog title={t('dialog.recovery.title')} width={480} onclose={() => p.resolve([])}>
    <p style="margin:0">{t('dialog.recovery.body')}</p>
    <ul class="rlist">
      {#each p.items as item (item.sessionId)}
        <li><label style="display:flex;gap:8px;align-items:center;flex:1"><input type="checkbox" bind:checked={picked[item.sessionId]} /><b>{item.name}</b></label><small>{when(item.savedAt)}</small></li>
      {/each}
    </ul>
    {#snippet footer()}
      <button class="btn" onclick={() => p.resolve([])}>{t('action.discard')}</button>
      <button class="btn primary" data-autofocus onclick={() => p.resolve(p.items.filter((i) => picked[i.sessionId]).map((i) => i.sessionId))}>{t('dialog.recovery.restore')}</button>
    {/snippet}
  </Dialog>
{:else if current?.kind === 'link'}
  {@const p = current}
  <Dialog title={t('link.open', { host: p.host })} width={460} onclose={() => p.resolve(false)}>
    <p style="margin:0">{t('link.openBody')}</p>
    <code style="word-break:break-all;font-size:12px">{p.uri}</code>
    {#snippet footer()}
      <button class="btn" data-autofocus onclick={() => p.resolve(false)}>{t('action.cancel')}</button>
      <button class="btn primary" onclick={() => p.resolve(true)}>{t('action.allow')}</button>
    {/snippet}
  </Dialog>
{/if}
