<script lang="ts">
  import type { StandardFontFamily } from '@folio/ports';
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, models, services, sign, track, ui } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';
  import { hexToColor, rgb } from '../raster.ts';

  const v = $derived(track());
  const custom = $derived(dep(v, sign.customStamps));
  let text = $state('RECEIVED');
  let color = $state('#c62828');
  let border = $state(true);
  let rotation = $state(0);
  let font = $state<StandardFontFamily>('sans');
  const COLORS = ['#c62828', '#2563eb', '#16803c', '#a15c00', '#171a20'];
  async function save(): Promise<void> {
    if (!text.trim()) return;
    await sign.addTextStamp(text.trim(), { text: text.trim(), color: hexToColor(color), fontFamily: font, bold: true, border, rotation });
    app.toast('success', { key: 'toast.stampSaved' });
  }
  async function fromImage(): Promise<void> {
    const [ref] = await services.platform.files.pickOpen({ accept: ['image'] });
    if (ref) await sign.addImageStamp(ref.name.replace(/\.[^.]+$/, ''), await services.platform.files.read(ref));
  }
  function use(id: string): void {
    const def = [...sign.builtinStamps, ...custom].find((s) => s.id === id);
    const session = app.active;
    if (!def || !session) return;
    session.setMode('fill');
    sign.placeStamp(models(session).tools, def);
    ui.closeDialog();
  }
  function move(id: string, delta: number): void {
    const ids = custom.map((c) => c.id);
    const at = ids.indexOf(id);
    const to = at + delta;
    if (to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(at, 1)[0]!);
    void sign.reorderStamps(ids);
  }
</script>

<Dialog title={t('stamp.title')} width={760} onclose={() => ui.closeDialog()}>
  <div class="two">
    <div style="display:flex;flex-direction:column;gap:12px;min-width:0">
      <div class="lab">{t('stamp.builtin')}</div>
      <div class="stgrid">
        {#each sign.builtinStamps as s (s.id)}
          <button onclick={() => use(s.id)} disabled={!app.active} aria-label={t(s.name)}>
            {#if s.style}<span class="stp" style="color:{rgb(s.style.color)};border-color:currentColor">{t(s.name)}</span>{:else}<Icon name={s.mark === 'check' ? 'check' : s.mark === 'cross' ? 'x' : 'circle'} />{/if}
          </button>
        {/each}
      </div>
      <div class="lab">{t('stamp.custom')}</div>
      {#if custom.length === 0}<p class="note">{t('stamp.empty')}</p>{/if}
      {#each custom as s, i (s.id)}
        <div class="sigitem">
          <button class="btn sm" style="flex:1;justify-content:flex-start;min-width:0" onclick={() => use(s.id)} disabled={!app.active}>
            {#if s.style}<span class="stp" style="color:{rgb(s.style.color)};border-color:{s.style.border ? 'currentColor' : 'transparent'}">{s.style.text}</span>{:else}<Icon name="image" /><span style="overflow:hidden;text-overflow:ellipsis">{s.name}</span>{/if}
          </button>
          <button class="ib" disabled={i === 0} onclick={() => move(s.id, -1)} aria-label="↑ {s.name}"><Icon name="chevron-up" /></button>
          <button class="ib" disabled={i === custom.length - 1} onclick={() => move(s.id, 1)} aria-label="↓ {s.name}"><Icon name="chevron-down" /></button>
          <button class="ib" onclick={async () => (await app.prompts.confirm({ key: 'confirm.removeStamp' }, { danger: true })) && sign.removeStamp(s.id)} aria-label="{t('action.delete')} {s.name}"><Icon name="trash-2" /></button>
        </div>
      {/each}
      <button class="btn sm" style="align-self:flex-start" onclick={fromImage}><Icon name="image-plus" />{t('stamp.fromImage')}</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="lab">{t('stamp.new')}</div>
      <div class="pad" style="height:110px;background:#fff">
        <span class="stampbig" style="color:{color};border-color:{border ? color : 'transparent'};transform:rotate({-rotation}deg);font-family:{font === 'serif' ? 'Georgia,serif' : font === 'mono' ? 'monospace' : 'Arial,sans-serif'}">{text || ' '}</span>
      </div>
      <div class="field"><label for="stt">{t('stamp.text')}</label><input id="stt" type="text" bind:value={text} maxlength="40" /></div>
      <div class="g2">
        <div class="field"><span class="lab">{t('stamp.colour')}</span><div class="row">{#each COLORS as c (c)}<button class="swatch" class:on={color === c} style="background:{c};flex:none" aria-label={c} aria-pressed={color === c} onclick={() => (color = c)}></button>{/each}</div></div>
        <div class="field"><label for="stb">{t('stamp.border')}</label><select id="stb" value={border ? 'box' : 'none'} onchange={(e) => (border = e.currentTarget.value === 'box')}><option value="box">{t('stamp.border.box')}</option><option value="none">{t('stamp.border.none')}</option></select></div>
        <div class="field"><label for="stf">{t('stamp.font')}</label><select id="stf" bind:value={font}><option value="sans">{t('ui.font.sans')}</option><option value="serif">{t('ui.font.serif')}</option><option value="mono">{t('ui.font.mono')}</option></select></div>
        <div class="field"><label for="str">{t('stamp.rotation')} {rotation}°</label><input id="str" type="range" min="-30" max="30" bind:value={rotation} /></div>
      </div>
    </div>
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => ui.closeDialog()}>{t('action.close')}</button>
    <button class="btn primary" disabled={!text.trim()} onclick={save}>{t('stamp.save')}</button>
  {/snippet}
</Dialog>
