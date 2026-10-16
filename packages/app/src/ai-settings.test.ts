import { describe, expect, it } from 'vitest';
import { NetworkError, aiCapabilities } from '@folio/core';
import type { HttpRequest, HttpResponse } from '@folio/ports';
import { FakeAiProvider, OPENAI_KEY_SECRET } from '@folio/ai';
import { FakeHttpClient, flatFormDoc } from '@folio/testkit';
import { AiSettingsModel } from './ai-settings.ts';
import { createTestApp } from './testing.ts';

/** A simulated OpenAI-compatible server: `/models`, the probes and Smart Fill requests. */
function fakeServer(
  opts: { vision?: boolean; schema?: boolean; jsonMode?: boolean; models?: string[] } = {},
) {
  const { vision = true, schema = true, jsonMode = true, models = ['llama3.2', 'llava'] } = opts;
  const answer = (content: unknown): HttpResponse =>
    FakeHttpClient.json(200, {
      model: 'local',
      choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
    });
  return (req: HttpRequest): HttpResponse => {
    if (req.url.endsWith('/models')) return FakeHttpClient.json(200, { data: models.map((id) => ({ id })) });
    const body = JSON.parse(req.body!) as {
      response_format?: { type: string; json_schema?: { name: string } };
      messages: Array<{ content: unknown }>;
    };
    const text = JSON.stringify(body.messages);
    if (text.includes('What colour is this image'))
      return vision ? answer('Red.') : FakeHttpClient.json(400, { error: 'image input not supported' });
    if (body.response_format?.type === 'json_schema' && !schema)
      return FakeHttpClient.json(400, { error: 'json_schema not supported' });
    if (body.response_format?.type === 'json_object' && !jsonMode)
      return FakeHttpClient.json(400, { error: 'json mode not supported' });
    if (text.includes('Reply with the JSON object')) return answer({ ok: true });
    // Smart Fill: map every candidate whose label names a profile key.
    const payload = JSON.parse((body.messages[1]!.content as string) ?? '{}') as {
      candidates: Array<{ id: string; label?: string; type: string }>;
      keys: Array<{ key: string; label: string }>;
    };
    return answer({
      fields: payload.candidates.map((c) => ({
        ref: c.id,
        label: c.label ?? '',
        fieldType: c.type,
        profileKey: payload.keys.find((k) => k.label === c.label)?.key ?? null,
        transform: 'none',
        choiceValue: null,
        confidence: 0.95,
      })),
      newAreas: [],
    });
  };
}

