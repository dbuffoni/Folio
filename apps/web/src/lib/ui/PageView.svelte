<script lang="ts">
  import {
    themeFilter,
    themeInvertsImages,
    type DocumentSession,
    type Handle,
  } from '@folio/app';
  import {
    applyToPoint,
    applyToRect,
    invert,
    multiply,
    pageToViewMatrix,
    rectFromPoints,
    translation,
  } from '@folio/core';
  import type { Annotation, FormField, LinkInfo, Matrix, PageObject, Rect, Rotation } from '@folio/ports';
  import { HIGHLIGHT_COLORS, cappedScale, type DetectedArea, type EditableLine } from '@folio/services';
  import { t, tm } from '#lib/i18n/index.ts';
  import { dep, app, models, services, track } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import { colorToHex, hexToColor, paintSoon, pooledCanvas, png } from './raster.ts';
  import { tip } from './tip.ts';
  import { untrack } from 'svelte';

  let {
    session,
    page,
    box,
    visible,
    scrolling = false,
  }: {
    session: DocumentSession;
    page: number;
    box: { x: number; y: number; width: number; height: number };
    visible: boolean;
    /** The canvas is being scrolled: renders wait a little longer so pages flying past are skipped. */
    scrolling?: boolean;
  } = $props();
  const m = $derived(models(session));
  const tools = $derived(m.tools);
  const v = $derived(track());
  const info = $derived(dep(v, session.pageInfos[page]));
  const zoom = $derived(dep(v, session.view.zoom));
  const mode = $derived(dep(v, session.mode));
  const tool = $derived(dep(v, tools.tool));
  const sel = $derived(dep(v, session.selection));
  const theme = $derived(dep(v, session.view.theme));

  // ---- geometry: PDF user space ↔ CSS pixels of this page box ---------------------------------
  const toView = $derived.by((): Matrix => {
    if (!info) return [1, 0, 0, 1, 0, 0];
    const rot = ((info.rotation + session.view.rotation) % 360) as Rotation;
    return multiply(translation(-info.cropBox.x, -info.cropBox.y), pageToViewMatrix(info.size, rot, zoom));
  });
  const toPage = $derived(invert(toView));
  const vr = (r: Rect): Rect => applyToRect(toView, r);
  const css = (r: Rect): string => {
    const q = vr(r);
    return `left:${q.x}px;top:${q.y}px;width:${q.width}px;height:${q.height}px`;
  };
  const upright = $derived(info ? (info.rotation + session.view.rotation) % 360 === 0 : true);

  // ---- bitmap ---------------------------------------------------------------------------------
  let canvas: HTMLCanvasElement | undefined = $state();
  $effect(() => {
    if (canvas) canvas.style.filter = themeFilter(theme);
  });
  let renderTick = $state(0);
  $effect(() =>
    untrack(() =>
      session.invalidated.on((inv) => {
        if (!('pages' in inv) || inv.pages.includes(page)) renderTick++;
      }),
    ),
  );
  // Effects name their dependencies first and do the work untracked: reading a live model inside
  // an effect would otherwise re-run it on every model change.
  const viewRotation = $derived(session.view.rotation);
  $effect(() => {
    void renderTick;
    const rotation = viewRotation;
    const target = canvas;
    const pageInfo = info;
    const z = zoom;
    if (!target || !pageInfo || !visible) return;
    const ac = new AbortController();
    const timer = untrack(() => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const scale = cappedScale(pageInfo.size, z * dpr);
      const priority = page === session.view.page ? 'visible' : 'near';
      // A short delay coalesces renders while zooming with the wheel; a longer one while scrolling.
      return setTimeout(() => {
        session.renderer
          .render({ page, scale, rotation, priority, bitmap: true, signal: ac.signal })
          .then((img) => !ac.signal.aborted && paintSoon(target, img, () => ac.signal.aborted))
          .catch((e) => (e as { code?: string }).code !== 'cancelled' && app.reportError(e));
      }, scrolling ? 90 : 40);
    });
    return () => (clearTimeout(timer), ac.abort());
  });

  // ---- page data used by overlays ---------------------------------------------------------------
  let annotations = $state<Annotation[]>([]);
  let links = $state<LinkInfo[]>([]);
  let images = $state<PageObject[]>([]);
  let areas = $state<DetectedArea[]>([]);
  let selRects = $state<Rect[]>([]);
  let lines = $state<EditableLine[]>([]);
  $effect(() => {
    void renderTick;
    if (!visible) return;
    untrack(() => void session.annotations(page).then((a) => (annotations = a)));
  });
  $effect(() => {
    void renderTick;
    if (!visible) return;
    untrack(
      () =>
        void session.nav
          .links(page)
          .then((l) => (links = l))
          .catch(() => (links = [])),
    );
  });
  $effect(() => {
    void renderTick;
    const imageSelected = sel.kind === 'object' && sel.page === page;
    if (!visible || !(themeInvertsImages(theme) || mode === 'edit' || imageSelected)) return void (images = []);
    untrack(() => void services.objects.imagesOn(session.doc, page).then((o) => (images = o)));
  });
  const showAreas = $derived(
    mode === 'fill' && (tool === 'cover-type' || tool === 'check' || tool === 'cross'),
  );
  $effect(() => {
    void renderTick;
    if (!visible || !showAreas) return void (areas = []);
    untrack(() => void tools.detectedAreas(page).then((a) => (areas = a)));
  });
  $effect(() => {
    const s = sel;
    untrack(() => {
      if (s.kind !== 'text' || s.range.page !== page) return void (selRects = []);
      const range = s.range;
      void session.text.layer(page).then((layer) => (selRects = session.text.rects(layer, range)));
    });
  });
  $effect(() => {
    void renderTick;
    if (!visible || tool !== 'edit-text') return void (lines = []);
    untrack(
      () =>
        void session.text.layer(page).then((layer) => {
          try {
            lines = services.textEdit.lines(layer);
          } catch {
            lines = [];
          }
        }),
    );
  });

  const hits = $derived(dep(v, m.find.open ? m.find.hitsOnPage(page) : []));
  const selectedAnnots = $derived(
    sel.kind === 'annotations' && sel.page === page ? annotations.filter((a) => sel.ids.includes(a.id!)) : [],
  );
  const drag = $derived(dep(v, tools.drag && tools.drag.page === page ? tools.drag : null));
  const boxes = $derived(
    drag ? (drag.object ? [] : drag.preview.map((a) => a.rect)) : selectedAnnots.map((a) => a.rect),
  );
  const selectedImage = $derived(
    sel.kind === 'object' && sel.page === page ? images.find((o) => o.id === sel.id) : undefined,
  );
  const draft = $derived(dep(v, tools.draft && tools.draft.page === page ? tools.draft : null));
  const ghost = $derived(dep(v, tools.ghost && tools.ghost.page === page ? tools.ghost : null));
  const hover = $derived(dep(v, tools.hoverLine && tools.hoverLine.page === page ? tools.hoverLine.line : null));
  const edit = $derived(dep(v, tools.inlineEdit && tools.inlineEdit.page === page ? tools.inlineEdit : null));
  const typing = $derived(dep(v, tools.typing && tools.typing.page === page ? tools.typing : null));
  const notice = $derived(dep(v, tools.notice && tools.notice.result.page === page ? tools.notice : null));
  const smart = $derived(dep(v, m.smart));
  const located = $derived(
    smart.located ? smart.suggestions.find((s) => s.ref === smart.located && s.page === page) : undefined,
  );
  const fields = $derived(
    dep(v, mode === 'fill' || mode === 'view'
      ? m.form.stops.filter((s) => s.field.widgets[s.widget]!.page === page)
      : []),
  );
  const selBounds = $derived(
    selRects.length
      ? vr(
          selRects.reduce((a, b) => ({
            x: Math.min(a.x, b.x),
            y: Math.max(a.y + a.height, b.y + b.height) - Math.max(a.height, b.height),
            width: 0,
            height: Math.max(a.height, b.height),
          })),
        )
      : null,
  );

  // ---- pointer → tool controller ----------------------------------------------------------------
  let overlay: HTMLDivElement | undefined = $state();
  const point = (e: PointerEvent | MouseEvent) => {
    const r = overlay!.getBoundingClientRect();
    return applyToPoint(toPage, { x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const mods = (e: PointerEvent | MouseEvent) => ({
    shift: e.shiftKey,
    alt: e.altKey,
    mod: e.ctrlKey || e.metaKey,
  });
  let down = $state(false);
  async function onpointerdown(e: PointerEvent): Promise<void> {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, button, .fl, .sugg')) return;
    // An open editor is committed by clicking elsewhere, before the click means anything else.
    if (tools.typing || tools.inlineEdit) {
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    // The default action of the press would move the focus after an editor opened by this very
    // press has taken it; the focus is managed here instead.
    e.preventDefault();
    const active = document.activeElement as HTMLElement | null;
    const scroller = overlay!.closest<HTMLElement>('[tabindex]');
    if (scroller && active !== scroller) scroller.focus({ preventScroll: true });
    else if (!scroller) active?.blur();
    overlay!.setPointerCapture(e.pointerId);
    down = true;
    const handle = (target.dataset.handle as Handle | undefined) ?? undefined;
    if (e.detail === 2) await tools.doubleClick(page, point(e));
    else if (e.detail >= 3) await tools.tripleClick(page, point(e));
    else await tools.pointerDown(page, point(e), mods(e), handle);
  }
  function onpointermove(e: PointerEvent): void {
    if (!down && !tools.ghost && tool !== 'edit-text' && !tools.draft) return;
    void tools.pointerMove(page, point(e), mods(e));
  }
  function onpointerup(e: PointerEvent): void {
    if (!down) return;
    down = false;
    void tools.pointerUp(page, point(e), mods(e));
  }
  function linkClick(e: MouseEvent, link: LinkInfo): void {
    e.stopPropagation();
    void app.followLink(link.target, session);
  }

  // ---- inline editors ---------------------------------------------------------------------------
  let editValue = $state('');
  let typed = $state('');
  $effect(() => {
    const e = edit;
    untrack(() => {
      if (!e) return;
      editValue = e.text;
      tools.rememberEditSize(e.line.fontSize);
    });
  });
  $effect(() => {
    const ty = typing;
    typed = untrack(() => ty?.editing?.contents ?? '');
  });
  function focusAt(node: HTMLInputElement, caret: number) {
    node.focus();
    node.setSelectionRange(caret, caret);
  }
  function autofocus(node: HTMLElement) {
    node.focus();
  }
  const fontCss = (name: string): string =>
    /Times|Serif|Georgia|Roman/i.test(name) && !/Sans/i.test(name)
      ? '"Liberation Serif","Times New Roman",serif'
      : /Courier|Mono/i.test(name)
        ? '"Liberation Mono","Courier New",monospace'
        : '"Liberation Sans",Arial,Helvetica,sans-serif';

  // ---- form fields ------------------------------------------------------------------------------
  let suggest = $state<{ id: string; items: string[] } | null>(null);
  let activeSuggestion = $state(-1);
  let chosenByKey: { id: string; value: string } | null = null;
  async function loadSuggestions(field: FormField, value: string): Promise<void> {
    const items = await m.form.suggestions(field, value);
    activeSuggestion = -1;
    suggest = items.length && !(items.length === 1 && items[0] === value) ? { id: field.id, items } : null;
  }
  const fieldFont = (f: FormField, r: Rect): number =>
    Math.max(7, Math.min(14, f.multiline ? 11 : r.height * 0.62)) * zoom;
  const cursor = $derived(
    tool === 'place'
      ? 't-place'
      : [
            'rect',
            'ellipse',
            'line',
            'arrow',
            'polyline',
            'whiteout',
            'snapshot',
            'note',
            'check',
            'cross',
          ].includes(tool)
        ? 't-cross'
        : [
              'textbox',
              'add-text',
              'cover-type',
              'edit-text',
              'highlight',
              'underline',
              'strikeout',
              'squiggly',
            ].includes(tool)
          ? 't-text'
          : '',
  );
  const HL = Object.values(HIGHLIGHT_COLORS).map(colorToHex).slice(0, 4);
</script>

<div
  class="pv {cursor}"
  style="left:{box.x}px;top:{box.y}px;width:{box.width}px;height:{box.height}px"
  data-page={page}
  role="group"
  aria-label="{t('ui.page')} {page + 1}"
  use:pooledCanvas={(c) => (canvas = c)}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="ov"
    bind:this={overlay}
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    onpointerleave={() =>
      tool === 'edit-text' && !tools.inlineEdit && void tools.pointerMove(page, { x: -1e6, y: -1e6 })}
  >
    {#if themeInvertsImages(theme)}
      {#each images as img (img.id)}<div
          class="imgfix"
          style="{css(img.bounds)};backdrop-filter:invert(0.9) hue-rotate(180deg);filter:none"
        ></div>{/each}
    {/if}

    {#each hits as h, i (i)}{#each h.rects as r, j (j)}<div
          class="hit"
          class:cur={h.active}
          style={css(r)}
        ></div>{/each}{/each}
    {#each selRects as r, i (i)}<div class="selr" style={css(r)}></div>{/each}

    {#if mode === 'view' && tool === 'select'}
      {#each links as link, i (i)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="linkhit"
          style={css(link.rect)}
          role="link"
          tabindex="-1"
          onclick={(e) => linkClick(e, link)}
          onpointerdown={(e) => e.stopPropagation()}
          title={link.target.kind === 'uri'
            ? link.target.uri
            : link.target.kind === 'page'
              ? `${t('ui.page')} ${link.target.page + 1}`
              : ''}
        ></div>
      {/each}
    {/if}

    {#if showAreas}
      {#each areas as a (a.id)}<div class="area" style={css(a.rect)} title={a.label ?? ''}></div>{/each}
    {/if}
    {#if smart.stage === 'review'}
      {#each smart.suggestions.filter((s) => s.page === page && s.accepted && s.value !== '' && s.kind === 'detected') as s (s.ref)}
        <div
          class="preview"
          style="{css(s.rect)};font-size:{Math.min(11, s.rect.height * 0.7) * zoom}px;line-height:{vr(s.rect)
            .height}px;padding-left:2px"
        >
          {s.fieldType === 'checkbox' ? '✓' : s.value}
        </div>
      {/each}
    {/if}
    {#if located}<div class="located" style={css(located.rect)}></div>{/if}

    {#if upright}
      {#each fields as stop (`${stop.field.id}-${stop.widget}`)}
        {@const f = stop.field}
        {@const w = f.widgets[stop.widget]!}
        {@const r = vr(w.rect)}
        {@const style = `left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;font-size:${fieldFont(f, w.rect)}px`}
        {@const cls = `fld${m.form.highlight ? ' hl' : ''}`}
        {#if f.type === 'text' && f.multiline}
          <textarea
            class={cls}
            {style}
            title={f.label ?? f.name}
            aria-label={f.label ?? f.name}
            maxlength={f.maxLength}
            value={f.value}
            onfocus={() => m.form.focusField(f.id, stop.widget)}
            onchange={(e) => m.form.set(f, e.currentTarget.value)}></textarea>
        {:else if f.type === 'text'}
          <input
            class={cls}
            {style}
            type={f.password ? 'password' : 'text'}
            title={f.label ?? f.name}
            aria-label={f.label ?? f.name}
            aria-required={f.required}
            maxlength={f.maxLength}
            autocomplete="off"
            spellcheck="false"
            value={f.value}
            style:letter-spacing={f.comb && f.maxLength
              ? `${Math.max(0, r.width / f.maxLength - fieldFont(f, w.rect) * 0.6)}px`
              : null}
            onfocus={(e) => (
              m.form.focusField(f.id, stop.widget),
              void loadSuggestions(f, e.currentTarget.value)
            )}
            oninput={(e) => loadSuggestions(f, e.currentTarget.value)}
            onblur={() => setTimeout(() => suggest?.id === f.id && (suggest = null), 150)}
            role={suggest?.id === f.id ? 'combobox' : undefined}
            aria-expanded={suggest?.id === f.id ? true : undefined}
            aria-controls={suggest?.id === f.id ? `sugg-${f.id}` : undefined}
            aria-autocomplete={suggest?.id === f.id ? 'list' : undefined}
            aria-activedescendant={suggest?.id === f.id && activeSuggestion >= 0 ? `sugg-${f.id}-${activeSuggestion}` : undefined}
            onkeydown={(e) => {
              const open = suggest?.id === f.id ? suggest.items : null;
              if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                const n = open.length;
                activeSuggestion = e.key === 'ArrowDown' ? (activeSuggestion + 1) % n : (activeSuggestion - 1 + n) % n;
              } else if (open && e.key === 'Enter' && activeSuggestion >= 0) {
                e.preventDefault();
                // Commit the choice once: browsers differ on whether leaving the field then fires "change".
                const chosen = open[activeSuggestion]!;
                e.currentTarget.value = chosen;
                chosenByKey = { id: f.id, value: chosen };
                suggest = null;
                void m.form.set(f, chosen);
                e.currentTarget.blur();
              } else if (open && e.key === 'Escape') {
                e.stopPropagation();
                suggest = null;
              } else if (e.key === 'Enter') e.currentTarget.blur();
            }}
            onchange={(e) => {
              const done = chosenByKey;
              chosenByKey = null;
              if (done?.id === f.id && done.value === e.currentTarget.value) return;
              void m.form.set(f, e.currentTarget.value);
            }}
          />
          {#if suggest?.id === f.id}
            <div class="sugg" id="sugg-{f.id}" style="left:{r.x}px;top:{r.y + r.height + 2}px" role="listbox">
              {#each suggest.items as s, si (s)}<button
                  role="option"
                  id="sugg-{f.id}-{si}"
                  tabindex="-1"
                  class:on={si === activeSuggestion}
                  aria-selected={si === activeSuggestion}
                  onpointerdown={(e) => (e.preventDefault(), (suggest = null), void m.form.set(f, s))}
                  >{s}</button
                >{/each}
            </div>
          {/if}
        {:else if f.type === 'checkbox'}
          <input
            class={cls}
            {style}
            type="checkbox"
            title={f.label ?? f.name}
            aria-label={f.label ?? f.name}
            checked={f.value !== 'Off'}
            onfocus={() => m.form.focusField(f.id, stop.widget)}
            onchange={(e) => m.form.set(f, e.currentTarget.checked)}
          />
        {:else if f.type === 'radio'}
          <input
            class={cls}
            {style}
            type="radio"
            name={f.id}
            title={`${f.label ?? f.name}: ${w.exportValue}`}
            aria-label={`${f.label ?? f.name}: ${w.exportValue}`}
            checked={f.value === w.exportValue}
            onfocus={() => m.form.focusField(f.id, stop.widget)}
            onchange={() => m.form.set(f, w.exportValue!)}
          />
        {:else if f.type === 'dropdown'}
          <select
            class={cls}
            {style}
            title={f.label ?? f.name}
            aria-label={f.label ?? f.name}
            value={f.value}
            onfocus={() => m.form.focusField(f.id, stop.widget)}
            onchange={(e) => m.form.set(f, e.currentTarget.value)}
          >
            <option value=""></option>
            {#each f.options ?? [] as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
          </select>
        {:else if f.type === 'listbox'}
          <select
            class={cls}
            {style}
            multiple={f.multiSelect}
            size={Math.max(2, f.options?.length ?? 2)}
            title={f.label ?? f.name}
            aria-label={f.label ?? f.name}
            onfocus={() => m.form.focusField(f.id, stop.widget)}
            onchange={(e) =>
              m.form.set(
                f,
                [...e.currentTarget.selectedOptions].map((o) => o.value),
              )}
          >
            {#each f.options ?? [] as o (o.value)}<option
                value={o.value}
                selected={(f.values ?? []).includes(o.value)}>{o.label}</option
              >{/each}
          </select>
        {/if}
      {/each}
    {/if}

    {#each boxes as r, i (i)}
      <div class="abox" style={css(r)}>
        {#if boxes.length === 1 && !selectedAnnots[0]?.locked && !['highlight', 'underline', 'strikeout', 'squiggly', 'text'].includes(selectedAnnots[0]?.type ?? '')}
          <b class="h tl" data-handle="tl"></b><b class="h tr" data-handle="tr"></b><b
            class="h bl"
            data-handle="bl"
          ></b><b class="h br" data-handle="br"></b>
        {/if}
      </div>
    {/each}
    {#if drag?.objectPreview}
      <div class="abox" style={css(drag.objectPreview)}>
        <b class="h tl" data-handle="tl"></b><b class="h tr" data-handle="tr"></b><b
          class="h bl"
          data-handle="bl"
        ></b><b class="h br" data-handle="br"></b>
      </div>
    {:else if selectedImage}
      <div class="abox" style={css(selectedImage.bounds)}>
        <b class="h tl" data-handle="tl"></b><b class="h tr" data-handle="tr"></b><b
          class="h bl"
          data-handle="bl"
        ></b><b class="h br" data-handle="br"></b>
      </div>
    {/if}
    {#each drag?.snap.guides ?? [] as g, i (i)}
      {@const p = applyToPoint(toView, g.axis === 'x' ? { x: g.at, y: 0 } : { x: 0, y: g.at })}
      <div
        class="guide"
        style={g.axis === 'x'
          ? `left:${p.x}px;top:0;width:1px;height:100%`
          : `top:${p.y}px;left:0;height:1px;width:100%`}
      ></div>
    {/each}

    {#if draft}
      {#if draft.tool === 'line' || draft.tool === 'arrow' || draft.tool === 'polyline'}
        {@const pts = [...(draft.points ?? [draft.start]), draft.current].map((p) => applyToPoint(toView, p))}
        <svg style="left:0;top:0;width:100%;height:100%;pointer-events:none"
          ><polyline
            points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="#d32f2f"
            stroke-width="2"
            stroke-dasharray="5 4"
          /></svg
        >
      {:else}
        <div
          class="draft"
          style="{css(rectFromPoints(draft.start, draft.current))};{draft.tool === 'ellipse'
            ? 'border-radius:50%'
            : ''}"
        ></div>
      {/if}
    {/if}
    {#if ghost?.rect}
      <div class="pghost" style={css(ghost.rect)}>
        {#if ghost.preview}<img use:png={ghost.preview} alt="" />{/if}
      </div>
    {/if}

    {#if tool === 'edit-text' && !edit}
      {#if hover}
        {@const r = vr(hover.line.rect)}
        <div
          class="lineh"
          class:blocked={!!hover.blocked}
          style="left:{r.x}px;top:{r.y}px;width:{r.width}px;height:{r.height}px"
        ></div>
        <div
          class="fl fbadge"
          style="left:{r.x}px;top:{Math.max(
            0,
            r.y - 28,
          )}px;background:var(--color-surface);color:var(--color-fg-2);border-color:var(--color-border);pointer-events:none"
        >
          <Icon name={hover.blocked ? 'lock' : 'type'} /><span
            >{hover.blocked
              ? tm(hover.blocked)
              : `${hover.fontName} ${Math.round(hover.fontSize * 10) / 10} pt`}</span
          >
        </div>
      {/if}
    {/if}
    {#if edit}
      {@const r = vr(edit.line.line.rect)}
      <input
        class="inl"
        type="text"
        aria-label={t('tool.editText')}
        style="left:{r.x}px;top:{r.y}px;width:{Math.max(
          r.width + 40,
          editValue.length * edit.line.fontSize * zoom * 0.6,
        )}px;height:{r.height}px;font-size:{edit.line.fontSize *
          zoom}px;line-height:{r.height}px;font-family:{fontCss(
          edit.line.fontName,
        )};font-weight:{/bold/i.test(edit.line.fontName) ? 700 : 400}"
        bind:value={editValue}
        use:focusAt={edit.caret}
        onkeydown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') void tools.commitInlineEdit(editValue);
          else if (e.key === 'Escape') tools.cancel();
        }}
        onblur={() => tools.inlineEdit && void tools.commitInlineEdit(editValue)}
      />
      <div
        class="fl fbadge"
        style="left:{r.x}px;top:{Math.max(
          0,
          r.y - 30,
        )}px;background:var(--color-surface);color:var(--color-fg-2);border-color:var(--color-border)"
      >
        <Icon name="type" /><span>{edit.badge.text}</span>
      </div>
    {/if}
    {#if notice}
      {@const r = vr(
        notice.rect ??
          lines.find((l) => l.text === notice.result.text)?.line.rect ?? {
            x: 40,
            y: 40,
            width: 10,
            height: 10,
          },
      )}
      <div class="fl fbadge" role="status" style="left:{Math.max(4, r.x)}px;top:{Math.max(0, r.y - 30)}px">
        <Icon name="triangle-alert" /><span
          >{notice.kind === 'substituted'
            ? `${notice.result.font.kind === 'substituted' ? notice.result.font.from : ''} → ${notice.result.font.kind === 'substituted' ? notice.result.font.to : ''}`
            : tm(notice.message)}</span
        >
        {#if notice.kind === 'substituted'}<button class="link" use:tip={t('edit.fontSubstitutedWhy')}
            >{t('action.why')}</button
          >{/if}
        {#if notice.kind === 'overflow' && notice.result.shrinkFactor}<button
            class="link"
            onclick={() => tools.shrinkToFit()}>{t('edit.shrink')}</button
          >{/if}
        <button class="link" onclick={() => ((tools.notice = null), tools.changed.emit())}
          >{notice.kind === 'overflow' ? t('edit.keep') : t('action.dismiss')}</button
        >
      </div>
    {/if}
    {#if typing}
      {@const r = vr(typing.rect)}
      <textarea
        class="typing"
        aria-label={t('ui.typeHere')}
        placeholder={t('ui.typeHere')}
        style="left:{r.x}px;top:{r.y}px;width:{Math.max(
          r.width,
          120,
        )}px;min-height:{r.height}px;font-size:{typing.fontSize * zoom}px;font-family:{fontCss(
          tools.options.fontFamily === 'serif' ? 'Serif' : tools.options.fontFamily === 'mono' ? 'Mono' : '',
        )};color:{typing.kind === 'cover' ? '#111' : colorToHex(tools.options.textColor)}"
        rows={typing.kind === 'cover' ? 1 : 2}
        bind:value={typed}
        use:autofocus
        onkeydown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') tools.cancel();
          else if (e.key === 'Enter' && (typing.kind !== 'textbox' || e.ctrlKey || e.metaKey))
            (e.preventDefault(), void tools.commitTyping(typed));
        }}
        onblur={() => tools.typing && void tools.commitTyping(typed)}></textarea>
    {/if}

    {#if selBounds && sel.kind === 'text' && !down}
      <div
        class="fl mini"
        style="left:{Math.max(4, selBounds.x)}px;top:{Math.max(4, selBounds.y - 44)}px"
        role="toolbar"
        aria-label={t('ui.highlight')}
      >
        {#each HL as c (c)}<button
            class="ib"
            aria-label="{t('ui.highlight')} {c}"
            onclick={() => tools.applyMarkup('highlight', hexToColor(c))}
            ><span class="swatch" style="background:{c}"></span></button
          >{/each}
        <span class="vsep"></span>
        <button
          class="ib"
          onclick={() => tools.applyMarkup('underline')}
          use:tip={t('ui.underline')}
          aria-label={t('ui.underline')}><Icon name="underline" /></button
        >
        <button
          class="ib"
          onclick={() => tools.applyMarkup('strikeout')}
          use:tip={t('ui.strikeout')}
          aria-label={t('ui.strikeout')}><Icon name="strikethrough" /></button
        >
        <button
          class="ib"
          onclick={() => tools.commentSelection('')}
          use:tip={[t('tool.note'), 'N']}
          aria-label={t('tool.note')}><Icon name="message-square" /></button
        >
        <button
          class="ib"
          onclick={() => tools.copySelection().then(() => app.toast('info', { key: 'toast.textCopied' }))}
          use:tip={t('cmd.copy')}
          aria-label={t('cmd.copy')}><Icon name="copy" /></button
        >
      </div>
    {/if}
  </div>
</div>
