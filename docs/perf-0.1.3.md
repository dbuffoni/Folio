# Performance pass (release 0.1.3)

Measured with `tests/perf/ui/run-ui.mjs` (new): Playwright Chromium 1360×860 against the production build, no GPU
(headless software rendering), so absolute numbers only compare builds with each other. Run:

```sh
pnpm build && (cd apps/web && pnpm preview --port 4173 &)
npx tsx tests/perf/scroll/make-doc.mts fixtures/generated/perf-300.pdf   # optional, 300 pages
cd apps/web && cp ../../tests/perf/ui/run-ui.mjs _rui.mjs && node _rui.mjs http://127.0.0.1:4173 ui-perf.json; rm _rui.mjs
```

Each scenario reports wall time, long-task time over 50 ms, animation frames over 50 ms and the number of model-change
notifications (`bumps`; each one re-evaluates every template that reads a model).

| Scenario | Result |
| --- | --- |
| Start-up to first screen | 146 ms, JS heap 10 MB |
| Open a 3-page file to first rendered page | 131 ms (25 pages: 148 ms; 300 pages: 257 ms, heap 21 MB) |
| 80 pointer moves over the toolbar / over a page | 0 notifications, 0 long tasks, 0 slow frames |
| Switch through all five modes | 199 ms, 7 notifications |
| Open Properties, type 40 characters in a field | 82 ms, 4 notifications (typing is local to the field) |
| Open and close Settings 5 times | 215 ms, 10 notifications |
| 10 zoom steps | 49 ms |
| Scroll 25 pages / 300 pages with the wheel (60 steps) | 0 long tasks, 0 frames over 50 ms |
| Organise mode with 300 thumbnails | 97 ms, heap unchanged at 21 MB |

Findings and decisions

- No interaction in the main flows blocks the main thread; hover and typing cause no model-wide re-evaluation, so no
  reactive-work change was needed. A counter (`__folioPerf.bumps()`) was added to the opt-in profiler to keep checking this.
- The candidates "Lower resolution while scrolling" and "Measure start-up and scrolling" are not needed as separate work:
  scrolling shows no slow frames in this setup and start-up is measured by the new script. Reopen them if WebKitGTK on a real
  desktop session (see `tests/perf/scroll/README.md`) shows slow frames.
- Before/after: nothing was changed for speed in this release, so "after" equals "before"; the table above is the baseline
  for later releases. The WebKitGTK findings from the earlier perf analysis could not be re-run here (no desktop session).
