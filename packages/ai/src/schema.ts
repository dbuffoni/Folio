import { z } from 'zod';
import type { FormAnalysisRequest, FormAnalysisResult, PageTranscription } from '@folio/ports';

export const TRANSFORMS = ['none', 'upper', 'lower', 'date_dmy', 'date_mdy', 'date_iso', 'first_name', 'last_name', 'full_name', 'phone_e164', 'phone_national', 'checkbox_true', 'checkbox_false'] as const;
const FIELD_TYPES = ['text', 'date', 'number', 'checkbox', 'radio', 'choice', 'signature', 'multiline'] as const;
const AREA_TYPES = ['text', 'date', 'number', 'checkbox', 'multiline'] as const;

/** Output schema v1 (SPEC §10.3), sent as a strict JSON Schema for Structured Outputs. */
export const OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fields', 'newAreas'],
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'label', 'fieldType', 'profileKey', 'transform', 'choiceValue', 'confidence'],
        properties: {
          ref: { type: 'string', description: 'id from the input candidate list' },
          label: { type: 'string' },
          fieldType: { type: 'string', enum: FIELD_TYPES },
          profileKey: { type: ['string', 'null'] },
          transform: { type: 'string', enum: TRANSFORMS },
          choiceValue: { type: ['string', 'null'] },
          confidence: { type: 'number' },
        },
      },
    },
    newAreas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['page', 'bbox', 'label', 'fieldType', 'profileKey', 'confidence'],
        properties: {
          page: { type: 'integer' },
          bbox: { type: 'array', items: { type: 'number' } },
          label: { type: 'string' },
          fieldType: { type: 'string', enum: AREA_TYPES },
          profileKey: { type: ['string', 'null'] },
          confidence: { type: 'number' },
        },
      },
    },
  },
} as const;

const fieldSchema = z.object({
  ref: z.string(),
  label: z.string().catch(''),
  fieldType: z.enum(FIELD_TYPES).catch('text'),
  profileKey: z.string().nullable().catch(null),
  transform: z.enum(TRANSFORMS).catch('none'),
  choiceValue: z.string().nullable().optional().catch(null),
  confidence: z.number().catch(0),
});
const areaSchema = z.object({
  page: z.number().int(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  label: z.string().catch(''),
  fieldType: z.enum(AREA_TYPES).catch('text'),
  profileKey: z.string().nullable().catch(null),
  confidence: z.number().catch(0),
});
const outputSchema = z.object({ fields: z.array(z.unknown()), newAreas: z.array(z.unknown()).optional().default([]) });

export interface ValidationReport {
  result: FormAnalysisResult;
  /** Entries dropped or downgraded, for diagnostics (never shown as raw model text). */
  dropped: number;
  downgraded: number;
}

/**
 * Validates model output against the request (SPEC §10.3 step 4): unknown candidate ids and profile
 * keys are discarded, bounding boxes are clamped, and anything that needed repair is marked low confidence.
 * @throws when the payload is not even the right shape.
 */
export function validateOutput(raw: unknown, req: FormAnalysisRequest): ValidationReport {
  const top = outputSchema.parse(raw);
  const refs = new Set(req.candidates.map((c) => c.ref));
  const keys = new Set(req.profileKeys.map((k) => k.key));
  const pages = new Set(req.pages.map((p) => p.page));
  let dropped = 0;
  let downgraded = 0;
  const seen = new Set<string>();
  const fields: FormAnalysisResult['fields'] = [];
  for (const item of top.fields) {
    const parsed = fieldSchema.safeParse(item);
    if (!parsed.success || !refs.has(parsed.data.ref) || seen.has(parsed.data.ref)) {
      dropped++;
      continue;
    }
    seen.add(parsed.data.ref);
    const f = { ...parsed.data, choiceValue: parsed.data.choiceValue ?? null };
    const strict = z.object({ fieldType: z.enum(FIELD_TYPES), transform: z.enum(TRANSFORMS), confidence: z.number().min(0).max(1) }).safeParse(item);
    let confidence = Math.min(1, Math.max(0, f.confidence));
    if (f.profileKey !== null && !keys.has(f.profileKey)) {
      // The model may not invent keys: the mapping is removed, not guessed.
      f.profileKey = null;
      confidence = 0;
      downgraded++;
    } else if (!strict.success) {
      confidence = Math.min(confidence, 0.3);
      downgraded++;
    }
    fields.push({ ...f, confidence });
  }
  const newAreas: FormAnalysisResult['newAreas'] = [];
  for (const item of top.newAreas) {
    const parsed = areaSchema.safeParse(item);
    if (!parsed.success || !pages.has(parsed.data.page)) {
      dropped++;
      continue;
    }
    const clamp = (v: number): number => Math.min(1, Math.max(0, v));
    const [x0, y0, x1, y1] = parsed.data.bbox.map(clamp) as [number, number, number, number];
    if (x1 - x0 < 0.005 || y1 - y0 < 0.003) {
      dropped++;
      continue;
    }
    const known = parsed.data.profileKey === null || keys.has(parsed.data.profileKey);
    newAreas.push({ ...parsed.data, bbox: [x0, y0, x1, y1], profileKey: known ? parsed.data.profileKey : null, confidence: known ? Math.min(1, Math.max(0, parsed.data.confidence)) : 0 });
  }
  return { result: { fields, newAreas }, dropped, downgraded };
}

/** Output schema of page transcription, sent as a strict JSON Schema. */
export const TRANSCRIPTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'bbox', 'confidence'],
        properties: {
          text: { type: 'string' },
          bbox: { type: 'array', items: { type: 'number' } },
          confidence: { type: 'number' },
        },
      },
    },
  },
} as const;

const lineSchema = z.object({
  text: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  confidence: z.number().catch(0),
});
/** Keeps only usable lines: text present, box ordered and inside the page, confidence in 0–1. */
export function validateTranscription(raw: unknown): { lines: PageTranscription['lines']; dropped: number } {
  const top = z.object({ lines: z.array(z.unknown()) }).parse(raw);
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  const lines: PageTranscription['lines'] = [];
  let dropped = 0;
  for (const item of top.lines) {
    const p = lineSchema.safeParse(item);
    if (!p.success || p.data.text.trim() === '') {
      dropped++;
      continue;
    }
    const [a, b, c, d] = p.data.bbox.map(clamp) as [number, number, number, number];
    const bbox: [number, number, number, number] = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
    if (bbox[2] - bbox[0] < 0.004 || bbox[3] - bbox[1] < 0.002) {
      dropped++;
      continue;
    }
    lines.push({ text: p.data.text.replace(/\s+/g, ' ').trim(), bbox, confidence: clamp(p.data.confidence) });
  }
  return { lines, dropped };
}
