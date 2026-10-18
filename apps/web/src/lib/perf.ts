// Opt-in scroll profiler for comparing engines (Chromium, WebKitGTK in the AppImage). It is off unless
// the page is opened with `?perf` or localStorage has `folio.perf=1`; nothing is recorded or sent
// anywhere: a run returns its numbers to whoever calls `window.__folioPerf` (a test harness, the
// DevTools console), and `download()` saves them as a JSON file on the device.
import type { PdfDocument, PdfEngine } from '@folio/ports';
import { bumpCount } from './live.svelte.ts';

export interface PerfReport {
  scenario: string;
  userAgent: string;
  /** WebGL renderer string: shows whether the web view draws on the GPU (e.g. NVIDIA) or in software (llvmpipe). */
  gpu: string;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  mountedPages: number;
  durationMs: number;
  /** Time between animation frames while the scenario ran (the display is 16.7 ms at 60 Hz). */
  frames: {
    count: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    over33: number;
    over50: number;
    over100: number;
    blockedMs: number;
  };
  /** Calls to PdfDocument.render started during the run, in milliseconds from call to result. */
  renders: { count: number; p50: number; p95: number; max: number; byScale: Record<string, number> };
  /** Time from the last scroll step until the render queue was empty again. */
  settleMs: number;
}

export interface PerfHost {
  /** Opens a PDF fetched from `url` (web build only). */
  open(url: string): Promise<void>;
}

interface RenderSample {
  at: number;
  ms: number;
  scale: number;
}

const renderSamples: RenderSample[] = [];
let inflight = 0;
let lastRenderEnd = 0;

export function perfRequested(): boolean {
  try {
    return new URLSearchParams(location.search).has('perf') || localStorage.getItem('folio.perf') === '1';
  } catch {
    return new URLSearchParams(location.search).has('perf');
  }
}

/** Times every page render the engine is asked for. */
export function instrumentEngine(engine: PdfEngine): PdfEngine {
  const wrap = (doc: PdfDocument): PdfDocument =>
    new Proxy(doc, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== 'render' || typeof value !== 'function')
          return typeof value === 'function' ? value.bind(target) : value;
        return async (...args: Parameters<PdfDocument['render']>) => {
          const t = performance.now();
          inflight++;
          try {
            return await value.apply(target, args);
          } finally {
            inflight--;
            lastRenderEnd = performance.now();
            renderSamples.push({ at: t, ms: lastRenderEnd - t, scale: args[1].scale });
          }
        };
      },
    });
  return new Proxy(engine, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === 'open' && typeof value === 'function') {
        return async (...args: unknown[]) =>
          wrap(await (value as (...a: unknown[]) => Promise<PdfDocument>).apply(target, args));
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const pct = (sorted: number[], q: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : 0;
const round = (n: number): number => Math.round(n * 10) / 10;
const raf = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SCENARIOS = {
  // No scrolling: the frame time of the page at rest, the floor the other scenarios are compared with.
  idle: { speed: 0, seconds: 3 },
  // A steady wheel or touchpad scroll.
  steady: { speed: 2500, seconds: 6 },
  // Dragging the scrollbar thumb across the document.
  drag: { speed: 25000, seconds: 3 },
} as const;

function gpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

async function runScenario(name: keyof typeof SCENARIOS | string): Promise<PerfReport> {
  const sc = SCENARIOS[name as keyof typeof SCENARIOS];
  if (!sc) throw new Error(`unknown scenario ${name}`);
  const scroller = document.querySelector<HTMLElement>('#canvas');
  if (!scroller) throw new Error('no document is open');
  scroller.scrollTop = 0;
  await sleep(1500); // let the first pages render
  renderSamples.length = 0;
  const deltas: number[] = [];
  const start = performance.now();
  let prev = await raf();
  let top = 0;
  const max = scroller.scrollHeight - scroller.clientHeight;
  while (performance.now() - start < sc.seconds * 1000) {
    const now = await raf();
    deltas.push(now - prev);
    top = Math.min(max, top + (sc.speed * (now - prev)) / 1000);
    scroller.scrollTop = top;
    prev = now;
    if (top >= max) break;
  }
  const end = performance.now();
  // The app waits ~80 ms after the last scroll event before rendering the margin; give it time to start.
  await sleep(400);
  while ((inflight > 0 || performance.now() - lastRenderEnd < 300) && performance.now() - end < 15000)
    await sleep(50);
  const settleMs = Math.max(0, lastRenderEnd - end);
  const d = [...deltas].sort((a, b) => a - b);
  const r = renderSamples
    .filter((s) => s.at >= start)
    .map((s) => s.ms)
    .sort((a, b) => a - b);
  const byScale: Record<string, number> = {};
  for (const s of renderSamples) byScale[s.scale.toFixed(2)] = (byScale[s.scale.toFixed(2)] ?? 0) + 1;
  return {
    scenario: name,
    userAgent: navigator.userAgent,
    gpu: gpuName(),
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: scroller.clientWidth, height: scroller.clientHeight },
    mountedPages: document.querySelectorAll('.pv').length,
    durationMs: round(end - start),
    frames: {
      count: d.length,
      p50: round(pct(d, 0.5)),
      p95: round(pct(d, 0.95)),
      p99: round(pct(d, 0.99)),
      max: round(d[d.length - 1] ?? 0),
      over33: d.filter((x) => x > 33.4).length,
      over50: d.filter((x) => x > 50).length,
      over100: d.filter((x) => x > 100).length,
      blockedMs: round(d.filter((x) => x > 50).reduce((a, x) => a + x - 16.7, 0)),
    },
    renders: {
      count: r.length,
      p50: round(pct(r, 0.5)),
      p95: round(pct(r, 0.95)),
      max: round(r[r.length - 1] ?? 0),
      byScale,
    },
    settleMs: round(settleMs),
  };
}

export function installPerf(host: PerfHost): void {
  const reports: PerfReport[] = [];
  (window as unknown as { __folioPerf: unknown }).__folioPerf = {
    open: (url: string) => host.open(url),
    scenarios: Object.keys(SCENARIOS),
    run: async (name: string) => {
      const report = await runScenario(name);
      reports.push(report);
      return report;
    },
    reports,
    renderSamples,
    /** Model-change notifications so far: each one re-evaluates every template that reads a model. */
    bumps: bumpCount,
    /** Saves every report so far as a JSON file (for the AppImage, where there is no harness). */
    download: () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(
        new Blob([JSON.stringify(reports, null, 2)], { type: 'application/json' }),
      );
      a.download = 'folio-perf.json';
      a.click();
    },
  };
}

