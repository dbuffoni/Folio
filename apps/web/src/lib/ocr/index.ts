// Text recognition in the browser and in the Tauri webview: tesseract.js with same-origin files only.
import { TesseractOcrEngine } from '@folio/ocr-tesseract';
import type { ImageCodec, OcrEngine } from '@folio/ports';

/** idb-keyval's default store, which is where tesseract.js reads language data from in the browser. */
const DB = 'keyval-store';
const STORE = 'keyval';
function putIdb(key: string, value: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // The database exists without the store (created by something else): recreate it with the store.
        const version = db.version + 1;
        db.close();
        const again = indexedDB.open(DB, version);
        again.onupgradeneeded = () => again.result.createObjectStore(STORE);
        again.onerror = () => reject(again.error);
        again.onsuccess = () => {
          const tx = again.result.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(value, key);
          tx.oncomplete = () => (again.result.close(), resolve());
          tx.onerror = () => reject(tx.error);
        };
        return;
      }
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => (db.close(), resolve());
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** Files are served next to the app (`ocr/…`): bundled English and Italian, the worker and the cores. */
export function createBrowserOcr(images: ImageCodec, languageData: (code: string) => Promise<Uint8Array>): OcrEngine {
  const base = new URL('.', document.baseURI).href;
  return new TesseractOcrEngine({
    languageData,
    encode: (img) => images.encode(img, 'png'),
    workerPath: `${base}ocr/worker.min.js`,
    corePath: `${base}ocr/core`,
    // Staged where the worker looks first, so it never needs a URL for the data.
    stageLanguage: (code, data) => putIdb(`./${code}.traineddata`, data),
  });
}

/** Data of a language that ships with the app: same-origin, gzip as served. */
export async function loadBundledLanguage(code: string): Promise<Uint8Array> {
  const res = await fetch(new URL(`ocr/lang/${code}.traineddata.gz`, document.baseURI));
  if (!res.ok) throw new Error(`OCR language ${code}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
