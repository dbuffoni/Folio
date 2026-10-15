import {
  AI_PRESETS,
  AiError,
  Emitter,
  aiCapabilities,
  aiEndpointProblem,
  endpointHost,
  isFolioError,
  isLoopbackUrl,
  msg,
  presetForUrl,
  type AiProviderId,
  type KnownAiCapabilities,
  type Msg,
} from '@folio/core';
import type { AppModel } from './app.ts';

const FAILURES = [
  'notConfigured',
  'unauthorized',
  'rateLimited',
  'malformed',
  'server',
  'blocked',
  'insecure',
  'unsupported',
  'network',
];

/** Why an AI feature that needs something the model lacks is unavailable (FR-AIF-13). */
export type AiGate = { ok: true } | { ok: false; reason: Msg };

/**
 * Settings ▸ Smart Fill (FR-AIF-02, FR-AIF-12, FR-AIF-13): presets for local servers, Test connection,
 * capability probes and the gates other features read. Nothing here touches the network except
 * `test()` and `setModel()`, both explicit user actions.
 */
export class AiSettingsModel {
  readonly changed = new Emitter<void>();
  testing = false;
  /** Result line under the Test button. */
  result: { ok: boolean; message: Msg } | null = null;
  /** Model ids from `/models`; empty keeps the model field free text. */
  models: string[] = [];

  constructor(
    private readonly app: AppModel,
    /** Desktop: asks the user to approve a new host in a native dialog (the Rust proxy pins one origin). */
    private readonly approveOrigin?: (url: string) => Promise<boolean>,
  ) {}

  private emit(): void {
    this.changed.emit();
  }
  private get ai() {
    return this.app.settings.ai;
  }
  get provider(): AiProviderId {
    return this.ai.provider;
  }
  get baseUrl(): string {
    return this.ai.baseUrl;
  }
  /** "Local: data stays on this computer" badge: only for loopback hosts. */
  get local(): boolean {
    return isLoopbackUrl(this.ai.baseUrl);
  }
  /** The key field is optional for a server on this computer. */
  get keyRequired(): boolean {
    return !this.local;
  }
  get host(): string {
    return endpointHost(this.ai.baseUrl);
  }
  get capabilities(): KnownAiCapabilities {
    return aiCapabilities(this.ai);
  }
  /** Web build: the CORS hint names the switch of the chosen server (OLLAMA_ORIGINS, LM Studio's CORS option). */
  get corsHint(): Msg {
    return msg(`settings.ai.cors.${this.ai.provider}`);
  }

  private async save(patch: Partial<typeof this.ai>): Promise<void> {
    await this.app.setSetting('ai', { ...this.app.settings.ai, ...patch });
    this.emit();
  }

  /** Picking a preset fills the base URL. No request is sent (no port scanning, no network by default). */
  async selectProvider(id: AiProviderId): Promise<boolean> {
    const url = AI_PRESETS[id].baseUrl;
    if (url && url !== this.ai.baseUrl) {
      if (this.approveOrigin && !(await this.app.guard(() => this.approveOrigin!(url)))) return false;
      await this.save({ provider: id, baseUrl: url });
    } else await this.save({ provider: id });
    this.result = null;
    this.models = [];
    this.emit();
    return true;
  }

  /** Typed base URL: https anywhere, plain http only on this computer. Returns the problem, if any. */
  async setBaseUrl(raw: string): Promise<Msg | null> {
    const url = raw.trim().replace(/\/+$/, '');
    const problem = aiEndpointProblem(url);
    if (problem) return msg(`settings.ai.url.${problem}`);
    if (url === this.ai.baseUrl) return null;
    if (this.approveOrigin && !(await this.app.guard(() => this.approveOrigin!(url))))
      return msg('settings.ai.url.notApproved');
    await this.save({ baseUrl: url, provider: presetForUrl(url) });
    this.result = null;
    this.models = [];
    this.emit();
    return null;
  }

  /** Saving another model invalidates the stored probe; with a usable endpoint the probes run again. */
  async setModel(model: string): Promise<void> {
    const m = model.trim();
    if (!m || m === this.ai.model) return;
    await this.save({ model: m });
    if (await this.app.services.ai.isConfigured()) await this.probe();
  }

  async setVisionOverride(on: boolean): Promise<void> {
    await this.save({ visionOverride: on });
  }

  /** Always enabled: lists the models, then probes images and structured output. */
  async test(signal?: AbortSignal): Promise<boolean> {
    const provider = this.app.services.openAi;
    this.testing = true;
    this.result = null;
    this.emit();
    try {
      if (!provider) {
        // Tests and builds with an injected provider: only the probes.
        return await this.probe(signal);
      }
      const res = await provider.testConnection(signal);
      if (!res.ok) {
        this.result = { ok: false, message: this.failure(res.reason, res.local) };
        return false;
      }
      this.models = res.models;
      this.result = { ok: true, message: msg('settings.ai.test.ok', { count: res.models.length }) };
      this.emit();
      return await this.probe(signal);
    } finally {
      this.testing = false;
      this.emit();
    }
  }

  private failure(reason: string, local: boolean): Msg {
    if (local && reason === 'network') {
      const name = AI_PRESETS[this.ai.provider].name;
      return name
        ? msg('settings.ai.test.notAnswering', { name, host: this.host })
        : msg('settings.ai.test.notAnsweringHost', { host: this.host });
    }
    return msg(`settings.ai.test.fail.${FAILURES.includes(reason) ? reason : 'unknown'}`);
  }

  /** Stores the probe result for this base URL and model pair. */
  private async probe(signal?: AbortSignal): Promise<boolean> {
    try {
      const caps = await this.app.services.ai.probeCapabilities(signal);
      const { baseUrl, model } = this.ai;
      await this.save({
        capabilities: {
          // Same key order as the settings schema: the repository compares the stored JSON.
          baseUrl,
          model,
          vision: caps.vision,
          structured: caps.structured,
          checkedAt: this.app.services.platform.clock.now().toISOString(),
        },
      });
      return true;
    } catch (e) {
      const reason = e instanceof AiError ? e.kind : isFolioError(e) ? e.code : 'unknown';
      this.result = { ok: false, message: this.failure(reason, this.local) };
      return false;
    }
  }

  /** Smart Fill with the AI at all: needs some kind of JSON output (FR-AIF-13). */
  smartFillGate(): AiGate {
    return this.capabilities.structured === 'none'
      ? { ok: false, reason: msg('ai.gate.noJson') }
      : { ok: true };
  }
  /** Features that send page images (Smart Fill on scans, AI field detection, AI OCR, AI tables). */
  visionGate(): AiGate {
    const json = this.smartFillGate();
    if (!json.ok) return json;
    return this.capabilities.vision ? { ok: true } : { ok: false, reason: msg('ai.gate.noVision') };
  }
}

/** Gates computed from settings alone, for view-models that have no AiSettingsModel at hand. */
export function aiGates(ai: Parameters<typeof aiCapabilities>[0]): { json: boolean; vision: boolean } {
  const caps = aiCapabilities(ai);
  return { json: caps.structured !== 'none', vision: caps.structured !== 'none' && caps.vision };
}
