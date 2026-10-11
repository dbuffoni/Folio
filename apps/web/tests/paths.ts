import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURE_DIR = resolve(ROOT, 'fixtures/generated');
export const fx = (name: string): string => resolve(FIXTURE_DIR, name);
