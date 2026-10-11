import {
  AiError,
  CompositeCommand,
  InvalidArgumentError,
  NetworkError,
  formatDate,
  isFolioError,
  toHex,
  utf8,
  type Command,
} from '@folio/core';
import type {
  AiProvider,
  CryptoService,
  FieldMapping,
  FieldValue,
  FormAnalysisRequest,
  FormCandidate,
  FormField,
  ImageCodec,
  PageIndex,
  PdfDocument,
  ProfileKeyInfo,
  Rect,
  SmartFieldType,
  TextLayer,
  TransformId,
} from '@folio/ports';
import type { AnnotationService } from './annotation.ts';
import { label } from './commands.ts';
import { detectAreas, isFillable, type DetectedArea, type FormService } from './form.ts';
import type { StampService } from './stamp.ts';
import { BUILTIN_STAMPS } from './stamp.ts';

// ---- data the service works with (kept structural so it does not depend on the db package) ------

export interface SmartProfileField {
  key: string;
  label: string;
  type: string;
  value: string;
  sensitive: boolean;
  aliases: string[];
}
export interface SmartProfile {
  id: string;
  name: string;
  fields: SmartProfileField[];
}
export interface MappingEntry {
  fieldRef: string;
  profileKey: string;
  transform: string;
  choiceValue?: string | null;
}
export interface MappingStore {
  find(
    docFingerprint: string,
    profileId: string,
  ): Promise<{ mapping: MappingEntry[]; source: 'ai' | 'heuristic' | 'manual' } | null>;
  save(
    docFingerprint: string,
    profileId: string,
    mapping: MappingEntry[],
    source: 'ai' | 'heuristic' | 'manual',
  ): Promise<void>;
  forget(docFingerprint: string, profileId: string): Promise<void>;
}
export interface RunLog {
  record(run: {
    model: string;
    mode: 'mapping_only' | 'with_values';
    includedImage: boolean;
    inputTokens?: number;
    outputTokens?: number;
    status: string;
  }): Promise<void>;
}

export interface SmartCandidate extends FormCandidate {
  /** AcroForm field behind the candidate. */
  field?: FormField;
  /** Detected area behind the candidate. */
  area?: DetectedArea;
}
export type Confidence = 'high' | 'medium' | 'low';
export interface Suggestion {
  ref: string;
  page: PageIndex;
  rect: Rect;
  kind: 'acroform' | 'detected';
  /** Label shown in the review panel. */
  label: string;
  fieldType: SmartFieldType;
  profileKey: string | null;
  transform: TransformId;
  choiceValue?: string | null;
  /** Value that will be written; '' when there is no matching data. */
  value: string;
  score: number;
  confidence: Confidence;
  /** Ticked in the review panel. Low-confidence suggestions start unticked (FR-AIF-05). */
  accepted: boolean;
  candidate: SmartCandidate;
}
export interface AnalysisResult {
  suggestions: Suggestion[];
  source: 'ai' | 'heuristic' | 'remembered';
  fingerprint: string;
  /** Why the AI was not used although it was requested (shown as a notice). */
  fallbackReason?:
    'offline' | 'unauthorized' | 'rateLimited' | 'malformed' | 'server' | 'blocked' | 'notConfigured';
}
export interface Preflight {
  mode: 'mapping_only' | 'with_values';
  pages: number[];
  candidateCount: number;
  textLineCount: number;
  /** A few labels as examples of what leaves the machine. */
  sampleLabels: string[];
  keyCount: number;
  /** Values are included for these keys (with-values mode, never sensitive ones). */
  valueKeys: string[];
  withheldKeys: string[];
  includesImage: boolean;
  estimatedTokens: number;
}

// ---- fuzzy matching (FR-AIF-07) ----------------------------------------------------------------

