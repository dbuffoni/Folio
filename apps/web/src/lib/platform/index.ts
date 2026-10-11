import type { Platform } from '@folio/ports';

export const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Selects the adapters for the current shell (SPEC §8.2). The Tauri module is imported dynamically
 * so the website bundle never loads Tauri code.
 */
export async function createPlatform(version: string): Promise<Platform> {
  if (isTauri()) return (await import('./tauri.ts')).createTauriPlatform();
  return (await import('./web.ts')).createWebPlatform(version);
}
