import { describe, expect, it } from 'vitest';
import { AI_PRESETS, aiEndpointProblem, aiTimeoutFor, endpointHost, isLoopbackUrl, presetForUrl } from './ai-endpoints.ts';
import { DEFAULT_SETTINGS, aiCapabilities, parseSettings } from './settings.ts';

describe('AI endpoints', () => {
  it('presets fill loopback addresses for local servers @FR-AIF-12', () => {
    expect(AI_PRESETS.ollama.baseUrl).toBe('http://localhost:11434/v1');
    expect(AI_PRESETS.lmstudio.baseUrl).toBe('http://localhost:1234/v1');
    expect(AI_PRESETS.llamacpp.baseUrl).toBe('http://localhost:8080/v1');
    for (const p of Object.values(AI_PRESETS)) if (p.baseUrl) expect(isLoopbackUrl(p.baseUrl)).toBe(p.local);
    expect(presetForUrl('http://localhost:11434/v1/')).toBe('ollama');
    expect(presetForUrl('http://localhost:9999/v1')).toBe('custom');
    expect(DEFAULT_SETTINGS.ai.provider).toBe('openai');
  });
  it('plain http is accepted only for this computer @FR-AIF-12', () => {
    expect(aiEndpointProblem('https://api.openai.com/v1')).toBeNull();
    expect(aiEndpointProblem('http://127.0.0.1:1234/v1')).toBeNull();
    expect(aiEndpointProblem('http://[::1]:8080/v1')).toBeNull();
    expect(aiEndpointProblem('http://llm.example.org/v1')).toBe('insecure');
    expect(aiEndpointProblem('http://localhost.example.org/v1')).toBe('insecure');
    expect(aiEndpointProblem('https://a:b@llm.example.org')).toBe('credentials');
    expect(aiEndpointProblem('ftp://localhost')).toBe('invalid');
    expect(aiEndpointProblem('nonsense')).toBe('invalid');
    expect(aiTimeoutFor('http://localhost:11434/v1')).toBe(180_000);
    expect(aiTimeoutFor('https://api.openai.com/v1')).toBe(60_000);
    expect(endpointHost('http://localhost:11434/v1')).toBe('localhost:11434');
  });
  it('a stored probe counts only for its base URL and model; the vision override wins @FR-AIF-13', () => {
    const probe = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', vision: false, structured: 'json_object' as const, checkedAt: '2026-10-15T00:00:00Z' };
    const ai = parseSettings({ ai: { ...DEFAULT_SETTINGS.ai, capabilities: probe } }).ai;
    expect(aiCapabilities(ai)).toEqual({ vision: false, structured: 'json_object', probed: true });
    expect(aiCapabilities({ ...ai, visionOverride: true }).vision).toBe(true);
    expect(aiCapabilities({ ...ai, model: 'other' })).toEqual({ vision: true, structured: 'json_schema', probed: false });
    expect(aiCapabilities({ ...ai, baseUrl: 'http://localhost:11434/v1' }).probed).toBe(false);
    // Settings written by 0.1.0 have no provider or probe: defaults apply.
    expect(parseSettings({ ai: { enabled: true } }).ai).toMatchObject({ provider: 'openai', capabilities: null, visionOverride: false, enabled: true });
  });
});