/** Lower-case, accent-free tokens without punctuation or filler words. */
export function tokens(s: string): string[] {
  const STOP = new Set([
    'the',
    'of',
    'your',
    'di',
    'del',
    'della',
    'il',
    'la',
    'lo',
    'e',
    'and',
    'no',
    'n',
    'nr',
    'num',
    'numero',
    'number',
    'please',
    'enter',
    'inserire',
  ]);
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && (t.length > 1 || /\d/.test(t)))
    .filter((t, _i, all) => !STOP.has(t) || all.length === 1);
}
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = cur;
    }
  }
  return prev[b.length]!;
}
const tokenMatch = (a: string, b: string): number => {
  if (a === b) return 1;
  if (a.length >= 4 && b.length >= 4) {
    if (a.startsWith(b) || b.startsWith(a)) return 0.85;
    if (editDistance(a, b) <= 1) return 0.8;
  }
  return 0;
};
/** Token-set ratio in 0–1: how well two short labels agree regardless of word order. */
export function tokenSetRatio(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const cover = (xs: string[], ys: string[]): number =>
    xs.reduce((sum, x) => sum + Math.max(...ys.map((y) => tokenMatch(x, y))), 0) / xs.length;
  const ab = cover(ta, tb);
  const ba = cover(tb, ta);
  // Harmonic-style blend: both labels must be mostly explained by the other.
  return ab === 0 || ba === 0 ? 0 : (2 * ab * ba) / (ab + ba);
}

export const HEURISTIC_THRESHOLD = 0.72;
const level = (score: number): Confidence => (score >= 0.85 ? 'high' : score >= 0.6 ? 'medium' : 'low');

// ---- transforms (FR-AIF-09) --------------------------------------------------------------------

function parseDate(v: string): Date | null {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v.trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v.trim());
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}
/** Applies a transform id to a stored value. Unknown or inapplicable transforms leave the value alone. */
export function applyTransform(value: string, transform: TransformId, profile?: SmartProfile): string {
  const get = (key: string): string => profile?.fields.find((f) => f.key === key)?.value ?? '';
  switch (transform) {
    case 'upper':
      return value.toLocaleUpperCase();
    case 'lower':
      return value.toLocaleLowerCase();
    case 'date_dmy':
    case 'date_mdy':
    case 'date_iso': {
      const d = parseDate(value);
      return d
        ? formatDate(d, transform === 'date_dmy' ? 'dmy' : transform === 'date_mdy' ? 'mdy' : 'iso')
        : value;
    }
    case 'first_name':
      return get('first_name') || value.trim().split(/\s+/)[0] || value;
    case 'last_name':
      return get('last_name') || value.trim().split(/\s+/).slice(1).join(' ') || value;
    case 'full_name':
      return get('full_name') || [get('first_name'), get('last_name')].filter(Boolean).join(' ') || value;
    case 'phone_e164': {
      const digits = value.replace(/[^\d+]/g, '');
      return digits.startsWith('+') ? digits : digits.startsWith('00') ? `+${digits.slice(2)}` : digits;
    }
    case 'phone_national': {
      const digits = value.replace(/[^\d+]/g, '');
      return digits.replace(/^\+\d{1,3}?(?=\d{9,10}$)/, '').replace(/^\+/, '');
    }
    case 'checkbox_true':
      return 'true';
    case 'checkbox_false':
      return 'false';
    default:
      return value;
  }
}
const truthy = (v: string): boolean => /^(true|yes|y|si|sì|x|1|on)$/i.test(v.trim());

function typeOfCandidate(field: FormField): SmartFieldType {
  switch (field.type) {
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'dropdown':
    case 'listbox':
      return 'choice';
    case 'signature':
      return 'signature';
    default:
      return field.multiline
        ? 'multiline'
        : field.format?.kind === 'date'
          ? 'date'
          : field.format?.kind === 'number'
            ? 'number'
            : 'text';
  }
}
/** "person.firstName" / "txt_first_name" → "first name". */
const humanize = (name: string): string => tokens(name.split('.').pop() ?? name).join(' ');

