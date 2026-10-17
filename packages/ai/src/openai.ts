import {
  AiError,
  NetworkError,
  aiEndpointProblem,
  aiTimeoutFor,
  isFolioError,
  isLoopbackUrl,
  normalizeBaseUrl,
  toBase64,
} from '@folio/core';
import type {
  AiCapabilities,
  AiProvider,
  FormAnalysisRequest,
  FormAnalysisResult,
  HttpClient,
  HttpResponse,
  PageTranscription,
  PageTranscriptionRequest,
  SecretStore,
  TableExtraction,
  StructuredOutput,
} from '@folio/ports';
import { redactImages, type AiExchangeLog } from './debug-log.ts';
import { SYSTEM_PROMPT, TABLE_PROMPT, TRANSCRIBE_PROMPT, buildPayload, estimateTokens } from './prompt.ts';
import { OUTPUT_JSON_SCHEMA, TABLE_JSON_SCHEMA, TRANSCRIPTION_JSON_SCHEMA, validateOutput, validateTable, validateTranscription } from './schema.ts';

export const OPENAI_KEY_SECRET = 'folio.openai-key';

export interface OpenAiConfig {
  baseUrl: string;
  model: string;
  /** How to ask for JSON, from the capability check; json_schema when unknown. */
  structured?: StructuredOutput;
  /** Overrides the default timeout (60 s, 180 s for a server on this computer). */
  timeoutMs?: number;
}
export interface OpenAiDeps {
  http: HttpClient;
  secrets: SecretStore;
  config: () => OpenAiConfig;
  /** Injectable for tests; real code waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Remembers each request and answer of this session for the debug window (memory only). */
  log?: AiExchangeLog;
}

export type ConnectionTest =
  { ok: true; models: string[] } | { ok: false; reason: string; host: string; local: boolean };

const trimSlash = normalizeBaseUrl;

/** A plain 8×8 red PNG: the vision probe asks the model which colour it is (FR-AIF-13). */
export const PROBE_IMAGE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR4AYXBAQEAIAyAMCTD+yezizY427kzj4UECRIkSJAg4QMXQgITwFKvhwAAAABJRU5ErkJggg==';
const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
} as const;

/** System prompt suffix for models without strict schemas: the schema travels as text instead. */
export const JSON_MODE_SUFFIX = ' Answer with one JSON object only, no prose, matching this JSON Schema: ';

/**
 * OpenAI-compatible provider (FR-AIF-02, FR-AIF-12). The only module that knows OpenAI request shapes.
 * The API key travels as a `SecretRef`: on desktop the Rust HTTP proxy injects it, so the key never
 * reaches webview JavaScript. A server on this computer (Ollama, LM Studio, llama.cpp) needs no key.
 */
export class OpenAiProvider implements AiProvider {
  constructor(private readonly deps: OpenAiDeps) {}

  private async hasKey(): Promise<boolean> {
    // The desktop keyring answers an empty string: the key exists but is never handed back.
    return (await this.deps.secrets.get(OPENAI_KEY_SECRET)) !== null;
  }
  async isConfigured(): Promise<boolean> {
    const { baseUrl, model } = this.deps.config();
    if (!baseUrl || !model || aiEndpointProblem(baseUrl)) return false;
    return isLoopbackUrl(baseUrl) || (await this.hasKey());
  }
  estimateTokens(req: FormAnalysisRequest): number {
    return estimateTokens(req);
  }

  /**
   * One request. Authentication, rate limits and network failures are errors; any other status is
   * returned so callers can tell "the model can't do this" (400, 404, 500…) from "no connection".
   */
  private async exchange(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    const { baseUrl, timeoutMs } = this.deps.config();
    if (aiEndpointProblem(baseUrl)) throw new AiError('insecure', baseUrl);
    // No key stored (a local server): send no Authorization header at all.
    const auth = (await this.hasKey())
      ? { authorization: { secret: OPENAI_KEY_SECRET, format: 'Bearer {secret}' } }
      : undefined;
    let res: HttpResponse;
    try {
      res = await this.deps.http.request({
        url: `${trimSlash(baseUrl)}${path}`,
        method,
        headers: { 'content-type': 'application/json' },
        ...(auth ? { secretHeaders: auth } : {}),
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: timeoutMs ?? aiTimeoutFor(baseUrl),
        signal,
      });
    } catch (e) {
      if (isFolioError(e)) throw e;
      throw new NetworkError(String(e), e);
    }
    if (res.status === 401 || res.status === 403) throw new AiError('unauthorized', `HTTP ${res.status}`);
    return res;
  }

