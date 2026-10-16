/** OpenAI-compatible servers Folio can be pointed at in one click (FR-AIF-12). */
export const AI_PROVIDERS = ['openai', 'ollama', 'lmstudio', 'llamacpp', 'custom'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export interface AiPreset {
  id: AiProviderId;
  /** Base URL the preset fills in; `null` for Custom (the user types it). */
  baseUrl: string | null;
  /** Runs on this computer: no API key needed, longer timeout. */
  local: boolean;
  /** Product name used in messages ("Ollama is not answering…"); empty for Custom. */
  name: string;
}

export const AI_PRESETS: Record<AiProviderId, AiPreset> = {
  openai: { id: 'openai', baseUrl: 'https://api.openai.com/v1', local: false, name: 'OpenAI' },
  ollama: { id: 'ollama', baseUrl: 'http://localhost:11434/v1', local: true, name: 'Ollama' },
  lmstudio: { id: 'lmstudio', baseUrl: 'http://localhost:1234/v1', local: true, name: 'LM Studio' },
  llamacpp: { id: 'llamacpp', baseUrl: 'http://localhost:8080/v1', local: true, name: 'llama.cpp' },
  custom: { id: 'custom', baseUrl: null, local: false, name: '' },
};

/** Remote endpoints answer within this time; a model running on the CPU of this computer gets longer. */
export const AI_TIMEOUT_MS = 60_000;
export const AI_LOCAL_TIMEOUT_MS = 180_000;

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/**
 * The base URL without trailing slashes and without an endpoint path pasted by mistake: providers show
 * `https://host/v1/chat/completions` as an example, but Folio adds `/chat/completions` and `/models` itself.
 */
export const normalizeBaseUrl = (url: string): string =>
  url.trim().replace(/\/+$/, '').replace(/\/(?:chat\/completions|completions|models)$/, '').replace(/\/+$/, '');

/** True for http(s) URLs whose host is this computer (`localhost`, `127.0.0.1`, `[::1]`). */
export function isLoopbackUrl(url: string): boolean {
  const u = parse(url);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false;
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
}

/**
 * Whether Folio may send AI requests to `url`: https anywhere, plain http only to this computer,
 * never credentials in the URL. Mirrors `origin_of` in the desktop HTTP proxy.
 */
export function aiEndpointProblem(url: string): 'invalid' | 'insecure' | 'credentials' | null {
  const u = parse(url);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return 'invalid';
  if (u.username || u.password) return 'credentials';
  if (u.protocol === 'http:' && !isLoopbackUrl(url)) return 'insecure';
  return null;
}

export const aiTimeoutFor = (url: string): number =>
  isLoopbackUrl(url) ? AI_LOCAL_TIMEOUT_MS : AI_TIMEOUT_MS;

/** "localhost:11434" — how the server is named in messages. */
export function endpointHost(url: string): string {
  return parse(url)?.host ?? url;
}

/** The preset whose base URL matches `url` (trailing slashes ignored), else Custom. */
export function presetForUrl(url: string): AiProviderId {
  const norm = url.trim().replace(/\/+$/, '');
  return AI_PROVIDERS.find((id) => AI_PRESETS[id].baseUrl === norm) ?? 'custom';
}