/** Nearest label to the left of or above a rectangle (same rule family as the area detector). */
function labelNear(rect: Rect, layer: TextLayer): string | undefined {
  let best: { text: string; d: number } | undefined;
  for (const line of layer.lines) {
    const text = line.text.replace(/[:\s]+$/g, '').trim();
    if (!text) continue;
    const r = line.rect;
    const sameRow = r.y < rect.y + rect.height && r.y + r.height > rect.y;
    let d = Infinity;
    if (sameRow && r.x + r.width <= rect.x + 4) d = rect.x - (r.x + r.width);
    else if (sameRow && r.x >= rect.x + rect.width - 2 && rect.width <= 22)
      d = r.x - (rect.x + rect.width); // text after a check box
    else if (
      r.y >= rect.y + rect.height - 2 &&
      r.y - (rect.y + rect.height) < 18 &&
      r.x < rect.x + rect.width &&
      r.x + r.width > rect.x - 4
    )
      d = 30 + (r.y - (rect.y + rect.height));
    if (d < 200 && (!best || d < best.d)) best = { text, d };
  }
  return best?.text;
}

/** Smart Fill: collect → limit → request → validate → resolve → review → apply (FR-AIF-03…10, SPEC §10.3). */
export class SmartFillService {
  constructor(
    private readonly deps: {
      crypto: CryptoService;
      forms: FormService;
      annotations: AnnotationService;
      stamps: StampService;
      mappings: MappingStore;
      /** Absent or unconfigured → local heuristic only. */
      ai?: AiProvider;
      runs?: RunLog;
      images?: ImageCodec;
    },
  ) {}

  /** Step 1: candidates of the target pages. AcroForm fields win; pages without any get detected areas. */
  async collect(
    doc: PdfDocument,
    pages: PageIndex[],
  ): Promise<{ candidates: SmartCandidate[]; layers: Map<PageIndex, TextLayer> }> {
    const fields = (await doc.listFormFields()).filter(isFillable);
    const layers = new Map<PageIndex, TextLayer>();
    const candidates: SmartCandidate[] = [];
    for (const page of pages) {
      const layer = await doc.getTextLayer(page);
      layers.set(page, layer);
      const here = fields.filter((f) => f.widgets[0]?.page === page);
      for (const field of here) {
        const rect = field.widgets[0]!.rect;
        candidates.push({
          ref: field.id,
          page,
          rect,
          kind: 'acroform',
          fieldType: typeOfCandidate(field),
          name: field.name,
          label: field.label || labelNear(rect, layer) || humanize(field.name),
          options:
            field.options?.map((o) => o.label) ??
            (field.type === 'radio' ? field.widgets.map((w) => w.exportValue ?? '') : undefined),
          field,
        });
      }
      if (here.length === 0) {
        const areas = detectAreas(page, await doc.listObjects(page), layer).map((a, k) => ({
          ...a,
          id: `p${page + 1}-a${k + 1}`,
        }));
        for (const area of areas) {
          candidates.push({
            ref: area.id,
            page,
            rect: area.rect,
            kind: 'detected',
            fieldType: area.kind === 'checkbox' ? 'checkbox' : 'text',
            label: area.label,
            area,
          });
        }
      }
    }
    return { candidates, layers };
  }

  /** Structural hash of the form (names, types, rounded rects) used to remember mappings (FR-AIF-08). */
  async fingerprint(candidates: SmartCandidate[]): Promise<string> {
    const shape = candidates
      .map(
        (c) =>
          `${c.page}|${c.kind}|${c.fieldType}|${c.name ?? ''}|${Math.round(c.rect.x / 4)},${Math.round(c.rect.y / 4)},${Math.round(c.rect.width / 4)},${Math.round(c.rect.height / 4)}`,
      )
      .join('\n');
    return toHex(await this.deps.crypto.sha256(utf8.encode(shape))).slice(0, 40);
  }