describe('Local AI server presets @FR-AIF-12', () => {
  it('Ollama on this computer: one click, no key, Test connection lists models and Smart Fill returns suggestions @FR-AIF-12', async () => {
    const t = await createTestApp();
    const model = new AiSettingsModel(t.app);
    // Opening the settings sends nothing.
    expect(model.provider).toBe('openai');
    expect(model.local).toBe(false);
    expect(model.keyRequired).toBe(true);
    expect(t.http.requests).toEqual([]);

    expect(await model.selectProvider('ollama')).toBe(true);
    expect(t.app.settings.ai).toMatchObject({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1' });
    expect(model.local).toBe(true);
    expect(model.keyRequired).toBe(false);
    expect(model.corsHint).toEqual({ key: 'settings.ai.cors.ollama' });
    // No automatic port scanning: choosing a preset contacts nobody.
    expect(t.http.requests).toEqual([]);

    t.http.fallback = fakeServer();
    expect(await model.test()).toBe(true);
    expect(model.models).toEqual(['llama3.2', 'llava']);
    expect(model.result).toEqual({ ok: true, message: { key: 'settings.ai.test.ok', params: { count: 2 } } });
    expect(
      t.http.requests.every(
        (r) =>
          r.url.startsWith('http://localhost:11434/v1/') &&
          r.resolvedHeaders.authorization === undefined &&
          r.timeoutMs === 180_000,
      ),
    ).toBe(true);
    expect(model.capabilities).toEqual({ vision: true, structured: 'json_schema', probed: true });

    await t.services.profiles.create('Me', ['identity']);
    const p = (await t.services.profiles.getDefault())!;
    await t.services.profiles.setField(p.id, {
      ...p.fields.find((f) => f.key === 'first_name')!,
      value: 'Marta',
    });
    await t.app.setSetting('ai', {
      ...t.app.settings.ai,
      enabled: true,
      preflightAcknowledged: ['mapping_only'],
    });
    t.files.put('/form.pdf', (await flatFormDoc()).pdf);
    const s = (await t.app.openRef(t.files.ref('/form.pdf')))!;
    const sf = t.smartFill(s);
    expect(await sf.aiAvailable()).toBe(true);
    await sf.start();
    expect(sf.result?.source).toBe('ai');
    expect(sf.suggestions.find((x) => x.profileKey === 'first_name')?.value).toBe('Marta');
  });

  it('the pre-flight names the local server as the destination @FR-AIF-12 @FR-AIF-04', async () => {
    const t = await createTestApp();
    const model = new AiSettingsModel(t.app);
    await model.selectProvider('lmstudio');
    await t.services.profiles.create('Me', ['identity']);
    await t.app.setSetting('ai', { ...t.app.settings.ai, enabled: true });
    t.files.put('/form.pdf', (await flatFormDoc()).pdf);
    const sf = t.smartFill((await t.app.openRef(t.files.ref('/form.pdf')))!);
    await sf.start();
    expect(sf.stage).toBe('preflight');
    expect(sf.preflight!.destination).toEqual({ host: 'localhost:1234', local: true });
    expect(t.http.requests).toEqual([]);
  });

  it('a server that is not running is named in the message; a remote http host is refused @FR-AIF-12', async () => {
    const t = await createTestApp();
    const model = new AiSettingsModel(t.app);
    await model.selectProvider('ollama');
    t.http.fallback = () => new NetworkError('ECONNREFUSED 127.0.0.1:11434');
    expect(await model.test()).toBe(false);
    expect(model.result).toEqual({
      ok: false,
      message: { key: 'settings.ai.test.notAnswering', params: { name: 'Ollama', host: 'localhost:11434' } },
    });

    expect(await model.setBaseUrl('http://llm.example.org/v1')).toEqual({ key: 'settings.ai.url.insecure' });
    expect(await model.setBaseUrl('https://me:pw@llm.example.org/v1')).toEqual({
      key: 'settings.ai.url.credentials',
    });
    expect(await model.setBaseUrl('not a url')).toEqual({ key: 'settings.ai.url.invalid' });
    expect(t.app.settings.ai.baseUrl).toBe('http://localhost:11434/v1');
    // A remote https host is accepted but still needs a key.
    expect(await model.setBaseUrl('https://llm.example.org/v1/')).toBeNull();
    expect(t.app.settings.ai).toMatchObject({ baseUrl: 'https://llm.example.org/v1', provider: 'custom' });
    expect(model.keyRequired).toBe(true);
    const before = t.http.requests.length;
    expect(await model.test()).toBe(false);
    expect(model.result!.message.key).toBe('settings.ai.test.fail.notConfigured');
    expect(t.http.requests.length).toBe(before);
    // Typing a preset's address selects that preset.
    expect(await model.setBaseUrl('http://localhost:8080/v1')).toBeNull();
    expect(model.provider).toBe('llamacpp');
    await model.selectProvider('custom');
    expect(t.app.settings.ai).toMatchObject({ provider: 'custom', baseUrl: 'http://localhost:8080/v1' });
  });

  it('on desktop a new host must be approved; a refusal keeps the old one @FR-AIF-12', async () => {
    const t = await createTestApp();
    const asked: string[] = [];
    let allow = false;
    const model = new AiSettingsModel(t.app, async (url) => (asked.push(url), allow));
    expect(await model.selectProvider('ollama')).toBe(false);
    expect(t.app.settings.ai.baseUrl).toBe('https://api.openai.com/v1');
    expect(await model.setBaseUrl('https://llm.example.org/v1')).toEqual({
      key: 'settings.ai.url.notApproved',
    });
    allow = true;
    expect(await model.selectProvider('ollama')).toBe(true);
    expect(asked).toEqual([
      'http://localhost:11434/v1',
      'https://llm.example.org/v1',
      'http://localhost:11434/v1',
    ]);
  });
});

describe('Model capability check @FR-AIF-13', () => {
  it('stores the result per base URL and model and invalidates it when either changes @FR-AIF-13', async () => {
    const t = await createTestApp();
    await t.secrets.set(OPENAI_KEY_SECRET, 'sk-test');
    const model = new AiSettingsModel(t.app);
    expect(model.capabilities.probed).toBe(false);
    t.http.fallback = fakeServer({ vision: false, schema: false });
    expect(await model.test()).toBe(true);
    expect(t.app.settings.ai.capabilities).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      vision: false,
      structured: 'json_object',
    });
    expect(model.capabilities).toEqual({ vision: false, structured: 'json_object', probed: true });
    expect(model.visionGate()).toEqual({ ok: false, reason: { key: 'ai.gate.noVision' } });
    expect(model.smartFillGate()).toEqual({ ok: true });
    // The manual override wins over a false negative.
    await model.setVisionOverride(true);
    expect(model.visionGate()).toEqual({ ok: true });
    await model.setVisionOverride(false);

    // Changing the model and saving probes again.
    t.http.fallback = fakeServer({ vision: true });
    const before = t.http.requests.length;
    await model.setModel('gpt-4o');
    expect(t.http.requests.length).toBeGreaterThan(before);
    expect(model.capabilities).toEqual({ vision: true, structured: 'json_schema', probed: true });
    // Another base URL makes the stored result stale until the next check.
    await t.app.setSetting('ai', { ...t.app.settings.ai, baseUrl: 'https://other.example/v1' });
    expect(aiCapabilities(t.app.settings.ai).probed).toBe(false);
  });

  it('without vision the image option is off and Smart Fill sends no image; without JSON the AI is not offered @FR-AIF-13', async () => {
    const ai = new FakeAiProvider();
    const withImage: boolean[] = [];
    const analyze = ai.analyzeForm.bind(ai);
    ai.analyzeForm = (req, signal) => (withImage.push(!!req.images?.length), analyze(req, signal));
    const t = await createTestApp({ ai });
    await t.services.profiles.create('Me', ['identity']);
    await t.app.setSetting('ai', {
      ...t.app.settings.ai,
      enabled: true,
      includeImage: true,
      preflightAcknowledged: ['mapping_only'],
    });
    const model = new AiSettingsModel(t.app);
    ai.capabilities = { vision: false, structured: 'json_object' };
    expect(await model.test()).toBe(true);
    expect(ai.probes).toBe(1);
    t.files.put('/form.pdf', (await flatFormDoc()).pdf);
    const s = (await t.app.openRef(t.files.ref('/form.pdf')))!;
    const sf = t.smartFill(s);
    await sf.start();
    expect(sf.result?.source).toBe('ai');
    expect(t.app.settings.ai.includeImage).toBe(true);
    expect(withImage).toEqual([false]);

    ai.capabilities = { vision: false, structured: 'none' };
    await model.test();
    expect(model.smartFillGate()).toEqual({ ok: false, reason: { key: 'ai.gate.noJson' } });
    expect(await sf.aiAvailable()).toBe(false);
    sf.cancel();
    await sf.start();
    expect(sf.result?.source).toBe('heuristic');
    expect(ai.requests.length).toBe(1);
  });

  it('401, 429 and offline are connection errors, not missing capabilities @FR-AIF-13', async () => {
    const t = await createTestApp();
    await t.secrets.set(OPENAI_KEY_SECRET, 'sk-test');
    const model = new AiSettingsModel(t.app);
    t.http.enqueue(FakeHttpClient.json(200, { data: [] }), FakeHttpClient.json(401, {}));
    expect(await model.test()).toBe(false);
    expect(model.result!.message.key).toBe('settings.ai.test.fail.unauthorized');
    expect(t.app.settings.ai.capabilities).toBeNull();
    t.http.enqueue(FakeHttpClient.json(200, { data: [] }), FakeHttpClient.json(429, {}));
    expect(await model.test()).toBe(false);
    expect(model.result!.message.key).toBe('settings.ai.test.fail.rateLimited');
    t.http.enqueue(() => new NetworkError('offline'));
    expect(await model.test()).toBe(false);
    expect(model.result!.message.key).toBe('settings.ai.test.fail.network');
    expect(t.app.settings.ai.capabilities).toBeNull();
  });
});