/** Ctrl+Alt+Shift+P turns the profiler on or off and reloads, for builds without a console (the AppImage). */
export function registerPerfShortcut(): void {
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyP')) return;
    try {
      if (localStorage.getItem('folio.perf') === '1') localStorage.removeItem('folio.perf');
      else localStorage.setItem('folio.perf', '1');
    } catch {
      return;
    }
    location.reload();
  });
}

/**
 * A small developer panel for measuring in the real app: once a document is open it offers one button
 * per scenario and a text box with the results to copy. Plain DOM and English only, because it exists
 * only while the profiler flag is set and is not part of the product UI.
 */
export function installPerfPanel(): void {
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:99999;width:340px;padding:8px;border-radius:6px;font:12px sans-serif;background:#111;color:#eee;display:none;box-shadow:0 2px 12px #000a';
  panel.setAttribute('data-perf-panel', '');
  const title = document.createElement('div');
  title.textContent = `Folio profiler. GPU: ${gpuName()}`;
  title.style.cssText = 'margin-bottom:6px;font-weight:600';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px';
  const out = document.createElement('textarea');
  out.readOnly = true;
  out.rows = 9;
  out.style.cssText =
    'width:100%;box-sizing:border-box;font:11px monospace;background:#222;color:#eee;border:1px solid #444';
  const lines: string[] = [];
  const log = (text: string): void => {
    lines.push(text);
    out.value = lines.join('\n');
    out.scrollTop = out.scrollHeight;
  };
  const buttons: HTMLButtonElement[] = [];
  // A/B in the same build: put the blurred shadow back while scrolling, as before the fix.
  const ab = document.createElement('label');
  ab.style.cssText = 'display:block;margin-bottom:6px';
  const box = document.createElement('input');
  box.type = 'checkbox';
  const override = document.createElement('style');
  box.onchange = () => {
    override.textContent = box.checked
      ? '#canvas.scrolling .pv{box-shadow:var(--shadow-page)!important}'
      : '';
    log(
      box.checked
        ? 'blurred shadow while scrolling: ON (old behaviour)'
        : 'blurred shadow while scrolling: off (new behaviour)',
    );
  };
  ab.append(box, ' blurred shadow while scrolling (old behaviour)');
  document.head.append(override);
  const run = async (name: string): Promise<void> => {
    for (const b of buttons) b.disabled = true;
    log(`running ${name}: do not touch the window`);
    try {
      const r = await runScenario(name);
      lines.pop();
      log(
        `${name}: frame p50 ${r.frames.p50} p95 ${r.frames.p95} max ${r.frames.max} ms, >33ms ${r.frames.over33}/${r.frames.count}, >100ms ${r.frames.over100}, render p50 ${r.renders.p50} p95 ${r.renders.p95}, settle ${r.settleMs}`,
      );
      log(JSON.stringify(r));
    } catch (e) {
      lines.pop();
      log(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const b of buttons) b.disabled = false;
  };
  for (const name of Object.keys(SCENARIOS)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => void run(name);
    buttons.push(b);
    row.append(b);
  }
  const header = `${navigator.userAgent} | dpr ${window.devicePixelRatio}`;
  log(header);
  panel.append(title, row, ab, out);
  document.body.append(panel);
  // Visible only while a document is on screen; scrolling needs it.
  setInterval(() => {
    panel.style.display = document.querySelector('#canvas') ? 'block' : 'none';
  }, 1000);
}
