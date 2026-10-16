import type { AiCapabilities, AiProvider, FormAnalysisRequest, FormAnalysisResult, PageTranscription, PageTranscriptionRequest } from '@folio/ports';
import { estimateTokens } from './prompt.ts';
import { validateOutput, validateTranscription } from './schema.ts';

export type FakeAnswer = FormAnalysisResult | Error | ((req: FormAnalysisRequest) => unknown);

/** Scripted provider for tests (SPEC §10.4): fixed answers, raw model output, or injected errors. */
export class FakeAiProvider implements AiProvider {
  readonly requests: FormAnalysisRequest[] = [];
  configured = true;
  /** What `probeCapabilities` reports; an Error is thrown instead. */
  capabilities: AiCapabilities | Error = { vision: true, structured: 'json_schema' };
  probes = 0;
  private queue: FakeAnswer[] = [];
  constructor(private fallback: FakeAnswer = { fields: [], newAreas: [] }) {}

  enqueue(...answers: FakeAnswer[]): this {
    this.queue.push(...answers);
    return this;
  }
  async isConfigured(): Promise<boolean> {
    return this.configured;
  }
  /** Scripted page transcriptions (raw model output goes through the same validation as real answers). */
  readonly transcriptionRequests: Array<Omit<PageTranscriptionRequest, 'jpeg'>> = [];
  private transcriptions: Array<PageTranscription | Error | ((req: PageTranscriptionRequest) => unknown)> = [];
  enqueueTranscription(...answers: Array<PageTranscription | Error | ((req: PageTranscriptionRequest) => unknown)>): this {
    this.transcriptions.push(...answers);
    return this;
  }
  async recognizePage(req: PageTranscriptionRequest, signal: AbortSignal): Promise<PageTranscription> {
    if (signal.aborted) throw new Error('aborted');
    this.transcriptionRequests.push({ page: req.page, width: req.width, height: req.height });
    const answer = this.transcriptions.shift() ?? { lines: [] };
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'function') return { ...validateTranscription(answer(req)), model: 'fake' };
    return { model: 'fake', ...answer };
  }
  async probeCapabilities(): Promise<AiCapabilities> {
    this.probes++;
    if (this.capabilities instanceof Error) throw this.capabilities;
    return { ...this.capabilities };
  }
  estimateTokens(req: FormAnalysisRequest): number {
    return estimateTokens(req);
  }
  async analyzeForm(req: FormAnalysisRequest, signal: AbortSignal): Promise<FormAnalysisResult> {
    if (signal.aborted) throw new Error('aborted');
    this.requests.push(structuredClone({ ...req, images: undefined }) as FormAnalysisRequest);
    const answer = this.queue.shift() ?? this.fallback;
    if (answer instanceof Error) throw answer;
    // Function answers stand in for raw model output and go through the same validation as real ones.
    if (typeof answer === 'function') return { ...validateOutput(answer(req), req).result, model: 'fake', usage: { inputTokens: estimateTokens(req), outputTokens: 50 } };
    return { model: 'fake', ...answer };
  }
}
