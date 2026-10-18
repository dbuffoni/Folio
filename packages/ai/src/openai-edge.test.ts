import { describe, expect, it } from 'vitest';
import { AiError, NetworkError } from '@folio/core';
import type { FormAnalysisRequest } from '@folio/ports';
import { FakeHttpClient, FakeSecretStore } from '@folio/testkit';
import { AiExchangeLog } from './debug-log.ts';
import { OPENAI_KEY_SECRET, OpenAiProvider } from './openai.ts';

const sig = () => new AbortController().signal;
const page = { page: 1, jpeg: new Uint8Array([1, 2, 3]), width: 100, height: 200 };
const chat = (content: unknown, extra: Record<string, unknown> = {}) =>
  FakeHttpClient.json(200, {
    model: 'm-x',
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
    ...extra,
  });
const kind = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof AiError ? `ai:${e.kind}` : ((e as { code?: string }).code ?? String(e));
  }
};
const setup = (opts: { key?: boolean; baseUrl?: string; log?: AiExchangeLog } = {}) => {
  const secrets = new FakeSecretStore();
  if (opts.key !== false) secrets.values.set(OPENAI_KEY_SECRET, 'sk-1');
  const http = new FakeHttpClient(secrets);
  const sleeps: number[] = [];
  const config: { baseUrl: string; model: string; structured?: 'json_schema' | 'json_object' | 'none' } = {
    baseUrl: opts.baseUrl ?? 'https://api.openai.com/v1',
    model: 'm',
  };
  const provider = new OpenAiProvider({
    http,
    secrets,
    config: () => config,
    sleep: async (ms) => void sleeps.push(ms),
    log: opts.log,
  });
  return { http, provider, config, sleeps };
};

describe('table extraction and page reading', () => {
  it('extractTable squares rows and reports the model @FR-OCR-10 @FR-AIF-13', async () => {
    const s = setup();
    s.http.enqueue(chat({ rows: [['a', 'b'], ['c'], ['', ''], [1, null]] }));
    const t = await s.provider.extractTable(page, sig());
    expect(t.rows).toEqual([
      ['a', 'b'],
      ['c', ''],
      ['1', ''],
    ]);
    expect(t.model).toBe('m-x');
    const body = JSON.parse(s.http.requests[0]!.body!) as { messages: Array<{ content: unknown }> };
    expect(JSON.stringify(body.messages[1])).toContain('100×200');
  });
  it('extractTable retries malformed output once, then reports malformed @FR-OCR-10', async () => {
    const s = setup();
    s.http.enqueue(chat('not json'), chat({ rows: [['x']] }));
    expect((await s.provider.extractTable(page, sig())).rows).toEqual([['x']]);
    s.http.enqueue(chat('nope'), chat({ wrong: 1 }));
    expect(await kind(s.provider.extractTable(page, sig()))).toBe('ai:malformed');
  });
  it('extractTable refusals, missing key and unsupported JSON are distinct errors @FR-OCR-10 @FR-AIF-13', async () => {
    const s = setup();
    s.http.enqueue(FakeHttpClient.json(200, { choices: [{ message: { refusal: 'no' } }] }));
    expect(await kind(s.provider.extractTable(page, sig()))).toBe('ai:blocked');
    s.config.structured = 'none';
    expect(await kind(s.provider.extractTable(page, sig()))).toBe('ai:unsupported');
    expect(await kind(setup({ key: false }).provider.extractTable(page, sig()))).toBe('ai:notConfigured');
  });
  it('extractTable in JSON mode sends the schema as text @FR-AIF-13', async () => {
    const s = setup();
    s.config.structured = 'json_object';
    s.http.enqueue(chat({ rows: [] }));
    await s.provider.extractTable(page, sig());
    const body = JSON.parse(s.http.requests[0]!.body!) as {
      response_format: unknown;
      messages: Array<{ content: string }>;
    };
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0]!.content).toContain('"rows"');
  });
  it('recognizePage returns lines with usage and drops unusable ones @FR-OCR-10', async () => {
    const s = setup();
    s.http.enqueue(
      chat(
        {
          lines: [
            { text: ' Hello   world ', bbox: [0.5, 0.2, 0.1, 0.1], confidence: 2 },
            { text: '  ', bbox: [0, 0, 1, 1], confidence: 1 },
            'junk',
          ],
        },
        { usage: { prompt_tokens: 7, completion_tokens: 3 } },
      ),
    );
    const r = await s.provider.recognizePage(page, sig());
    expect(r.lines).toEqual([{ text: 'Hello world', bbox: [0.1, 0.1, 0.5, 0.2], confidence: 1 }]);
    expect(r.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(JSON.stringify(JSON.parse(s.http.requests[0]!.body!).messages[1])).toContain('Page 2');
  });
  it('recognizePage without usage, malformed twice, refusal, unconfigured @FR-OCR-10', async () => {
    const s = setup();
    s.http.enqueue(chat({ lines: [] }, { model: undefined }));
    const r = await s.provider.recognizePage(page, sig());
    expect(r.usage).toBeUndefined();
    expect(r.model).toBe('m');
    s.http.enqueue(chat('x'), chat('y'));
    expect(await kind(s.provider.recognizePage(page, sig()))).toBe('ai:malformed');
    s.http.enqueue(FakeHttpClient.json(200, { choices: [{ message: { refusal: 'no' } }] }));
    expect(await kind(s.provider.recognizePage(page, sig()))).toBe('ai:blocked');
    s.http.enqueue(FakeHttpClient.json(200, { choices: [] }), chat({ lines: [] }));
    expect((await s.provider.recognizePage(page, sig())).lines).toEqual([]);
    expect(await kind(setup({ key: false }).provider.recognizePage(page, sig()))).toBe('ai:notConfigured');
  });
});

