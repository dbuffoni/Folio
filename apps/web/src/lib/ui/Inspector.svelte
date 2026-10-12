<script lang="ts">
  import type { DocumentSession } from '@folio/app';
  import { describePageSize, formatBytes, parsePdfDate, ptToIn, ptToMm } from '@folio/core';
  import type { Annotation, Color, PageObject } from '@folio/ports';
  import { t } from '#lib/i18n/index.ts';
  import { dep, app, models, run, services, track, ui } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import SmartFillPanel from './SmartFillPanel.svelte';
  import { colorToHex, hexToColor, rgb } from './raster.ts';

  let { session }: { session: DocumentSession } = $props();
  const m = $derived(models(session));
  const v = $derived(track());
  const mode = $derived(dep(v, session.mode));
  const sel = $derived(dep(v, session.selection));
  const smartOn = $derived(dep(v, m.smart.stage !== 'idle'));
  let annot = $state<Annotation | null>(null);
  let image = $state<PageObject | null>(null);
  $effect(() => {
    void v;
    const s = session.selection;
    if (s.kind === 'annotations' && s.ids.length === 1) void session.annotations(s.page).then((list) => (annot = list.find((a) => a.id === s.ids[0]) ?? null));
    else annot = null;
    if (s.kind === 'object') void services.objects.imagesOn(session.doc, s.page).then((list) => (image = list.find((o) => o.id === s.id) ?? null));
    else image = null;
  });
  const TITLE: Record<string, [string, string]> = {
    highlight: ['ui.highlight', 'highlighter'], underline: ['ui.underline', 'underline'], strikeout: ['ui.strikeout', 'strikethrough'], squiggly: ['ui.squiggly', 'spline'], text: ['ui.note', 'message-square'],
    freetext: ['ui.textbox', 'type'], square: ['ui.rectangle', 'square'], circle: ['ui.ellipse', 'circle'], line: ['ui.line', 'minus'], polyline: ['ui.polyline', 'waypoints'], polygon: ['ui.polyline', 'waypoints'],
    ink: ['ui.line', 'pen-line'], stamp: ['ui.stamp', 'stamp'], link: ['ui.link', 'file-text'], other: ['ui.other', 'paperclip'],
  };
  const SWATCH = ['#ffd54a', '#7cde84', '#78beff', '#ff8fc4', '#d32f2f', '#2563eb', '#16803c', '#171a20'];
  const restyle = (patch: Partial<Annotation>): Promise<void> => m.tools.restyleSelection(patch);
  const pick = (c: string, key: 'color' | 'textColor' | 'fillColor' | 'backgroundColor' = 'color'): Promise<void> => restyle({ [key]: hexToColor(c) } as Partial<Annotation>);
  const date = (s?: string): string => parsePdfDate(s)?.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) ?? '—';
  const unit = (pt: number): string => {
    const u = app.settings.units;
    return u === 'mm' ? `${Math.round(ptToMm(pt))}` : u === 'in' ? ptToIn(pt).toFixed(2) : `${Math.round(pt)}`;
  };
  const pageSize = $derived.by(() => {
    void v;
    const s = session.pageInfos[session.view.page]?.size;
    if (!s) return '';
    const d = describePageSize(s);
    return `${d.name ? `${d.name} · ` : ''}${unit(s.width)} × ${unit(s.height)} ${app.settings.units}`;
  });
  const filled = $derived(dep(v, m.form.fields.filter((f) => !f.readOnly && f.type !== 'button' && f.type !== 'signature' && f.value !== '' && f.value !== 'Off').length));
  const stampName = (a: Annotation): [string, string] => (a.type === 'stamp' ? (a.name === 'Signature' || a.name === 'Initials' ? ['ui.signature', 'signature'] : a.name === 'Date' ? ['ui.date', 'calendar'] : ['ui.stamp', 'stamp']) : (TITLE[a.type] ?? ['ui.other', 'paperclip']));
  async function setSize(key: 'width' | 'height', value: number, input: HTMLInputElement): Promise<void> {
    if (!annot) return;
    const revert = (): void => void (input.value = String(Math.round(annot!.rect[key])));
    if (!(value > 2)) return revert();
    const k = annot.rect.width / annot.rect.height;
    let width = key === 'width' ? value : value * k;
    let height = key === 'height' ? value : value / k;
    // Never larger than what is left of the page from the box's corner.
    const box = session.pageInfos[(sel as { page: number }).page]?.cropBox;
    if (box) {
      const fit = Math.min(1, (box.x + box.width - annot.rect.x) / width, (box.y + box.height - annot.rect.y) / height);
      if (fit > 0 && fit < 1) {
        width *= fit;
        height *= fit;
      }
    }
    const { resizeAnnotation } = await import('@folio/services');
    await app.guard(() => session.run(services.annotations.update((sel as { page: number }).page, annot!, resizeAnnotation(annot!, { ...annot!.rect, width, height }))));
    // Show what was applied (a clamped value must not stay as typed).
    input.value = String(Math.round(key === 'width' ? width : height));
  }
  async function flattenSelected(): Promise<void> {
    if (sel.kind !== 'annotations' || !annot) return;
    if (!(await app.prompts.confirm({ key: 'confirm.flattenAnnotations' }, { danger: true, confirmLabel: { key: 'cmd.flatten.annotations' } }))) return;
    await app.guard(() => session.run(services.exporter.flatten('annotations', [sel.page])));
  }
  async function replaceImage(): Promise<void> {
    if (sel.kind !== 'object') return;
    const [ref] = await services.platform.files.pickOpen({ accept: ['image'] });
    if (ref) await app.guard(async () => session.run(services.objects.replace(sel.page, sel.id, (await services.objects.prepare(await services.platform.files.read(ref))).image)));
  }
  async function extractImage(): Promise<void> {
    if (sel.kind !== 'object') return;
    const ref = await services.platform.files.pickSave({ suggestedName: 'image.png', kind: 'image' });
    if (ref) await app.guard(async () => services.platform.files.write(ref, await services.objects.extract(session.doc, sel.page, sel.id), { atomic: true }));
  }
  const col = (c?: Color): string => (c ? colorToHex(c) : '');
