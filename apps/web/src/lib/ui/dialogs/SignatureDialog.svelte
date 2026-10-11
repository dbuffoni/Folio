<script lang="ts">
  import { untrack } from 'svelte';
  import type { Point } from '@folio/ports';
  import type { HandwritingFont, SignatureDraft } from '@folio/services';
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, models, services, sign, track, ui } from '#lib/state.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';
  import { colorToHex, paint } from '../raster.ts';

  const v = $derived(track());
  const kind = $derived(dep(v, sign.creating ?? 'signature'));
  const existing = $derived(dep(v, sign.of(kind)));
  let tab = $state<'draw' | 'type' | 'image'>('draw');
  let ink = $state('blue');
  let name = $state('');
  let error = $state('');
  // draw
  let pad: HTMLCanvasElement | undefined = $state();
  let strokes = $state<Point[][]>([]);
  let drawing = false;
  // type
  let text = $state('');
  let font = $state<HandwritingFont>('DancingScript');
  let previews = $state<Record<string, SignatureDraft | null>>({});
  // image
  let imageBytes = $state<Uint8Array | null>(null);
  let threshold = $state(200);
  let imageDraft = $state<SignatureDraft | null>(null);
  let imgCanvas: HTMLCanvasElement | undefined = $state();

  const color = $derived(sign.inkColors[ink]!);
  function redraw(): void {
    if (!pad) return;
    const r = pad.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    pad.width = r.width * dpr;
    pad.height = r.height * dpr;
    const ctx = pad.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.4;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = colorToHex(color);
    for (const s of strokes) {
      ctx.beginPath();
      s.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
  }
  $effect(() => {
    for (const stroke of strokes) void stroke.length;
    void color;
    if (tab === 'draw') redraw();
  });
  const at = (e: PointerEvent): Point => {
    const r = pad!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  function down(e: PointerEvent): void {
    pad!.setPointerCapture(e.pointerId);
    drawing = true;
    strokes = [...strokes, [at(e)]];
  }
  function move(e: PointerEvent): void {
    // Points go through the reactive array: a plain reference to the stroke would be a detached copy.
    if (drawing) strokes[strokes.length - 1]?.push(at(e));
  }
  // Typed previews are rendered by the engine with the bundled handwriting fonts.
  $effect(() => {
    const value = text.trim();
    const c = color;
    if (tab !== 'type' || !value) return void (previews = {});
    const timer = setTimeout(() => {
      for (const f of sign.fonts) void sign.draftFromText(value, f, c).then((d) => (previews = { ...previews, [f]: d })).catch(() => undefined);
    }, 200);
    return () => clearTimeout(timer);
  });
  function show(node: HTMLCanvasElement, draft: SignatureDraft | null | undefined) {
    const set = (d: SignatureDraft | null | undefined): void => void (d && paint(node, d.raster));
    set(draft);
    return { update: set };
  }
  $effect(() => {
    const bytes = imageBytes;
    const th = threshold;
    if (!bytes) return void (imageDraft = null);
    untrack(() => sign.draftFromImage(bytes, th)).then((d) => ((imageDraft = d), (error = ''))).catch((e) => ((imageDraft = null), (error = t(`error.${(e as { code: string }).code}.${(e as { params: { reason?: string } }).params?.reason ?? ''}`))));
  });
  $effect(() => {
    if (imageDraft && imgCanvas) paint(imgCanvas, imageDraft.raster);
  });
  async function pickImage(): Promise<void> {
    const [ref] = await services.platform.files.pickOpen({ accept: ['image'] });
    if (ref) imageBytes = await services.platform.files.read(ref);
  }
  async function dropImage(e: DragEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer?.files[0];
    if (f) imageBytes = new Uint8Array(await f.arrayBuffer());
  }
  function draft(): SignatureDraft | null {
    error = '';
    try {
      if (tab === 'draw') return sign.draftFromStrokes(strokes, color);
      if (tab === 'type') return previews[font] ?? null;
      return imageDraft;
    } catch (e) {
      const err = e as { code?: string; params?: { reason?: string } };
      error = t(`error.${err.code}.${err.params?.reason ?? ''}`);
      return null;
    }
  }
  async function save(use: boolean): Promise<void> {
    const d = draft();
    if (!d) return void (error ||= t('error.invalidArgument.emptySignature'));
    const session = app.active;
    const stored = await sign.save(d, name.trim() || t(`sign.defaultName.${kind}`), use && session ? models(session).tools : undefined);
    if (!stored) return;
    app.toast('success', { key: use && session ? 'toast.placeHint' : 'toast.signatureSaved' });
    ui.closeDialog();
  }
  function close(): void {
    sign.closeCreate();
    ui.closeDialog();
  }
</script>

<Dialog title={t(`sign.title.${kind}`)} width={560} onclose={close}>
  <div class="tabs2" role="tablist">
    {#each ['draw', 'type', 'image'] as id (id)}
      <button role="tab" class:on={tab === id} aria-selected={tab === id} onclick={() => ((tab = id as 'draw'), (error = ''))}>{t(`sign.tab.${id}`)}</button>
    {/each}
  </div>
  {#if tab === 'draw'}
    <div class="pad"><span></span><em>{t('sign.drawHint')}</em>
      <canvas bind:this={pad} aria-label={t('sign.drawHint')} onpointerdown={down} onpointermove={move} onpointerup={() => (drawing = false)} onpointercancel={() => (drawing = false)}></canvas>
    </div>
  {:else if tab === 'type'}
    <div class="field"><label for="sgn">{kind === 'initials' ? t('sign.initialsLabel') : t('sign.fullName')}</label><input id="sgn" type="text" bind:value={text} data-autofocus autocomplete="off" /></div>
    <div class="stylecards" role="radiogroup" aria-label={t('sign.style')}>
      {#each sign.fonts as f (f)}
        <label><input type="radio" name="sst" bind:group={font} value={f} aria-label={f} />{#if previews[f]}<canvas use:show={previews[f]} style="max-width:100%;height:38px"></canvas>{:else}<span class="note" style="font-size:12px">{f}</span>{/if}</label>
      {/each}
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="dz small" style="padding:22px" ondragover={(e) => e.preventDefault()} ondrop={dropImage}><Icon name="image-up" />{t('sign.dropImage')} <button class="link" onclick={pickImage}>{t('sign.chooseFile')}</button></div>
    {#if imageBytes}
      <div class="pad checker" style="height:120px"><canvas bind:this={imgCanvas} style="position:static;width:auto;height:auto;max-width:90%;max-height:100px;cursor:default"></canvas></div>
      <div class="field"><label for="thr">{t('sign.threshold')}</label><input id="thr" type="range" min="60" max="250" bind:value={threshold} /><span class="hint">{t('sign.thresholdHint')}</span></div>
    {/if}
  {/if}
  <div class="row">
    <span class="lab" style="width:auto;flex:none">{t('sign.ink')}</span>
    {#each Object.entries(sign.inkColors) as [id, c] (id)}<button class="swatch" class:on={ink === id} style="background:{colorToHex(c)};flex:none" aria-label={id} aria-pressed={ink === id} onclick={() => (ink = id)}></button>{/each}
    <span class="grow"></span>
    {#if tab === 'draw'}<button class="btn sm" style="flex:none" onclick={() => (strokes = [])}><Icon name="eraser" />{t('action.clear')}</button>{/if}
  </div>
  <div class="field"><label for="sname">{t('sign.name')}</label><input id="sname" type="text" bind:value={name} placeholder={t(`sign.defaultName.${kind}`)} /></div>
  {#if error}<div class="err" role="alert">{error}</div>{/if}
  {#if existing.length}
    <div class="lab">{t(kind === 'initials' ? 'sign.savedInitials' : 'sign.saved')}</div>
    {#each existing as s (s.id)}
      <div class="sigitem">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">{s.name}{s.isDefault ? ` · ${t('action.default')}` : ''}</span>
        {#if !s.isDefault}<button class="btn sm" onclick={() => sign.setDefault(s.id)}>{t('action.setDefault')}</button>{/if}
        <button class="ib" onclick={async () => (await app.prompts.confirm({ key: 'confirm.removeSignature' }, { danger: true })) && sign.remove(s.id)} aria-label="{t('action.delete')} {s.name}"><Icon name="trash-2" /></button>
      </div>
    {/each}
  {/if}
  <div class="togrow" style="border-top:1px solid var(--color-border);padding-top:12px">
    <div>{t('sign.encrypt')}<small>{t('sign.encryptHint')}</small></div>
    <input type="checkbox" class="tog" aria-label={t('sign.encrypt')} checked={app.settings.encryptSignatures} onchange={(e) => app.setSetting('encryptSignatures', e.currentTarget.checked)} />
  </div>
  {#snippet footer()}
    <span class="l">{t('sign.savedTo')}</span>
    <button class="btn" onclick={close}>{t('action.cancel')}</button>
    <button class="btn" onclick={() => save(false)}>{t('sign.saveLibrary')}</button>
    <button class="btn primary" disabled={!app.active} onclick={() => save(true)}>{t('sign.useNow')}</button>
  {/snippet}
</Dialog>
