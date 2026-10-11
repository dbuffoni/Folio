// Walking-skeleton shell used until the real UI is built (phase P8). It proves the IPC surface:
// launch arguments, scoped binary file reads and atomic writes. Results are exposed on
// `window.__folioSmoke` for the AppImage smoke test.
(async () => {
  const status = document.getElementById('status');
  const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!invoke) {
    status.textContent = 'Not running inside the desktop shell.';
    return;
  }
  const result = { ready: false };
  try {
    result.info = await invoke('app_info');
    result.secretBackend = await invoke('secret_backend');
    const pending = await invoke('take_pending_open_paths');
    result.opened = pending.map((p) => p.name);
    if (pending.length) {
      const file = pending[0];
      const bytes = new Uint8Array(await invoke('read_file', { path: file.path }));
      result.bytes = bytes.length;
      result.isPdf = String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
      document.title = `${file.name} — Folio`;
      await window.__TAURI_INTERNALS__.invoke('plugin:window|set_title', { label: 'main', value: document.title });
      status.textContent = `${file.name} · ${bytes.length} bytes`;
    } else {
      status.textContent = `Folio ${result.info.version} is ready.`;
    }
    result.ready = true;
  } catch (e) {
    result.error = String((e && e.message) || e);
    status.textContent = result.error;
  }
  window.__folioSmoke = result;
})();