</script>

{#snippet head(title: string, icon: string)}
  <div class="ins-h"><Icon name={icon} /><span class="grow">{title}</span><button class="ib" onclick={() => ui.toggleInspector()} aria-label={t('cmd.toggleInspector')}><Icon name="panel-right-close" /></button></div>
{/snippet}
{#snippet swatches(current: string, onpick: (c: string) => void, list: string[] = SWATCH)}
  <div class="row" style="gap:8px;flex-wrap:wrap">
    {#each list as c (c)}<button class="swatch" class:on={current === c} style="background:{c};width:22px;height:22px;flex:none" aria-label={c} onclick={() => onpick(c)}></button>{/each}
  </div>
{/snippet}
{#snippet commentBox(a: Annotation, rows: number)}
  <textarea {rows} placeholder={t('ui.commentPlaceholder')} aria-label={t('ui.comment')} value={a.contents ?? ''} onchange={(e) => restyle({ contents: e.currentTarget.value })}></textarea>
  <div class="kv"><span>{t('ui.author')}</span><b>{a.author ?? '—'}</b></div>
  <div class="kv"><span>{t('ui.modified')}</span><b>{date(a.modified)}</b></div>
{/snippet}
{#snippet common(a: Annotation)}
  <div class="ins-s">
    <div class="row">
      <button class="btn sm" onclick={() => m.tools.reorderSelection('front')}>{t('ui.bringFront')}</button>
      <button class="btn sm" onclick={() => m.tools.reorderSelection('back')}>{t('ui.sendBack')}</button>
    </div>
    <button class="btn" onclick={() => restyle({ locked: !a.locked })}><Icon name={a.locked ? 'lock-open' : 'lock'} />{a.locked ? t('ui.unlock') : t('ui.lock')}</button>
    <button class="btn danger" disabled={a.locked} onclick={() => m.tools.deleteSelection()}><Icon name="trash-2" />{t('action.delete')}</button>
  </div>
{/snippet}

<aside id="inspector" aria-label={t('ui.inspector')}>
  {#if mode === 'fill' && smartOn}
    <SmartFillPanel {session} />
  {:else if mode === 'organise'}
    {@render head(t('home.tile.organise'), 'layout-grid')}
    <div class="ins-s">
      <h4>{t('ui.selection')}</h4>
      <div class="kv"><span>{t('ui.selection')}</span><b>{t('ui.selected', { count: sel.kind === 'pages' ? sel.pages.length : 0 })}</b></div>
      <p class="note">{t('ui.organiseHint')}</p>
    </div>
    <div class="ins-s">
      <h4>{t('ui.actions')}</h4>
      <button class="btn" disabled={sel.kind !== 'pages'} onclick={() => run('pages.rotateCw')}><Icon name="rotate-cw" />{t('ui.rotate')}</button>
      <button class="btn" disabled={sel.kind !== 'pages'} onclick={() => run('pages.extract')}><Icon name="file-output" />{t('ui.extractNew')}</button>
      <button class="btn danger" disabled={sel.kind !== 'pages'} onclick={() => run('edit.delete')}><Icon name="trash-2" />{t('action.delete')}</button>
    </div>
  {:else if annot}
    {@const [title, icon] = stampName(annot)}
    {@render head(t(title), icon)}
    {#if annot.type === 'highlight' || annot.type === 'underline' || annot.type === 'strikeout' || annot.type === 'squiggly'}
      <div class="ins-s">
        <h4>{t('ui.appearance')}</h4>
        <div class="row"><label>{t('ui.colour')}</label>{@render swatches(col(annot.color), (c) => void pick(c))}</div>
        <div class="row"><label for="op">{t('ui.opacity')}</label><input id="op" type="range" min="10" max="100" value={Math.round((annot.opacity ?? 1) * 100)} onchange={(e) => restyle({ opacity: Number(e.currentTarget.value) / 100 })} /></div>
      </div>
      <div class="ins-s"><h4>{t('ui.comment')}</h4>{@render commentBox(annot, 3)}</div>
    {:else if annot.type === 'text'}
      <div class="ins-s"><h4>{t('ui.comment')}</h4>{@render commentBox(annot, 5)}<div class="row"><label>{t('ui.colour')}</label>{@render swatches(col(annot.color), (c) => void pick(c), SWATCH.slice(0, 4))}</div></div>
    {:else if annot.type === 'square' || annot.type === 'circle' || annot.type === 'line' || annot.type === 'polyline' || annot.type === 'polygon'}
      {@const a = annot}
      <div class="ins-s">
        <h4>{t('ui.stroke')}</h4>
        <div class="row"><label>{t('ui.colour')}</label>{@render swatches(col(a.color), (c) => void pick(c), SWATCH.slice(4))}</div>
        <div class="row"><label for="sw">{t('ui.width')}</label><input id="sw" type="range" min="0.5" max="12" step="0.5" value={a.strokeWidth} onchange={(e) => restyle({ strokeWidth: Number(e.currentTarget.value) } as Partial<Annotation>)} /></div>
        <div class="row"><label for="ss">{t('ui.style')}</label><select id="ss" value={a.strokeStyle} onchange={(e) => restyle({ strokeStyle: e.currentTarget.value } as Partial<Annotation>)}><option value="solid">{t('ui.style.solid')}</option><option value="dashed">{t('ui.style.dashed')}</option></select></div>
        {#if a.type !== 'line' && a.type !== 'polyline'}
          <div class="row"><label>{t('ui.fill')}</label>
            <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn sm" class:primary={!a.fillColor} onclick={() => restyle({ fillColor: undefined } as Partial<Annotation>)}>{t('ui.fill.none')}</button>
            {#each ['#fff3d6', '#e6eeff', '#ffe4e6', '#dcfce7'] as c (c)}<button class="swatch" class:on={col(a.fillColor) === c} style="background:{c};width:22px;height:22px;flex:none" aria-label={c} onclick={() => pick(c, 'fillColor')}></button>{/each}</div>
          </div>
        {/if}
        <div class="row"><label for="op2">{t('ui.opacity')}</label><input id="op2" type="range" min="10" max="100" value={Math.round((a.opacity ?? 1) * 100)} onchange={(e) => restyle({ opacity: Number(e.currentTarget.value) / 100 })} /></div>
      </div>
      <div class="ins-s"><h4>{t('ui.comment')}</h4>{@render commentBox(annot, 2)}</div>
    {:else if annot.type === 'freetext'}
      {@const a = annot}
      <div class="ins-s">
        <h4>{t('ui.text')}</h4>
        <textarea rows="3" aria-label={t('ui.text')} value={a.contents ?? ''} onchange={(e) => restyle({ contents: e.currentTarget.value })}></textarea>
        <div class="row"><label for="ff">{t('ui.font')}</label><select id="ff" value={a.fontFamily} onchange={(e) => restyle({ fontFamily: e.currentTarget.value } as Partial<Annotation>)}><option value="sans">{t('ui.font.sans')}</option><option value="serif">{t('ui.font.serif')}</option><option value="mono">{t('ui.font.mono')}</option></select></div>
        <div class="row"><label for="fs">{t('ui.size')}</label><input id="fs" type="number" min="6" max="96" value={Math.round(a.fontSize)} onchange={(e) => restyle({ fontSize: Number(e.currentTarget.value) } as Partial<Annotation>)} /></div>
        <div class="row"><label>{t('ui.colour')}</label>{@render swatches(col(a.textColor), (c) => void pick(c, 'textColor'), SWATCH.slice(4))}</div>
        <div class="row" role="group" aria-label={t('ui.align')}>
          {#each [['left', 'align-left', 'ui.alignLeft'], ['center', 'align-center', 'ui.alignCenter'], ['right', 'align-right', 'ui.alignRight']] as [al, ic, lb] (al)}
            <button class="ib" class:on={a.align === al} aria-pressed={a.align === al} aria-label={t(lb!)} onclick={() => restyle({ align: al } as Partial<Annotation>)}><Icon name={ic!} /></button>
          {/each}
        </div>
        <div class="row"><label>{t('ui.fill')}</label>
          <div class="row" style="gap:8px"><button class="btn sm" class:primary={!a.backgroundColor} onclick={() => restyle({ backgroundColor: undefined } as Partial<Annotation>)}>{t('ui.fill.none')}</button>
          {#each ['#ffffff', '#fff3d6', '#e6eeff'] as c (c)}<button class="swatch" class:on={col(a.backgroundColor) === c} style="background:{c};width:22px;height:22px;flex:none" aria-label={c} onclick={() => pick(c, 'backgroundColor')}></button>{/each}</div>
        </div>
      </div>
    {:else if annot.type === 'stamp'}
      <div class="ins-s">
        <h4>{t('ui.sizePosition')}</h4>
        <div class="row"><label for="wd">{t('ui.width')}</label><input id="wd" type="number" min="4" value={Math.round(annot.rect.width)} onchange={(e) => setSize('width', Number(e.currentTarget.value), e.currentTarget)} /></div>
        <div class="row"><label for="ht">{t('ui.height')}</label><input id="ht" type="number" min="4" value={Math.round(annot.rect.height)} onchange={(e) => setSize('height', Number(e.currentTarget.value), e.currentTarget)} /></div>
        <p class="note">{t('ui.keepProportions')}</p>
      </div>
      <div class="ins-s"><button class="btn" onclick={flattenSelected}><Icon name="layers" />{t('sign.flatten')}</button></div>
    {:else}
      <div class="ins-s"><p class="note">{annot.type === 'other' ? annot.subtype : ''}</p>{@render commentBox(annot, 2)}</div>
    {/if}
    {@render common(annot)}
  {:else if image}
    {@render head(t('ui.image'), 'image')}
    <div class="ins-s">
      <h4>{t('ui.sizePosition')}</h4>
      <div class="kv"><span>{t('ui.width')}</span><b>{unit(image.bounds.width)} {app.settings.units}</b></div>
      <div class="kv"><span>{t('ui.height')}</span><b>{unit(image.bounds.height)} {app.settings.units}</b></div>
      {#if image.imageSize}<div class="kv"><span>px</span><b>{image.imageSize.width} × {image.imageSize.height}</b></div>{/if}
      <div class="row">
        <button class="btn sm" onclick={() => app.guard(() => session.run(services.objects.rotate((sel as { page: number }).page, image!, -90)))} aria-label={t('ui.rotateImageRight')}><Icon name="rotate-cw" /></button>
        <button class="btn sm" onclick={() => app.guard(() => session.run(services.objects.rotate((sel as { page: number }).page, image!, 90)))} aria-label={t('ui.rotateImageLeft')}><Icon name="rotate-ccw" /></button>
      </div>
    </div>
    <div class="ins-s">
      <button class="btn" onclick={replaceImage}><Icon name="replace" />{t('ui.replaceImage')}</button>
      <button class="btn" onclick={extractImage}><Icon name="download" />{t('ui.extractImage')}</button>
      <button class="btn danger" onclick={() => m.tools.deleteSelection()}><Icon name="trash-2" />{t('action.delete')}</button>
    </div>
  {:else if mode === 'fill'}
    {@render head(t('tool.fillForm'), 'text-cursor-input')}
    <div class="ins-s">
      <h4>{t('form.fields')}</h4>
      <div class="kv"><span>{t('form.fields')}</span><b>{m.form.fillableCount}</b></div>
      <div class="kv"><span>{t('form.filled')}</span><b>{filled} / {m.form.fillableCount}</b></div>
      <button class="btn primary" onclick={() => m.smart.start()}><Icon name="sparkles" />{t('banner.autoFill')}</button>
      {#if m.form.fillableCount > 0}
        <div class="row"><button class="btn sm" onclick={() => m.form.exportJson()}>{t('form.export')}</button><button class="btn sm" onclick={() => m.form.importJson()}>{t('form.import')}</button></div>
        <button class="btn sm danger" onclick={() => m.form.reset()}>{t('form.reset')}</button>
      {/if}
    </div>
    <div class="ins-s"><p class="note">{t('ui.profileHint')}</p><button class="btn sm" onclick={() => ui.openDialog('profiles')}><Icon name="contact" />{t('cmd.profiles')}</button></div>
    <div class="ins-s"><h4>{t('sign.library')}</h4><p class="note">{t('ui.signHint')}</p></div>
  {:else}
    {@render head(t('ui.document'), 'file-text')}
    <div class="ins-s">
      <div class="kv"><span>{t('ui.details.name')}</span><b style="word-break:break-all">{session.name}</b></div>
      <div class="kv"><span>{t('ui.details.pages')}</span><b>{session.pageCount}</b></div>
      <div class="kv"><span>{t('ui.details.pageSize')}</span><b>{pageSize}</b></div>
      {#if session.byteSize}<div class="kv"><span>{t('ui.details.fileSize')}</span><b>{formatBytes(session.byteSize)}</b></div>{/if}
      <div class="kv"><span>{t('ui.modified')}</span><b>{date(session.meta.modDate)}</b></div>
    </div>
    <div class="ins-s">
      <button class="btn" onclick={() => run('file.properties')}><Icon name="info" />{t('ui.editProperties')}</button>
      <button class="btn" onclick={() => run('export.images')}><Icon name="file-image" />{t('ui.exportImages')}</button>
    </div>
    {#if mode === 'annotate' || mode === 'edit'}
      <div class="ins-s"><p class="note">{mode === 'annotate' ? t('ui.annotateHint') : t('ui.editHint')}</p>{#if mode === 'edit'}<p class="note">{t('edit.hint')}</p>{/if}</div>
    {/if}
    {#if session.meta.hasSignatures}<div class="ins-s"><div class="callout"><Icon name="triangle-alert" /><span>{t('banner.signed')}</span></div></div>{/if}
  {/if}
</aside>
<span hidden>{rgb(null)}</span>
