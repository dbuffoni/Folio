// Opens the AppImage under Xvfb at several screen sizes and reports where the window lands (card 166).
// Usage: node apps/desktop/scripts/window-sizes.mjs <outdir> [WxH ...]   (Xvfb, dbus, tauri-driver, WebKitWebDriver needed)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const bundleDir = join(root, 'apps/desktop/src-tauri/target/release/bundle/appimage');
const appImage = process.env.FOLIO_APPIMAGE ?? readdirSync(bundleDir).map((f) => join(bundleDir, f)).find((f) => f.endsWith('.AppImage'));
const out = resolve(process.argv[2] ?? 'window-shots');
const screens = process.argv.slice(3).length ? process.argv.slice(3) : ['1366x768', '1920x1080', '1024x600', '1280x720'];
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv[2] === '--inner') {
  // Runs inside xvfb-run: one launch, report the window and take a screenshot.
  const [shot, savedSize] = process.argv.slice(3);
  const work = mkdtempSync(join(tmpdir(), 'folio-win-'));
  const extract = spawnSync(appImage, ['--appimage-extract'], { cwd: work, stdio: 'ignore' });
  const appRun = join(work, 'squashfs-root/AppRun');
  if (extract.status !== 0 || !existsSync(appRun)) throw new Error('cannot unpack the AppImage');
  const env = { ...process.env, WEBKIT_DISABLE_DMABUF_RENDERER: '1', WEBKIT_DISABLE_COMPOSITING_MODE: '1', XDG_DATA_HOME: process.env.FOLIO_DATA ?? join(work, 'data'), XDG_CONFIG_HOME: process.env.FOLIO_CONFIG ?? join(work, 'config') };
  const port = 4444 + Math.floor(Math.random() * 400);
  const driver = spawn('tauri-driver', ['--port', String(port), '--native-port', String(port + 1)], { env, stdio: 'ignore' });
  const wd = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    if (json.value && json.value.error) throw new Error(`${json.value.error}: ${json.value.message}`);
    return json.value;
  };
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await wd('GET', '/status');
        break;
      } catch {
        await sleep(200);
      }
    }
    const pdf = process.env.FOLIO_SMOKE_PDF;
    if (pdf && !existsSync(pdf)) throw new Error(`missing ${pdf}`);
    const { sessionId } = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: appRun, args: pdf ? [pdf] : [] } } } });
    for (let i = 0; i < 100; i++) {
      const s = await wd('POST', `/session/${sessionId}/execute/sync`, { script: 'return window.__folioSmoke || null', args: [] });
      if (s?.ready) break;
      await sleep(200);
    }
    await sleep(1500);
    if (savedSize) {
      // Resize like a user would, then close: the next launch must restore it (clamped).
      const [w, h] = savedSize.split('x').map(Number);
      await wd('POST', `/session/${sessionId}/window/rect`, { x: 0, y: 0, width: w, height: h });
      await sleep(800);
    }
    const rect = await wd('GET', `/session/${sessionId}/window/rect`);
    const inner = await wd('POST', `/session/${sessionId}/execute/sync`, {
      script: 'const sb = document.querySelector("#statusbar"); const r = sb ? sb.getBoundingClientRect() : null; return { w: innerWidth, h: innerHeight, statusBottom: r ? r.bottom : null, dpr: devicePixelRatio, screen: [screen.width, screen.height], avail: [screen.availWidth, screen.availHeight] };',
      args: [],
    });
    const png = await wd('GET', `/session/${sessionId}/screenshot`);
    if (shot) writeFileSync(shot, Buffer.from(png, 'base64'));
    console.log(JSON.stringify({ rect, inner }));
    // A person closes the window: the app saves its size and position on the way out.
    if (savedSize) {
      await wd('POST', `/session/${sessionId}/execute/sync`, { script: "window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }); return true;", args: [] }).catch(() => undefined);
      await sleep(1500);
    }
    await wd('DELETE', `/session/${sessionId}`).catch(() => undefined);
  } finally {
    driver.kill();
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  process.exit(0);
}

