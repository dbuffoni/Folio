import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// One static SPA bundle for both shells (SPEC §8.1): the website and the Tauri webview load the same files.
export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      adapter: adapter({ fallback: 'index.html' }),
      // Relative asset paths so the bundle works from any base URL and from tauri://localhost.
      paths: { relative: true },
    }),
  ],
  // The version shown in About comes from package.json, which tools/set-version.ts keeps equal to the tag.
  define: { __APP_VERSION__: JSON.stringify(version) },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm', '@embedpdf/pdfium'] },
  server: { port: 5173, strictPort: true, fs: { allow: ['../..'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