describe('connection, logging and probes edge cases', () => {
  it('records successful and failed exchanges in the session log, without image data @FR-AIF-02', async () => {
    const log = new AiExchangeLog();
    const s = setup({ log });
    s.http.enqueue(chat({ rows: [['a']] }), () => new NetworkError('boom'));
    await s.provider.extractTable(page, sig());
    expect(await kind(s.provider.listModels())).toBe('network');
    const [failed, ok] = log.list();
    expect(ok!.status).toBe(200);
    expect(JSON.stringify(ok!.request)).not.toContain('AQID');
    expect(failed!.status).toBeNull();
    expect(failed!.response).toContain('NetworkError');
  });
  it('a request without a stored key sends no Authorization header for a local server @FR-AIF-12', async () => {
    const s = setup({ key: false, baseUrl: 'http://localhost:11434/v1' });
    s.http.enqueue(FakeHttpClient.json(200, { data: [{ id: 'llama' }] }));
    expect(await s.provider.listModels()).toEqual(['llama']);
    expect(s.http.requests[0]!.resolvedHeaders.authorization).toBeUndefined();
  });
  it('a non-error exception from the transport becomes a network error @FR-AIF-12', async () => {
    const s = setup();
    s.http.fallback = () => {
      throw 'plain string';
    };
    expect(await kind(s.provider.listModels())).toBe('network');
  });
  it('listModels tolerates an answer without data and refuses a remote http endpoint @FR-AIF-02 @FR-AIF-12', async () => {
    const s = setup();
    s.http.enqueue(FakeHttpClient.json(200, {}));
    expect(await s.provider.listModels()).toEqual([]);
    const insecure = setup({ baseUrl: 'http://example.com/v1' });
    expect(await kind(insecure.provider.listModels())).toBe('ai:insecure');
  });
  it('testConnection names the reason for each configuration problem @FR-AIF-02 @FR-AIF-12', async () => {
    expect(await setup({ baseUrl: 'http://example.com/v1' }).provider.testConnection()).toMatchObject({
      ok: false,
      reason: 'insecure',
      host: 'example.com',
      local: false,
    });
    expect(await setup({ baseUrl: 'not a url' }).provider.testConnection()).toMatchObject({
      ok: false,
      reason: 'notConfigured',
      host: 'not a url',
    });
    expect(await setup({ key: false }).provider.testConnection()).toMatchObject({
      ok: false,
      reason: 'notConfigured',
      host: 'api.openai.com',
    });
    const local = setup({ baseUrl: 'http://127.0.0.1:1234/v1' });
    local.http.enqueue(() => new NetworkError('refused'));
    expect(await local.provider.testConnection()).toMatchObject({
      ok: false,
      reason: 'network',
      local: true,
    });
    const odd = setup();
    odd.http.fallback = () => {
      throw new TypeError('weird');
    };
    // Non-Folio transport errors are wrapped as network errors.
    expect(await odd.provider.testConnection()).toMatchObject({ ok: false, reason: 'network' });
    const bad = setup();
    bad.http.enqueue({ status: 200, headers: {}, body: '<html>' });
    expect(await bad.provider.testConnection()).toMatchObject({ ok: false, reason: 'malformed' });
  });
  it('probes treat odd answers as not supported @FR-AIF-13', async () => {
    const s = setup();
    // 200 with non-JSON body, 200 with non-string content, then fenced JSON in json mode, vision text with no red.
    s.http.enqueue({ status: 200, headers: {}, body: '<html>' }, chat({ ok: 1 }, {}), chat('x'));
    expect(await s.provider.probeCapabilities()).toEqual({ structured: 'none', vision: false });
    const t = setup();
    t.http.enqueue(chat('```json\n{"ok": true}\n```'), chat('Rouge'));
    expect(await t.provider.probeCapabilities()).toEqual({ structured: 'json_schema', vision: true });
    const u = setup();
    u.http.enqueue(
      FakeHttpClient.json(404, {}),
      chat('{"ok": false}'),
      FakeHttpClient.json(200, { choices: [{ message: { content: 5 } }] }),
    );
    expect(await u.provider.probeCapabilities()).toEqual({ structured: 'json_object', vision: false });
  });
  it('analyzeForm treats a body that is not JSON at all as malformed after one retry @FR-AIF-03', async () => {
    const s = setup();
    s.http.enqueue(
      { status: 200, headers: {}, body: 'oops' },
      { status: 200, headers: {}, body: 'oops again' },
    );
    const req = { mode: 'mapping_only', pages: [], candidates: [], profileKeys: [] } as FormAnalysisRequest;
    expect(await kind(s.provider.analyzeForm(req, sig()))).toBe('ai:malformed');
    expect(s.http.requests.length).toBe(2);
  });
});