// What a person resizes is remembered: the same config directory across launches on different screens.
function launch(screen, shot, saved) {
  const [w, h] = screen.split('x').map(Number);
  const r = spawnSync('xvfb-run', ['-a', '-s', `-screen 0 ${w}x${h}x24`, 'dbus-run-session', '--', 'node', import.meta.filename, '--inner', shot, ...(saved ? [saved] : [])], { encoding: 'utf8', env: { ...process.env, FOLIO_APPIMAGE: appImage, FOLIO_SMOKE_PDF: process.env.FOLIO_SMOKE_PDF ?? resolve(root, 'fixtures/generated/text.pdf'), FOLIO_DATA: join(remembered, 'data'), FOLIO_CONFIG: join(remembered, 'config') } });
  const line = r.stdout.split('\n').find((l) => l.startsWith('{'));
  if (!line) throw new Error(`${screen}: no result ${r.stderr.slice(0, 300)}`);
  return { ...JSON.parse(line), w, h };
}
const remembered = mkdtempSync(join(tmpdir(), 'folio-remembered-'));
const report = (label, { rect, inner, w, h }) => {
  const fits = rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= w && rect.y + rect.height <= h && inner.statusBottom <= inner.h;
  console.log(`${fits ? 'PASS' : 'FAIL'}  ${label}: window ${rect.width}x${rect.height} at ${rect.x},${rect.y} on ${w}x${h}`);
  if (!fits) process.exitCode = 1;
  return fits;
};
{
  // 1. The user makes the window 1400x900 on a big screen; closing remembers it.
  report('first run on 1920x1080, resized to 1400x900', launch('1920x1080', join(out, 'window-remembered-1-resized-1920x1080.png'), '1400x900'));
  // 2. The next start on the same screen restores it.
  const again = launch('1920x1080', join(out, 'window-remembered-2-restored-1920x1080.png'));
  report('restart on 1920x1080 restores the remembered size', again);
  if (again.rect.width !== 1400 || again.rect.height !== 900) { console.log(`FAIL  expected 1400x900, got ${again.rect.width}x${again.rect.height}`); process.exitCode = 1; }
  // 3. The same saved size on a laptop screen is clamped to it.
  report('restart on 1366x768 clamps the remembered size', launch('1366x768', join(out, 'window-remembered-3-clamped-1366x768.png')));
}
rmSync(remembered, { recursive: true, force: true });

const rows = [];
for (const s of screens) {
  const [w, h] = s.split('x').map(Number);
  const r = spawnSync('xvfb-run', ['-a', '-s', `-screen 0 ${w}x${h}x24`, 'dbus-run-session', '--', 'node', import.meta.filename, '--inner', join(out, `window-${s}.png`)], { encoding: 'utf8', env: { ...process.env, FOLIO_APPIMAGE: appImage, FOLIO_SMOKE_PDF: process.env.FOLIO_SMOKE_PDF ?? resolve(root, 'fixtures/generated/text.pdf') } });
  const line = r.stdout.split('\n').find((l) => l.startsWith('{'));
  if (!line) {
    console.error(`${s}: no result\n${r.stdout}\n${r.stderr}`.slice(0, 600));
    process.exitCode = 1;
    continue;
  }
  const { rect, inner } = JSON.parse(line);
  const fits = rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= w && rect.y + rect.height <= h && inner.statusBottom !== null && inner.statusBottom <= inner.h;
  rows.push({ screen: s, window: `${rect.width}x${rect.height} at ${rect.x},${rect.y}`, content: `${inner.w}x${inner.h}`, statusBarBottom: inner.statusBottom, fits });
  console.log(`${fits ? 'PASS' : 'FAIL'}  screen ${s}: window ${rect.width}x${rect.height} at ${rect.x},${rect.y}; page area ${inner.w}x${inner.h}; status bar bottom ${inner.statusBottom}`);
  if (!fits) process.exitCode = 1;
}
writeFileSync(join(out, 'window-sizes.json'), JSON.stringify(rows, null, 1));
