import type { Rect } from './geometry.ts';

export type SmartFieldType = 'text' | 'date' | 'number' | 'checkbox' | 'radio' | 'choice' | 'signature' | 'multiline';
export type TransformId =
  | 'none'
  | 'upper'
  | 'lower'
  | 'date_dmy'
  | 'date_mdy'
  | 'date_iso'
  | 'first_name'
  | 'last_name'
  | 'full_name'
  | 'phone_e164'
  | 'phone_national'
  | 'checkbox_true'
  | 'checkbox_false';

/** A place on a page where a value can go: an AcroForm field or a locally detected area. */
export interface FormCandidate {
  /** Stable id: field id for AcroForm, `p{page}-a{n}` for detected areas. */
  ref: string;
  page: number;
  rect: Rect;
  kind: 'acroform' | 'detected';
  fieldType: SmartFieldType;
  /** Field name / tooltip / nearby label text. */
  name?: string;
  label?: string;
  options?: string[];
}
export interface ProfileKeyInfo {
  key: string;
  label: string;
  type: string;
  aliases: string[];
  /** Only in with-values mode and never for sensitive fields. */
  value?: string;
}
export interface FormAnalysisRequest {
  mode: 'mapping_only' | 'with_values';
  pages: Array<{ page: number; width: number; height: number; textLines: Array<{ text: string; rect: Rect }> }>;
  candidates: FormCandidate[];
  profileKeys: ProfileKeyInfo[];
  /** JPEG page images with numbered candidate boxes (set-of-marks), when enabled. */
  images?: Array<{ page: number; jpeg: Uint8Array; width: number; height: number }>;
}
export interface FieldMapping {
  ref: string;
  label: string;
  fieldType: SmartFieldType;
  profileKey: string | null;
  transform: TransformId;
  choiceValue?: string | null;
  confidence: number;
}
export interface NewArea {
  page: number;
  /** Normalised 0–1 relative to the page image: [x0, y0, x1, y1], origin top-left. */
  bbox: [number, number, number, number];
  label: string;
  fieldType: 'text' | 'date' | 'number' | 'checkbox' | 'multiline';
  profileKey: string | null;
  confidence: number;
}
export interface FormAnalysisResult {
  fields: FieldMapping[];
  newAreas: NewArea[];
  usage?: { inputTokens: number; outputTokens: number };
  model?: string;
}
/** How the model can be asked for JSON: strict schema, plain JSON mode, or not at all. */
export type StructuredOutput = 'json_schema' | 'json_object' | 'none';
/** What the configured model supports, found by two tiny probe requests (FR-AIF-13). */
export interface AiCapabilities {
  vision: boolean;
  structured: StructuredOutput;
}
/** What the vision model reads off a page image (FR-OCR "Read difficult scans with AI"). */
export interface PageTranscriptionRequest {
  page: number;
  jpeg: Uint8Array;
  width: number;
  height: number;
}
export interface TranscribedLine {
  text: string;
  /** Normalised 0–1 relative to the page image: [x0, y0, x1, y1], origin top-left. */
  bbox: [number, number, number, number];
  confidence: number;
}
export interface PageTranscription {
  lines: TranscribedLine[];
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface AiProvider {
  /**
   * Transcribes the text of one page image into lines with boxes, for the invisible OCR layer. The text
   * read from the image is data; it is never acted on.
   * @throws AiError('unsupported') when the model returns no JSON, AiError('malformed') for unusable output.
   */
  recognizePage(req: PageTranscriptionRequest, signal: AbortSignal): Promise<PageTranscription>;
  isConfigured(): Promise<boolean>;
  /**
   * Sends the two probes (structured output, vision). Only on an explicit user action.
   * @throws AiError('unauthorized' | 'rateLimited') or NetworkError: those are connection problems, not missing capabilities.
   */
  probeCapabilities(signal?: AbortSignal): Promise<AiCapabilities>;
  analyzeForm(req: FormAnalysisRequest, signal: AbortSignal): Promise<FormAnalysisResult>;
  /** Rough token estimate shown in the pre-flight dialog. */
  estimateTokens(req: FormAnalysisRequest): number;
}
