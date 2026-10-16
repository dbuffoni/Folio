import { utf8 } from '@folio/core';
import type { AppStorage, Clock, PdfDocument } from '@folio/ports';

export interface RecoveryState {
  sessionId: string;
  /** File name shown in the "Restore unsaved changes" prompt. */
  name: string;
  /** Path of the original file, when known (desktop). */
  path?: string;
  savedAt: string;
  pageCount: number;
  /** History revision the snapshot corresponds to. */
  revision: number;
  view?: { page: number; zoom: number };
}
const PREFIX = 'recovery/';

/** Auto-recovery snapshots in private app storage (FR-APP-06, NFR-07). No PDF bytes go to the database. */
export class RecoveryService {
  private lastRevision = new Map<string, number>();
  constructor(private readonly deps: { storage: AppStorage; clock: Clock }) {}

  /** Writes a snapshot unless this revision was already saved. Returns true when something was written. */
  async snapshot(doc: PdfDocument, state: Omit<RecoveryState, 'savedAt' | 'pageCount'>): Promise<boolean> {
    if (this.lastRevision.get(state.sessionId) === state.revision) return false;
    const bytes = await doc.snapshot();
    const full: RecoveryState = { ...state, savedAt: this.deps.clock.now().toISOString(), pageCount: doc.pageCount };
    // PDF first, then the state file: a state file always points at a complete PDF.
    await this.deps.storage.write(`${PREFIX}${state.sessionId}.pdf`, bytes);
    await this.deps.storage.write(`${PREFIX}${state.sessionId}.json`, utf8.encode(JSON.stringify(full)));
    this.lastRevision.set(state.sessionId, state.revision);
    return true;
  }

  /** Snapshots left behind by a previous run, newest first. */
  async pending(): Promise<RecoveryState[]> {
    const out: RecoveryState[] = [];
    for (const key of await this.deps.storage.list(PREFIX)) {
      if (!key.endsWith('.json')) continue;
      try {
        const raw = await this.deps.storage.read(key);
        const state = JSON.parse(utf8.decode(raw!)) as RecoveryState;
        if (typeof state.sessionId === 'string' && (await this.deps.storage.read(`${PREFIX}${state.sessionId}.pdf`))) out.push(state);
      } catch {
        // A torn state file is ignored; its PDF is cleaned up by `discard`.
      }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async load(sessionId: string): Promise<Uint8Array | null> {
    return this.deps.storage.read(`${PREFIX}${sessionId}.pdf`);
  }

  /** Call after a successful save, a clean close, or when the user declines to restore. */
  async discard(sessionId: string): Promise<void> {
    this.lastRevision.delete(sessionId);
    await this.deps.storage.remove(`${PREFIX}${sessionId}.json`);
    await this.deps.storage.remove(`${PREFIX}${sessionId}.pdf`);
  }
  async discardAll(): Promise<void> {
    for (const key of await this.deps.storage.list(PREFIX)) await this.deps.storage.remove(key);
    this.lastRevision.clear();
  }
}

export interface Ticker {
  /** Calls `fn` every `ms`; returns a cancel function. */
  every(ms: number, fn: () => void): () => void;
}

const MAX_DEFERRALS = 3;

/** Drives periodic snapshots for the open sessions while they are dirty. */
export class RecoveryScheduler {
  private cancel?: () => void;
  private running = false;
  constructor(
    private readonly recovery: RecoveryService,
    private readonly ticker: Ticker,
    private readonly sessions: () => Array<{ doc: PdfDocument; dirty: boolean; state: Omit<RecoveryState, 'savedAt' | 'pageCount'> }>,
    private readonly onError: (e: unknown) => void = () => undefined,
    /** True while the user is scrolling or typing: a snapshot serialises the whole PDF in the engine worker, which would stall renders. */
    private readonly busy: () => boolean = () => false,
  ) {}
  private deferred = 0;

  start(intervalSec: number): void {
    this.stop();
    this.cancel = this.ticker.every(intervalSec * 1000, () => void this.scheduled());
  }
  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }
  /** A timer pass: waits for a pause in the user's activity, but never more than `MAX_DEFERRALS` intervals. */
  private async scheduled(): Promise<void> {
    if (this.busy() && this.deferred < MAX_DEFERRALS) {
      this.deferred++;
      return;
    }
    this.deferred = 0;
    await this.tick();
  }
  /** One pass; exposed so tests and "before risky operation" hooks can force it. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let written = 0;
    try {
      for (const s of this.sessions()) {
        if (!s.dirty) continue;
        try {
          if (await this.recovery.snapshot(s.doc, s.state)) written++;
        } catch (e) {
          this.onError(e);
        }
      }
    } finally {
      this.running = false;
    }
    return written;
  }
}
