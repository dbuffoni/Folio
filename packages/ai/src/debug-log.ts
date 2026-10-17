import { Emitter } from '@folio/core';

/** One request to the AI service and what came back, kept in memory for the debug window. */
export interface AiExchange {
  id: number;
  /** ISO time the request was sent. */
  at: string;
  /** What the request was for: Smart Fill, scan reading, tables, model list. */
  kind: string;
  method: 'GET' | 'POST';
  url: string;
  model: string;
  /** The JSON body as sent; page images are replaced by their size. */
  request: unknown;
  /** HTTP status, or null when no answer came (offline, timeout). */
  status: number | null;
  /** The raw answer body, or the error message when there was none. */
  response: string;
  durationMs: number;
}

const MAX_ENTRIES = 50;

/** Replaces inline images (`data:image/...;base64,...`) with a short note so the log stays readable. */
export function redactImages(value: unknown): unknown {
  if (typeof value === 'string') return value.startsWith('data:image/') ? `[image, ${value.length} characters of base64 left out]` : value;
  if (Array.isArray(value)) return value.map(redactImages);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactImages(v)]));
  return value;
}

/**
 * The last requests of this session. It lives in memory only: nothing is written to disk or sent anywhere,
 * and the log is gone when the app closes. Authorization headers are never part of it.
 */
export class AiExchangeLog {
  readonly changed = new Emitter<void>();
  private items: AiExchange[] = [];
  private next = 1;

  record(entry: Omit<AiExchange, 'id'>): void {
    this.items.push({ ...entry, id: this.next++ });
    if (this.items.length > MAX_ENTRIES) this.items.splice(0, this.items.length - MAX_ENTRIES);
    this.changed.emit();
  }
  /** Newest first. */
  list(): AiExchange[] {
    return [...this.items].reverse();
  }
  clear(): void {
    this.items = [];
    this.changed.emit();
  }
}

/** Plain text of the chosen exchanges (and optionally the document text), ready to paste into a conversation. */
export function formatExchanges(entries: AiExchange[], opts: { documentText?: string } = {}): string {
  const parts = entries.map((e) => {
    const answer = tryParse(e.response);
    return [
      `=== #${e.id} ${e.kind} · ${e.at} · ${e.method} ${e.url} · model ${e.model} · ${e.status === null ? 'no answer' : `HTTP ${e.status}`} · ${e.durationMs} ms ===`,
      '--- request ---',
      JSON.stringify(expandJson(e.request), null, 2),
      '--- response ---',
      typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2),
    ].join('\n');
  });
  if (opts.documentText !== undefined) parts.push(['=== document text (text layer and OCR) ===', opts.documentText].join('\n'));
  return parts.join('\n\n');
}
function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Strings that hold JSON (the payload travels as one) are shown as the objects they are, so they can be read. */
function expandJson(value: unknown): unknown {
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      const parsed = tryParse(t);
      if (typeof parsed !== 'string') return expandJson(parsed);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(expandJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandJson(v)]));
  return value;
}
