import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url);
const conf = JSON.parse(readFileSync(new URL('apps/desktop/src-tauri/tauri.conf.json', root), 'utf8')) as {
  app: { windows: Array<{ width: number; height: number; minWidth: number; minHeight: number }> };
};
const rust = readFileSync(new URL('apps/desktop/src-tauri/src/lib.rs', root), 'utf8');

// The sizing itself is a pure function with unit tests in Rust (`cargo test`: fit_rect, fit_minimum); here the
// configuration it starts from is checked, and that the application calls it.
describe('first window of the desktop app @FR-APP-14', () => {
  const win = conf.app.windows[0]!;

  it('is wide enough for an A4 page at fit-width plus the side panes, and no wider than a 1366 px screen needs', () => {
    expect(win.width).toBeGreaterThanOrEqual(1024);
    expect(win.width).toBeLessThanOrEqual(1200);
  });

  it('is short enough for a 1366 × 768 laptop with a task bar (work area about 728 px)', () => {
    expect(win.height).toBeLessThanOrEqual(780);
    expect(win.minHeight).toBeLessThanOrEqual(560);
    expect(win.minWidth).toBeLessThanOrEqual(900);
  });

  it('is placed from the monitor work area after the saved size is restored', () => {
    expect(rust).toMatch(/skip_initial_state\("main"\)/);
    expect(rust.indexOf('restore_state')).toBeLessThan(rust.indexOf('fit_rect(current, work)'));
    expect(rust).toMatch(/monitor\.work_area\(\)/);
  });
});