  /** FR-AIF-07: local matching of labels to profile keys, labels and aliases. */
  heuristic(candidates: SmartCandidate[], profile: SmartProfile): FieldMapping[] {
    return candidates.map((c) => {
      const texts = [c.label, c.name ? humanize(c.name) : undefined].filter((t): t is string => !!t);
      let best: { key: string; score: number } | undefined;
      for (const f of profile.fields) {
        const names = [f.label, f.key.replace(/_/g, ' '), ...f.aliases];
        const score = Math.max(0, ...texts.flatMap((t) => names.map((n) => tokenSetRatio(t, n))));
        if (!best || score > best.score) best = { key: f.key, score };
      }
      const hit = best && best.score >= HEURISTIC_THRESHOLD ? best : undefined;
      const target = hit ? profile.fields.find((f) => f.key === hit.key) : undefined;
      let transform: TransformId = 'none';
      if (target?.type === 'date' || c.fieldType === 'date') {
        const hint = `${c.label ?? ''}`.toLowerCase();
        transform = /mm[/.-]dd/.test(hint)
          ? 'date_mdy'
          : /yyyy[/.-]mm/.test(hint)
            ? 'date_iso'
            : /dd[/.-]mm|gg[/.-]mm/.test(hint)
              ? 'date_dmy'
              : 'none';
      }
      return {
        ref: c.ref,
        label: c.label ?? c.name ?? '',
        fieldType: c.fieldType,
        profileKey: hit?.key ?? null,
        transform,
        choiceValue: null,
        confidence: hit ? hit.score : (best?.score ?? 0) * 0.5,
      };
    });
  }

