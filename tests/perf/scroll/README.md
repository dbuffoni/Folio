# Scroll profiler (Chromium vs WebKitGTK)

Measures PDF scrolling in the real web build, in Chromium and in WebKitGTK (the engine Tauri uses on Linux).
The profiler (`apps/web/src/lib/perf.ts`) is inert unless the page is opened with `?perf` or
`localStorage['folio.perf'] = '1'`. It records nothing off the device: `window.__folioPerf.run(name)` returns
a report, and `window.__folioPerf.download()` saves all reports as `folio-perf.json`.

Scenarios: `idle` (page at rest), `steady` (2500 px/s for 6 s), `drag` (25000 px/s for 3 s, like dragging the
scrollbar). Each report has frame-time percentiles (gaps between animation frames), the number of frames
over 33/50/100 ms, time blocked beyond 50 ms frames, `PdfDocument.render` latency, and the time the render
queue took to settle. WebKit has no `longtask` entries, so blocking is derived from frame gaps.

## Run it

```sh
pnpm --filter ./apps/web build
npx tsx tests/perf/scroll/make-doc.mts apps/web/build/perf-300.pdf      # 300-page document
(cd apps/web/build && python3 -m http.server 4173 --bind 127.0.0.1) &

# Chromium (from apps/web so @playwright/test resolves)
cd apps/web && cp ../../tests/perf/scroll/run-chromium.mjs _rc.mjs && \
  xvfb-run -a node _rc.mjs http://127.0.0.1:4173 /perf-300.pdf chromium.json; rm _rc.mjs

# WebKitGTK (Ubuntu 24.04: apt install libwebkit2gtk-4.1-0 gir1.2-webkit2-4.1 python3-gi gir1.2-gtk-3.0)
WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 \
  xvfb-run -a -s "-screen 0 1360x900x24" /usr/bin/python3.12 tests/perf/scroll/run-webkitgtk.py \
  http://127.0.0.1:4173 /perf-300.pdf webkitgtk.json
```

Each run reloads the page, because the render cache would make repeated passes over the same pages free; three runs per scenario.

Without a GPU (Xvfb, cloud) absolute numbers only compare engines with each other. For real numbers run the same
`run-webkitgtk.py` on a desktop session (drop `xvfb-run`), or open the AppImage's web view with the profiler enabled
and call `__folioPerf.run('steady')` then `__folioPerf.download()` from the inspector console.