  /** `exchange`, noting request and answer in the session log when there is one. */
  private async logged(kind: string, path: string, method: 'GET' | 'POST', body: unknown, signal?: AbortSignal): Promise<HttpResponse> {
    const log = this.deps.log;
    if (!log) return this.exchange(path, method, body, signal);
    const { baseUrl, model } = this.deps.config();
    const started = Date.now();
    const at = new Date(started).toISOString();
    const note = (status: number | null, response: string): void =>
      log.record({ at, kind, method, url: `${trimSlash(baseUrl)}${path}`, model, request: redactImages(body), status, response, durationMs: Date.now() - started });
    try {
      const res = await this.exchange(path, method, body, signal);
      note(res.status, res.body);
      return res;
    } catch (e) {
      note(null, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      throw e;
    }
  }

  private async call(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    signal?: AbortSignal,
    kind = 'request',
  ): Promise<HttpResponse> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last: HttpResponse | undefined;
    // Two retries on 429/5xx with exponential back-off (SPEC §10.3 step 3).
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      const res = await this.logged(kind, path, method, body, signal);
      if (res.status === 429 || res.status >= 500) {
        last = res;
        continue;
      }
      if (res.status >= 400) throw new AiError('server', `HTTP ${res.status}: ${res.body.slice(0, 300)}`);
      return res;
    }
    throw new AiError(last?.status === 429 ? 'rateLimited' : 'server', `HTTP ${last?.status}`);
  }

  /** `response_format` and system prompt for the structured-output level of the model. */
  private jsonRequest(name: string, schema: object): { system: string; responseFormat?: unknown } {
    const structured = this.deps.config().structured ?? 'json_schema';
    if (structured === 'none') throw new AiError('unsupported', 'The model returns no JSON');
    if (structured === 'json_object')
      return { system: JSON_MODE_SUFFIX + JSON.stringify(schema), responseFormat: { type: 'json_object' } };
    return {
      system: '',
      responseFormat: { type: 'json_schema', json_schema: { name, strict: true, schema } },
    };
  }

  private body(req: FormAnalysisRequest): Record<string, unknown> {
    const text = JSON.stringify(buildPayload(req));
    const content: unknown[] = [{ type: 'text', text }];
    for (const img of req.images ?? [])
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${toBase64(img.jpeg)}`, detail: 'high' },
      });
    const json = this.jsonRequest('form_mapping_v1', OUTPUT_JSON_SCHEMA);
    return {
      model: this.deps.config().model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + json.system },
        { role: 'user', content: req.images?.length ? content : text },
      ],
      response_format: json.responseFormat,
    };
  }

  async analyzeForm(req: FormAnalysisRequest, signal: AbortSignal): Promise<FormAnalysisResult> {
    if (!(await this.isConfigured())) throw new AiError('notConfigured');
    // Malformed output is retried once, then reported so the caller can fall back to the local mapper.
    let detail = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.call('/chat/completions', 'POST', this.body(req), signal, 'Smart Fill');
      try {
        const json = JSON.parse(res.body) as {
          choices?: Array<{ message?: { content?: string; refusal?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          model?: string;
        };
        const message = json.choices?.[0]?.message;
        if (message?.refusal) throw new AiError('blocked', 'The model declined the request');
        const { result } = validateOutput(JSON.parse(message?.content ?? ''), req);
        return {
          ...result,
          model: json.model ?? this.deps.config().model,
          usage: json.usage
            ? { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 }
            : undefined,
        };
      } catch (e) {
        if (e instanceof AiError) throw e;
        detail = String(e).slice(0, 200);
      }
    }
    throw new AiError('malformed', detail);
  }

  async extractTable(req: PageTranscriptionRequest, signal: AbortSignal): Promise<TableExtraction> {
    if (!(await this.isConfigured())) throw new AiError('notConfigured');
    const json = this.jsonRequest('table_v1', TABLE_JSON_SCHEMA);
    const body = {
      model: this.deps.config().model,
      temperature: 0,
      messages: [
        { role: 'system', content: TABLE_PROMPT + json.system },
        { role: 'user', content: [{ type: 'text', text: `The image is ${req.width}×${req.height} pixels.` }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${toBase64(req.jpeg)}`, detail: 'high' } }] },
      ],
      response_format: json.responseFormat,
    };
    let detail = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.call('/chat/completions', 'POST', body, signal, 'Table');
      try {
        const parsed = JSON.parse(res.body) as { choices?: Array<{ message?: { content?: string; refusal?: string } }>; model?: string };
        const message = parsed.choices?.[0]?.message;
        if (message?.refusal) throw new AiError('blocked', 'The model declined the request');
        return { rows: validateTable(JSON.parse(message?.content ?? '')), model: parsed.model ?? this.deps.config().model };
      } catch (e) {
        if (e instanceof AiError) throw e;
        detail = String(e).slice(0, 200);
      }
    }
    throw new AiError('malformed', detail);
  }

  async recognizePage(req: PageTranscriptionRequest, signal: AbortSignal): Promise<PageTranscription> {
    if (!(await this.isConfigured())) throw new AiError('notConfigured');
    const json = this.jsonRequest('page_transcription_v1', TRANSCRIPTION_JSON_SCHEMA);
    const body = {
      model: this.deps.config().model,
      temperature: 0,
      messages: [
        { role: 'system', content: TRANSCRIBE_PROMPT + json.system },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Page ${req.page + 1}, ${req.width}×${req.height} pixels.` },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${toBase64(req.jpeg)}`, detail: 'high' } },
          ],
        },
      ],
      response_format: json.responseFormat,
    };
    let detail = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.call('/chat/completions', 'POST', body, signal, 'Scan reading');
      try {
        const parsed = JSON.parse(res.body) as { choices?: Array<{ message?: { content?: string; refusal?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
        const message = parsed.choices?.[0]?.message;
        if (message?.refusal) throw new AiError('blocked', 'The model declined the request');
        const { lines } = validateTranscription(JSON.parse(message?.content ?? ''));
        return { lines, model: parsed.model ?? this.deps.config().model, usage: parsed.usage ? { inputTokens: parsed.usage.prompt_tokens ?? 0, outputTokens: parsed.usage.completion_tokens ?? 0 } : undefined };
      } catch (e) {
        if (e instanceof AiError) throw e;
        detail = String(e).slice(0, 200);
      }
    }
    throw new AiError('malformed', detail);
  }

  /** Model ids offered by the endpoint (`GET /models`), for the settings list. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.call('/models', 'GET', undefined, signal, 'Model list');
    try {
      const json = JSON.parse(res.body) as { data?: Array<{ id?: unknown }> };
      return (json.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string')
        .sort();
    } catch {
      throw new AiError('malformed', 'Unexpected /models response');
    }
  }
  /** "Test connection": the model list, or why there is none (the reason names the host for local servers). */
  async testConnection(signal?: AbortSignal): Promise<ConnectionTest> {
    const { baseUrl } = this.deps.config();
    let host = baseUrl;
    try {
      host = new URL(baseUrl).host;
    } catch {
      /* reported as notConfigured below */
    }
    const local = isLoopbackUrl(baseUrl);
    const problem = aiEndpointProblem(baseUrl);
    if (problem)
      return { ok: false, reason: problem === 'insecure' ? 'insecure' : 'notConfigured', host, local };
    if (!(await this.isConfigured())) return { ok: false, reason: 'notConfigured', host, local };
    try {
      return { ok: true, models: await this.listModels(signal) };
    } catch (e) {
      return {
        ok: false,
        reason: e instanceof AiError ? e.kind : isFolioError(e) ? e.code : 'unknown',
        host,
        local,
      };
    }
  }

  /** Content of the first choice of a 2xx answer, or null when the request was refused. */
  private async probe(body: Record<string, unknown>, signal?: AbortSignal): Promise<string | null> {
    const res = await this.exchange(
      '/chat/completions',
      'POST',
      { model: this.deps.config().model, temperature: 0, max_tokens: 20, ...body },
      signal,
    );
    if (res.status === 429) throw new AiError('rateLimited', 'HTTP 429');
    if (res.status >= 300) return null;
    try {
      const json = JSON.parse(res.body) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = json.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content : null;
    } catch {
      return null;
    }
  }
  private static isOk(content: string | null): boolean {
    if (content === null) return false;
    try {
      const v = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as unknown;
      return typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';
    } catch {
      return false;
    }
  }

  /**
   * FR-AIF-13: a tiny schema request, then (if refused) plain JSON mode, then an 8×8 red image with a
   * one-word question. A refusal (4xx/5xx) or a wrong answer means "not supported"; 401, 429 and
   * network failures propagate as connection errors.
   */
  async probeCapabilities(signal?: AbortSignal): Promise<AiCapabilities> {
    if (!(await this.isConfigured())) throw new AiError('notConfigured');
    const ask = { role: 'user', content: 'Reply with the JSON object {"ok": true}.' };
    let structured: StructuredOutput = 'none';
    if (
      OpenAiProvider.isOk(
        await this.probe(
          {
            messages: [ask],
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'probe', strict: true, schema: PROBE_SCHEMA },
            },
          },
          signal,
        ),
      )
    )
      structured = 'json_schema';
    else if (
      OpenAiProvider.isOk(
        await this.probe({ messages: [ask], response_format: { type: 'json_object' } }, signal),
      )
    )
      structured = 'json_object';
    const answer = await this.probe(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What colour is this image? Answer with one word.' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_IMAGE_PNG}` } },
            ],
          },
        ],
      },
      signal,
    );
    return { structured, vision: answer !== null && /\bred\b|rosso|rouge|rojo/i.test(answer) };
  }
}
