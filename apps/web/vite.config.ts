import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

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
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm', '@embedpdf/pdfium'] },
  server: { port: 5173, strictPort: true, fs: { allow: ['../..'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
