import { AiError, NetworkError, isFolioError, toBase64 } from '@folio/core';
import type { AiProvider, FormAnalysisRequest, FormAnalysisResult, HttpClient, HttpResponse, SecretStore } from '@folio/ports';
import { SYSTEM_PROMPT, buildPayload, estimateTokens } from './prompt.ts';
import { OUTPUT_JSON_SCHEMA, validateOutput } from './schema.ts';

export const OPENAI_KEY_SECRET = 'folio.openai-key';

export interface OpenAiConfig {
  baseUrl: string;
  model: string;
}
export interface OpenAiDeps {
  http: HttpClient;
  secrets: SecretStore;
  config: () => OpenAiConfig;
  /** Injectable for tests; real code waits. */
  sleep?: (ms: number) => Promise<void>;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

/**
 * OpenAI-compatible provider (FR-AIF-02). The only module that knows OpenAI request shapes.
 * The API key travels as a `SecretRef`: on desktop the Rust HTTP proxy injects it, so the key never
 * reaches webview JavaScript.
 */
export class OpenAiProvider implements AiProvider {
  constructor(private readonly deps: OpenAiDeps) {}

  async isConfigured(): Promise<boolean> {
    const { baseUrl, model } = this.deps.config();
    return !!baseUrl && !!model && !!(await this.deps.secrets.get(OPENAI_KEY_SECRET));
  }
  estimateTokens(req: FormAnalysisRequest): number {
    return estimateTokens(req);
  }

  private async call(path: string, method: 'GET' | 'POST', body: unknown, signal?: AbortSignal): Promise<HttpResponse> {
    const { baseUrl } = this.deps.config();
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last: HttpResponse | undefined;
    // Two retries on 429/5xx with exponential back-off (SPEC §10.3 step 3).
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      let res: HttpResponse;
      try {
        res = await this.deps.http.request({
          url: `${trimSlash(baseUrl)}${path}`,
          method,
          headers: { 'content-type': 'application/json' },
          secretHeaders: { authorization: { secret: OPENAI_KEY_SECRET, format: 'Bearer {secret}' } },
          body: body === undefined ? undefined : JSON.stringify(body),
          timeoutMs: 60_000,
          signal,
        });
      } catch (e) {
        if (isFolioError(e)) throw e;
        throw new NetworkError(String(e), e);
      }
      if (res.status === 401 || res.status === 403) throw new AiError('unauthorized', `HTTP ${res.status}`);
      if (res.status === 429 || res.status >= 500) {
        last = res;
        continue;
      }
      if (res.status >= 400) throw new AiError('server', `HTTP ${res.status}: ${res.body.slice(0, 300)}`);
      return res;
    }
    throw new AiError(last?.status === 429 ? 'rateLimited' : 'server', `HTTP ${last?.status}`);
  }

  private body(req: FormAnalysisRequest): Record<string, unknown> {
    const text = JSON.stringify(buildPayload(req));
    const content: unknown[] = [{ type: 'text', text }];
    for (const img of req.images ?? []) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${toBase64(img.jpeg)}`, detail: 'high' } });
    return {
      model: this.deps.config().model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: req.images?.length ? content : text },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'form_mapping_v1', strict: true, schema: OUTPUT_JSON_SCHEMA } },
    };
  }

  async analyzeForm(req: FormAnalysisRequest, signal: AbortSignal): Promise<FormAnalysisResult> {
    if (!(await this.isConfigured())) throw new AiError('notConfigured');
    // Malformed output is retried once, then reported so the caller can fall back to the local mapper.
    let detail = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.call('/chat/completions', 'POST', this.body(req), signal);
      try {
        const json = JSON.parse(res.body) as { choices?: Array<{ message?: { content?: string; refusal?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
        const message = json.choices?.[0]?.message;
        if (message?.refusal) throw new AiError('blocked', 'The model declined the request');
        const { result } = validateOutput(JSON.parse(message?.content ?? ''), req);
        return { ...result, model: json.model ?? this.deps.config().model, usage: json.usage ? { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 } : undefined };
      } catch (e) {
        if (e instanceof AiError) throw e;
        detail = String(e).slice(0, 200);
      }
    }
    throw new AiError('malformed', detail);
  }

  /** Model ids offered by the endpoint (`GET /models`), for the settings list. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.call('/models', 'GET', undefined, signal);
    try {
      const json = JSON.parse(res.body) as { data?: Array<{ id?: unknown }> };
      return (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string').sort();
    } catch {
      throw new AiError('malformed', 'Unexpected /models response');
    }
  }
  /** "Test connection" button: ok, or the reason as an AiError kind / network. */
  async testConnection(signal?: AbortSignal): Promise<{ ok: true; models: number } | { ok: false; reason: string }> {
    if (!(await this.isConfigured())) return { ok: false, reason: 'notConfigured' };
    try {
      return { ok: true, models: (await this.listModels(signal)).length };
    } catch (e) {
      return { ok: false, reason: e instanceof AiError ? e.kind : isFolioError(e) ? e.code : 'unknown' };
    }
  }
}
