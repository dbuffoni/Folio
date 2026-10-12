import type { AppStorage, PageIndex, PdfDocument, PdfEngine } from '@folio/ports';
import { Emitter } from './events.ts';
import type { Msg } from './msg.ts';

/** What a command touched, so views know what to re-render. */
export type Invalidation =
  | { kind: 'pages'; pages: PageIndex[] }
  | { kind: 'structure' } // page count/order/size changed
  | { kind: 'annotations'; pages: PageIndex[] }
  | { kind: 'form' }
  | { kind: 'meta' }
  | { kind: 'all' };

export interface CommandContext {
  readonly doc: PdfDocument;
  readonly engine: PdfEngine;
  invalidate(i: Invalidation): void;
}

export type CommandKind = 'structural' | 'content' | 'annotation' | 'form' | 'meta';

/**
 * A reversible document change (SPEC §8.6).
 *
 * `undo: 'checkpoint'` asks the history to snapshot the document before `apply` and to restore that
 * snapshot on undo. Commands with a cheap inverse implement `undo` as a function instead.
 */
export interface Command<R = unknown> {
  readonly label: Msg;
  readonly kind: CommandKind;
  apply(ctx: CommandContext): Promise<R>;
  readonly undo: 'checkpoint' | ((ctx: CommandContext) => Promise<void>);
  /** Coalesce with the next command (drag moves, typing). Return the merged command or null. */
  merge?(next: Command): Command | null;
}

/** Several commands as one undo step (Smart Fill, split, apply-to-many). */
export class CompositeCommand implements Command<unknown[]> {
  readonly kind: CommandKind;
  readonly undo: 'checkpoint' | ((ctx: CommandContext) => Promise<void>);
  constructor(
    readonly label: Msg,
    private readonly commands: readonly Command[],
  ) {
    this.kind = commands[0]?.kind ?? 'content';
    if (commands.some((c) => c.undo === 'checkpoint')) {
      this.undo = 'checkpoint';
    } else {
      this.undo = async (ctx) => {
        for (const c of [...commands].reverse()) await (c.undo as (ctx: CommandContext) => Promise<void>)(ctx);
      };
    }
  }
  async apply(ctx: CommandContext): Promise<unknown[]> {
    const done: Command[] = [];
    const results: unknown[] = [];
    try {
      for (const c of this.commands) {
        results.push(await c.apply(ctx));
        done.push(c);
      }
    } catch (e) {
      // Roll back the part that was applied when every member has a real inverse;
      // checkpoint composites are rolled back by the history itself.
      if (this.undo !== 'checkpoint') {
        for (const c of done.reverse()) await (c.undo as (ctx: CommandContext) => Promise<void>)(ctx);
      }
      throw e;
    }
    return results;
  }
}

// ---- checkpoint storage ----------------------------------------------------------------------

interface Checkpoint {
  id: number;
  size: number;
  bytes?: Uint8Array; // in memory
  spillKey?: string; // spilled to AppStorage
}

/** Keeps undo checkpoints within a memory budget; the oldest are spilled to app storage (SPEC §8.6). */
export class CheckpointStore {
  private items = new Map<number, Checkpoint>();
  private nextId = 1;
  private inMemory = 0;
  constructor(
    private readonly opts: { budgetBytes: number; storage?: AppStorage; sessionId: string },
  ) {}

  get memoryBytes(): number {
    return this.inMemory;
  }
  get count(): number {
    return this.items.size;
  }
  spilledCount(): number {
    return [...this.items.values()].filter((c) => c.spillKey).length;
  }

  async put(bytes: Uint8Array): Promise<number> {
    const cp: Checkpoint = { id: this.nextId++, size: bytes.length, bytes };
    this.items.set(cp.id, cp);
    this.inMemory += bytes.length;
    await this.enforceBudget(cp.id);
    return cp.id;
  }
  async get(id: number): Promise<Uint8Array> {
    const cp = this.items.get(id);
    if (!cp) throw new Error(`Unknown checkpoint ${id}`);
    if (cp.bytes) return cp.bytes;
    const bytes = await this.opts.storage!.read(cp.spillKey!);
    if (!bytes) throw new Error(`Checkpoint ${id} is missing from storage`);
    return bytes;
  }
  async drop(id: number): Promise<void> {
    const cp = this.items.get(id);
    if (!cp) return;
    this.items.delete(id);
    if (cp.bytes) this.inMemory -= cp.size;
    if (cp.spillKey) await this.opts.storage!.remove(cp.spillKey);
  }
  async clear(): Promise<void> {
    for (const id of [...this.items.keys()]) await this.drop(id);
  }

  private async enforceBudget(keep: number): Promise<void> {
    if (this.inMemory <= this.opts.budgetBytes) return;
    for (const cp of this.items.values()) {
      if (this.inMemory <= this.opts.budgetBytes) break;
      if (!cp.bytes || cp.id === keep) continue;
      if (this.opts.storage) {
        cp.spillKey = `history/${this.opts.sessionId}/${cp.id}.pdf`;
        await this.opts.storage.write(cp.spillKey, cp.bytes);
      } else {
        // No storage to spill to: the oldest checkpoint is lost and its entry can no longer be undone.
        this.items.delete(cp.id);
      }
      this.inMemory -= cp.size;
      cp.bytes = undefined;
    }
  }
  has(id: number): boolean {
    return this.items.has(id);
  }
}

// ---- history ---------------------------------------------------------------------------------

export interface HistoryEntry {
  readonly label: Msg;
  readonly kind: CommandKind;
}
export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** Applied entries, oldest first. */
  done: HistoryEntry[];
  /** Undone entries that can be redone, next redo first. */
  undone: HistoryEntry[];
  dirty: boolean;
}
export type HistoryEvent =
  | { type: 'changed'; state: HistoryState }
  | { type: 'invalidated'; invalidation: Invalidation };