  /** Step 2 + 3 input: the request, limited to `maxPages` and without sensitive values in any mode. */
  buildRequest(
    candidates: SmartCandidate[],
    layers: Map<PageIndex, TextLayer>,
    sizes: Map<PageIndex, { width: number; height: number }>,
    profile: SmartProfile,
    mode: 'mapping_only' | 'with_values',
    maxPages = 3,
  ): FormAnalysisRequest {
    const pages = [...new Set(candidates.map((c) => c.page))].slice(0, maxPages);
    const profileKeys: ProfileKeyInfo[] = profile.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      aliases: f.aliases,
      ...(mode === 'with_values' && !f.sensitive && f.value !== '' ? { value: f.value } : {}),
    }));
    let budget = 40_000; // characters of page text, roughly 12 k tokens with the rest of the payload
    return {
      mode,
      pages: pages.map((page) => {
        const layer = layers.get(page);
        const textLines: Array<{ text: string; rect: Rect }> = [];
        for (const l of layer?.lines ?? []) {
          const text = l.text.replace(/_{3,}/g, '___').trim();
          if (!text || budget - text.length < 0) continue;
          budget -= text.length;
          textLines.push({ text, rect: l.rect });
        }
        return {
          page,
          width: sizes.get(page)?.width ?? 612,
          height: sizes.get(page)?.height ?? 792,
          textLines,
        };
      }),
      candidates: candidates
        .filter((c) => pages.includes(c.page))
        .map(({ ref, page, rect, kind, fieldType, name, label: l, options }) => ({
          ref,
          page,
          rect,
          kind,
          fieldType,
          name,
          label: l,
          options,
        })),
      profileKeys,
    };
  }

  /** FR-AIF-04: exactly what would be sent, for the pre-flight dialog. */
  preflight(req: FormAnalysisRequest, profile: SmartProfile): Preflight {
    return {
      mode: req.mode,
      pages: req.pages.map((p) => p.page + 1),
      candidateCount: req.candidates.length,
      textLineCount: req.pages.reduce((n, p) => n + p.textLines.length, 0),
      sampleLabels: req.candidates
        .map((c) => c.label ?? c.name ?? '')
        .filter(Boolean)
        .slice(0, 6),
      keyCount: req.profileKeys.length,
      valueKeys: req.profileKeys.filter((k) => k.value !== undefined).map((k) => k.key),
      withheldKeys:
        req.mode === 'with_values' ? profile.fields.filter((f) => f.sensitive).map((f) => f.key) : [],
      includesImage: !!req.images?.length,
      estimatedTokens: this.deps.ai?.estimateTokens(req) ?? 0,
    };
  }

  /** Step 5: turn mappings into reviewable suggestions with the values resolved locally. */
  resolve(mappings: FieldMapping[], candidates: SmartCandidate[], profile: SmartProfile): Suggestion[] {
    const byRef = new Map(mappings.map((m) => [m.ref, m]));
    return candidates.map((candidate) => {
      const m = byRef.get(candidate.ref);
      const field = m?.profileKey ? profile.fields.find((f) => f.key === m.profileKey) : undefined;
      let value = field ? applyTransform(field.value, m!.transform, profile) : '';
      let score = field ? (m?.confidence ?? 0) : 0;
      const options = candidate.options ?? [];
      if (field && (candidate.fieldType === 'choice' || candidate.fieldType === 'radio')) {
        // Options are matched case-insensitively against export values; an unknown option is no value.
        const wanted = (m?.choiceValue ?? value).trim().toLowerCase();
        const option =
          options.find((o) => o.toLowerCase() === wanted) ??
          options.find(
            (o) =>
              wanted !== '' && (o.toLowerCase().startsWith(wanted) || wanted.startsWith(o.toLowerCase())),
          );
        value = option ?? '';
        if (!option) score = Math.min(score, 0.3);
      } else if (field && candidate.fieldType === 'checkbox') {
        value =
          m!.transform === 'checkbox_false'
            ? 'false'
            : m!.transform === 'checkbox_true' || truthy(field.value)
              ? 'true'
              : 'false';
      }
      if (field && value === '') score = Math.min(score, 0.3);
      const confidence = level(score);
      return {
        ref: candidate.ref,
        page: candidate.page,
        rect: candidate.rect,
        kind: candidate.kind,
        label: m?.label || candidate.label || candidate.name || candidate.ref,
        fieldType: candidate.fieldType,
        profileKey: field ? field.key : null,
        transform: m?.transform ?? 'none',
        choiceValue: m?.choiceValue ?? null,
        value,
        score,
        confidence,
        accepted: !!field && value !== '' && confidence !== 'low',
        candidate,
      };
    });
  }

  /**
   * FR-AIF-03/07/08: analyse the pages. A remembered mapping is used without any request; otherwise
   * the AI when it is configured and wanted, and the local heuristic as fallback (offline, errors).
   */
  async analyze(
    doc: PdfDocument,
    pages: PageIndex[],
    profile: SmartProfile,
    opts: {
      useAi: boolean;
      mode: 'mapping_only' | 'with_values';
      includeImage?: boolean;
      maxPages?: number;
      reanalyze?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<AnalysisResult> {
    if (pages.length === 0) throw new InvalidArgumentError('Choose at least one page');
    const { candidates, layers } = await this.collect(doc, pages);
    const fingerprint = await this.fingerprint(candidates);
    if (candidates.length === 0) return { suggestions: [], source: 'heuristic', fingerprint };

    if (!opts.reanalyze) {
      const stored = await this.deps.mappings.find(fingerprint, profile.id);
      if (stored) {
        const known = new Map(stored.mapping.map((e) => [e.fieldRef, e]));
        const mappings: FieldMapping[] = candidates.map((c) => {
          const e = known.get(c.ref);
          return {
            ref: c.ref,
            label: c.label ?? c.name ?? '',
            fieldType: c.fieldType,
            profileKey: e?.profileKey ?? null,
            transform: (e?.transform ?? 'none') as TransformId,
            choiceValue: e?.choiceValue ?? null,
            confidence: e ? 0.95 : 0,
          };
        });
        return {
          suggestions: this.resolve(mappings, candidates, profile),
          source: 'remembered',
          fingerprint,
        };
      }
    }

    const ai = this.deps.ai;
    let fallbackReason: AnalysisResult['fallbackReason'];
    if (opts.useAi) {
      if (!ai || !(await ai.isConfigured())) {
        fallbackReason = 'notConfigured';
      } else {
        const sizes = new Map<PageIndex, { width: number; height: number }>();
        for (const p of pages) sizes.set(p, (await doc.getPageInfo(p)).size);
        const req = this.buildRequest(candidates, layers, sizes, profile, opts.mode, opts.maxPages);
        if (opts.includeImage && this.deps.images) req.images = await this.pageImages(doc, req, candidates);
        try {
          const out = await ai.analyzeForm(req, opts.signal ?? new AbortController().signal);
          await this.deps.runs?.record({
            model: out.model ?? 'unknown',
            mode: opts.mode,
            includedImage: !!req.images?.length,
            inputTokens: out.usage?.inputTokens,
            outputTokens: out.usage?.outputTokens,
            status: 'ok',
          });
          const all = [...candidates];
          const mappings = [...out.fields];
          // Regions the model found in the image that local detection missed become extra candidates.
          out.newAreas.forEach((a, k) => {
            const size = sizes.get(a.page);
            if (!size) return;
            const rect = {
              x: a.bbox[0] * size.width,
              y: (1 - a.bbox[3]) * size.height,
              width: (a.bbox[2] - a.bbox[0]) * size.width,
              height: (a.bbox[3] - a.bbox[1]) * size.height,
            };
            const ref = `p${a.page + 1}-n${k + 1}`;
            const kind = a.fieldType === 'checkbox' ? 'checkbox' : 'text';
            all.push({
              ref,
              page: a.page,
              rect,
              kind: 'detected',
              fieldType: a.fieldType,
              label: a.label,
              area: { id: ref, page: a.page, rect, kind, label: a.label },
            });
            mappings.push({
              ref,
              label: a.label,
              fieldType: a.fieldType,
              profileKey: a.profileKey,
              transform: 'none',
              confidence: Math.min(a.confidence, 0.8),
            });
          });
          // Candidates beyond the page cap (or skipped by the model) still get a local suggestion.
          const answered = new Set(mappings.map((m) => m.ref));
          mappings.push(
            ...this.heuristic(
              all.filter((c) => !answered.has(c.ref)),
              profile,
            ),
          );
          return { suggestions: this.resolve(mappings, all, profile), source: 'ai', fingerprint };
        } catch (e) {
          if (isFolioError(e) && e.code === 'cancelled') throw e;
          fallbackReason =
            e instanceof AiError
              ? (e.kind as AnalysisResult['fallbackReason'])
              : e instanceof NetworkError
                ? 'offline'
                : 'server';
          await this.deps.runs?.record({
            model: 'unknown',
            mode: opts.mode,
            includedImage: !!req.images?.length,
            status: `error:${fallbackReason}`,
          });
        }
      }
    }
    return {
      suggestions: this.resolve(this.heuristic(candidates, profile), candidates, profile),
      source: 'heuristic',
      fingerprint,
      fallbackReason,
    };
  }

  /** Page images with numbered candidate boxes (set-of-marks), ≤ 1280 px on the long edge, JPEG. */
  private async pageImages(
    doc: PdfDocument,
    req: FormAnalysisRequest,
    candidates: SmartCandidate[],
  ): Promise<NonNullable<FormAnalysisRequest['images']>> {
    const out: NonNullable<FormAnalysisRequest['images']> = [];
    for (const p of req.pages) {
      const scale = Math.min(2, 1280 / Math.max(p.width, p.height));
      const img = await doc.render(p.page, { scale });
      // Box outlines only: digits would need a font rasteriser; ids are tied to boxes by the coordinates in the text payload.
      for (const c of candidates.filter((x) => x.page === p.page)) {
        const x0 = Math.round(c.rect.x * scale);
        const y0 = Math.round((p.height - c.rect.y - c.rect.height) * scale);
        const x1 = Math.round((c.rect.x + c.rect.width) * scale);
        const y1 = Math.round((p.height - c.rect.y) * scale);
        const px = (x: number, y: number): void => {
          if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
          img.data.set([37, 99, 235, 255], (y * img.width + x) * 4);
        };
        for (let x = x0; x <= x1; x++) for (const y of [y0, y0 + 1, y1 - 1, y1]) px(x, y);
        for (let y = y0; y <= y1; y++) for (const x of [x0, x0 + 1, x1 - 1, x1]) px(x, y);
      }
      out.push({
        page: p.page,
        jpeg: await this.deps.images!.encode(img, 'jpeg', { quality: 0.8 }),
        width: img.width,
        height: img.height,
      });
    }
    return out;
  }

  /** Review-panel edits: change the key or type a value; the suggestion becomes a manual, accepted one. */
  edit(
    s: Suggestion,
    change: { profileKey?: string | null; value?: string; accepted?: boolean },
    profile: SmartProfile,
  ): Suggestion {
    const next = { ...s, ...('accepted' in change ? { accepted: !!change.accepted } : {}) };
    if (change.profileKey !== undefined) {
      const [resolved] = this.resolve(
        [
          {
            ref: s.ref,
            label: s.label,
            fieldType: s.fieldType,
            profileKey: change.profileKey,
            transform: s.transform,
            choiceValue: null,
            confidence: 1,
          },
        ],
        [s.candidate],
        profile,
      );
      Object.assign(next, {
        profileKey: resolved!.profileKey,
        value: resolved!.value,
        score: resolved!.score,
        confidence: resolved!.confidence,
        accepted: resolved!.accepted,
      });
    }
    if (change.value !== undefined)
      Object.assign(next, {
        value: change.value,
        accepted: change.value !== '',
        confidence: 'high' as Confidence,
        score: 1,
      });
    return next;
  }
  /** "Apply all high-confidence". */
  acceptHigh(suggestions: Suggestion[]): Suggestion[] {
    return suggestions.map((s) => ({ ...s, accepted: s.confidence === 'high' && s.value !== '' }));
  }
  /** Fields with no matching data, for the "Add to profile" action (FR-AIF-10). */
  unmatched(suggestions: Suggestion[]): Suggestion[] {
    return suggestions.filter((s) => s.profileKey === null);
  }

  /**
   * FR-AIF-06: one undoable step. AcroForm fields get values; detected areas get text boxes or check
   * marks placed inside the detected rectangle.
   */
  apply(
    suggestions: Suggestion[],
    pageSizes: Map<PageIndex, { width: number; height: number }>,
  ): Command | null {
    const accepted = suggestions.filter((s) => s.accepted && s.value !== '');
    const commands: Command[] = [];
    const fills: Array<{ field: FormField; value: FieldValue }> = [];
    for (const s of accepted) {
      const field = s.candidate.field;
      if (field) {
        const value: FieldValue =
          field.type === 'checkbox' ? truthy(s.value) : field.type === 'listbox' ? [s.value] : s.value;
        fills.push({ field, value });
        continue;
      }
      const area = s.candidate.area;
      if (!area) continue;
      if (area.kind === 'checkbox') {
        if (!truthy(s.value)) continue;
        const page = pageSizes.get(s.page) ?? { width: 612, height: 792 };
        const check = BUILTIN_STAMPS.find((b) => b.mark === 'check')!;
        commands.push(
          this.deps.annotations.add(
            s.page,
            this.deps.stamps.annotation(check, { x: 0, y: 0 }, page, area.rect),
          ),
        );
      } else {
        commands.push(this.deps.annotations.add(s.page, this.deps.forms.fromArea(area, s.value)));
      }
    }
    const fill = this.deps.forms.fillMany(fills);
    if (fill) commands.unshift(fill);
    return commands.length
      ? new CompositeCommand(label('cmd.smartFill', { count: accepted.length }), commands)
      : null;
  }

  /** FR-AIF-08: remember what the user accepted so the same form fills instantly next time. */
  async remember(result: AnalysisResult, suggestions: Suggestion[], profile: SmartProfile): Promise<void> {
    const mapping = suggestions
      .filter((s) => s.accepted && s.profileKey)
      .map((s) => ({
        fieldRef: s.ref,
        profileKey: s.profileKey!,
        transform: s.transform,
        choiceValue: s.choiceValue ?? null,
      }));
    if (mapping.length === 0) return;
    await this.deps.mappings.save(
      result.fingerprint,
      profile.id,
      mapping,
      result.source === 'ai' ? 'ai' : result.source === 'remembered' ? 'manual' : 'heuristic',
    );
  }
  forget(result: AnalysisResult, profile: SmartProfile): Promise<void> {
    return this.deps.mappings.forget(result.fingerprint, profile.id);
  }
}