interface Record_ {
  command: Command;
  checkpoint?: number;
  /** Monotonic id used for dirty tracking. */
  rev: number;
}

export interface HistoryOptions {
  doc: PdfDocument;
  engine: PdfEngine;
  sessionId?: string;
  storage?: AppStorage;
  /** Memory budget for checkpoints, default 256 MB. */
  checkpointBudgetBytes?: number;
}

/**
 * Command bus + unlimited undo/redo for one document (FR-APP-05).
 * All mutations are serialised: `execute`, `undo` and `redo` queue behind each other.
 */
export class History {
  readonly events = new Emitter<HistoryEvent>();
  readonly checkpoints: CheckpointStore;
  private doneStack: Record_[] = [];
  private undoneStack: Record_[] = [];
  private rev = 0;
  private nextRev = 1;
  private savedRev = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly ctx: CommandContext;

  constructor(private readonly opts: HistoryOptions) {
    this.checkpoints = new CheckpointStore({
      budgetBytes: opts.checkpointBudgetBytes ?? 256 * 1024 * 1024,
      storage: opts.storage,
      sessionId: opts.sessionId ?? 'session',
    });
    this.ctx = {
      doc: opts.doc,
      engine: opts.engine,
      invalidate: (invalidation) => this.events.emit({ type: 'invalidated', invalidation }),
    };
  }

  get state(): HistoryState {
    const entry = (r: Record_): HistoryEntry => ({ label: r.command.label, kind: r.command.kind });
    return {
      canUndo: this.doneStack.length > 0,
      canRedo: this.undoneStack.length > 0,
      done: this.doneStack.map(entry),
      undone: [...this.undoneStack].reverse().map(entry),
      dirty: this.rev !== this.savedRev,
    };
  }
  get dirty(): boolean {
    return this.rev !== this.savedRev;
  }
  /** Revision counter: changes whenever the document content changes (used by recovery). */
  get revision(): number {
    return this.rev;
  }
  /** Call after a successful save. */
  markSaved(): void {
    this.savedRev = this.rev;
    this.changed();
  }

  execute<R>(command: Command<R>): Promise<R> {
    return this.enqueue(async () => {
      let checkpoint: number | undefined;
      if (command.undo === 'checkpoint') checkpoint = await this.checkpoints.put(await this.opts.doc.snapshot());
      let result: R;
      try {
        result = await command.apply(this.ctx);
      } catch (e) {
        if (checkpoint !== undefined) {
          // A failed checkpoint command may have left the document half-changed: put it back.
          await this.opts.doc.restore(await this.checkpoints.get(checkpoint));
          await this.checkpoints.drop(checkpoint);
          this.ctx.invalidate({ kind: 'all' });
        }
        throw e;
      }
      for (const r of this.undoneStack) if (r.checkpoint !== undefined) await this.checkpoints.drop(r.checkpoint);
      this.undoneStack = [];

      const last = this.doneStack[this.doneStack.length - 1];
      const merged = last && checkpoint === undefined && last.checkpoint === undefined ? last.command.merge?.(command) : null;
      if (merged && last) {
        last.command = merged;
        last.rev = this.nextRev++;
        this.rev = last.rev;
      } else {
        const rec: Record_ = { command, checkpoint, rev: this.nextRev++ };
        this.doneStack.push(rec);
        this.rev = rec.rev;
      }
      this.changed();
      return result;
    });
  }

  undo(): Promise<boolean> {
    return this.enqueue(async () => {
      const rec = this.doneStack[this.doneStack.length - 1];
      if (!rec) return false;
      if (rec.command.undo === 'checkpoint') {
        if (rec.checkpoint === undefined || !this.checkpoints.has(rec.checkpoint)) return false;
        await this.opts.doc.restore(await this.checkpoints.get(rec.checkpoint));
        this.ctx.invalidate({ kind: 'all' });
      } else {
        await rec.command.undo(this.ctx);
      }
      this.doneStack.pop();
      this.undoneStack.push(rec);
      this.rev = this.doneStack[this.doneStack.length - 1]?.rev ?? 0;
      this.changed();
      return true;
    });
  }

  redo(): Promise<boolean> {
    return this.enqueue(async () => {
      const rec = this.undoneStack[this.undoneStack.length - 1];
      if (!rec) return false;
      await rec.command.apply(this.ctx);
      this.undoneStack.pop();
      this.doneStack.push(rec);
      this.rev = rec.rev;
      this.changed();
      return true;
    });
  }

  /** Undo or redo until `done` has exactly `length` entries (click in the history list). */
  async goTo(length: number): Promise<void> {
    while (this.doneStack.length > length && (await this.undo())) {
      /* keep undoing */
    }
    while (this.doneStack.length < length && (await this.redo())) {
      /* keep redoing */
    }
  }

  /** Forget everything (document replaced, e.g. after recovery restore). */
  async reset(): Promise<void> {
    await this.enqueue(async () => {
      this.doneStack = [];
      this.undoneStack = [];
      await this.checkpoints.clear();
      this.rev = this.nextRev++;
      this.changed();
    });
  }
  async dispose(): Promise<void> {
    await this.checkpoints.clear();
  }

  /** Resolves once every command, undo and redo requested so far has finished. */
  async idle(): Promise<void> {
    let seen: Promise<unknown>;
    do {
      seen = this.queue;
      await seen;
    } while (seen !== this.queue);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
  private changed(): void {
    this.events.emit({ type: 'changed', state: this.state });
  }
}
