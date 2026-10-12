// Command bus semantics that the service tests only touch indirectly: failure rollback, composite
// atomicity, coalescing, redo invalidation, spill-to-storage and dirty tracking (SPEC §8.6).
import { describe, expect, it } from 'vitest';
import type { AppStorage } from '@folio/ports';
import {
  CheckpointStore,
  CompositeCommand,
  History,
  type Command,
  type CommandContext,
  type Invalidation,
} from './history.ts';

/** A "document" that is a single byte array: enough to observe checkpoint restores. */
function fakeDoc(initial = 0) {
  const state = { value: initial, restores: 0 };
  return {
    state,
    doc: {
      snapshot: async () => new Uint8Array([state.value, 0, 0, 0]),
      restore: async (b: Uint8Array) => {
        state.value = b[0]!;
        state.restores++;
      },
    },
  };
}
const label = { key: 'test' };
const make = (s: { value: number }, to: number): Command<number> => ({
  label,
  kind: 'content',
  undo: 'checkpoint',
  apply: async () => ((s.value = to), to),
});
/** A command with a cheap inverse (no checkpoint). */
function inverse(s: { value: number }, delta: number, merge = false): Command<void> {
  const cmd: Command<void> = {
    label,
    kind: 'content',
    apply: async () => void (s.value += delta),
    undo: async () => void (s.value -= delta),
    ...(merge
      ? {
          merge: (next: Command) =>
            (next as Command & { delta?: number }).delta !== undefined
              ? inverse(s, delta + (next as Command & { delta: number }).delta, true)
              : null,
        }
      : {}),
  };
  (cmd as Command & { delta: number }).delta = delta;
  return cmd;
}
const history = (
  d: ReturnType<typeof fakeDoc>,
  extra: Partial<ConstructorParameters<typeof History>[0]> = {},
) => new History({ doc: d.doc as never, engine: {} as never, ...extra });

class CountingStorage implements AppStorage {
  readonly items = new Map<string, Uint8Array>();
  writes = 0;
  async write(k: string, d: Uint8Array) {
    this.writes++;
    this.items.set(k, d.slice());
  }
  async read(k: string) {
    return this.items.get(k)?.slice() ?? null;
  }
  async remove(k: string) {
    this.items.delete(k);
  }
  async list(p: string) {
    return [...this.items.keys()].filter((k) => k.startsWith(p));
  }
}

describe('History.execute @FR-APP-05', () => {
  it('restores the document and drops the checkpoint when a checkpoint command throws', async () => {
    const d = fakeDoc(5);
    const h = history(d);
    const seen: Invalidation[] = [];
    h.events.on((e) => e.type === 'invalidated' && seen.push(e.invalidation));
    const bad: Command = {
      label,
      kind: 'content',
      undo: 'checkpoint',
      apply: async () => {
        d.state.value = 99;
        throw new Error('boom');
      },
    };
    await expect(h.execute(bad)).rejects.toThrow('boom');
    expect(d.state.value).toBe(5);
    expect(h.checkpoints.count).toBe(0);
    expect(h.state).toMatchObject({ canUndo: false, dirty: false });
    expect(seen).toEqual([{ kind: 'all' }]);
  });

  it('keeps working after a failed command (the queue is not poisoned)', async () => {
    const d = fakeDoc();
    const h = history(d);
    const failing = h.execute({
      label,
      kind: 'content',
      undo: 'checkpoint',
      apply: async () => {
        throw new Error('x');
      },
    });
    const ok = h.execute(make(d.state, 7));
    await expect(failing).rejects.toThrow('x');
    await expect(ok).resolves.toBe(7);
    expect(h.state.done).toHaveLength(1);
  });

  it('a new command discards the redo stack and frees its checkpoints', async () => {
    const d = fakeDoc();
    const h = history(d);
    await h.execute(make(d.state, 1));
    await h.execute(make(d.state, 2));
    await h.undo();
    expect(h.state.canRedo).toBe(true);
    expect(h.checkpoints.count).toBe(2);
    await h.execute(make(d.state, 3));
    expect(h.state).toMatchObject({ canRedo: false });
    expect(h.state.done).toHaveLength(2);
    expect(h.checkpoints.count).toBe(2);
    expect(await h.redo()).toBe(false);
  });

  it('coalesces mergeable commands without a checkpoint into one undo step', async () => {
    const d = fakeDoc();
    const h = history(d);
    await h.execute(inverse(d.state, 1, true));
    await h.execute(inverse(d.state, 2, true));
    await h.execute(inverse(d.state, 4, true));
    expect(d.state.value).toBe(7);
    expect(h.state.done).toHaveLength(1);
    await h.undo();
    expect(d.state.value).toBe(0);
    await h.redo();
    expect(d.state.value).toBe(7);
  });

  it('never coalesces across a checkpoint command', async () => {
    const d = fakeDoc();
    const h = history(d);
    await h.execute(inverse(d.state, 1, true));
    await h.execute(make(d.state, 10));
    await h.execute(inverse(d.state, 1, true));
    expect(h.state.done).toHaveLength(3);
  });
});

describe('History.undo/redo @FR-APP-05', () => {
  it('returns false on empty stacks', async () => {
    const h = history(fakeDoc());
    expect(await h.undo()).toBe(false);
    expect(await h.redo()).toBe(false);
  });

  it('refuses to undo when the checkpoint was lost (no storage, over budget)', async () => {
    const d = fakeDoc();
    const h = history(d, { checkpointBudgetBytes: 5 });
    await h.execute(make(d.state, 1)); // 4 bytes
    await h.execute(make(d.state, 2)); // pushes the first out; nowhere to spill
    expect(h.checkpoints.count).toBe(1);
    expect(await h.undo()).toBe(true); // newest is intact
    expect(d.state.value).toBe(1);
    expect(await h.undo()).toBe(false); // oldest was dropped
    expect(h.state.canUndo).toBe(true);
    expect(d.state.value).toBe(1);
  });

  it('mixes checkpoint and inverse commands in one timeline', async () => {
    const d = fakeDoc();
    const h = history(d);
    await h.execute(inverse(d.state, 5));
    await h.execute(make(d.state, 100));
    await h.execute(inverse(d.state, 1));
    await h.goTo(0);
    expect(d.state.value).toBe(0);
    await h.goTo(3);
    expect(d.state.value).toBe(101);
    await h.goTo(1);
    expect(d.state.value).toBe(5);
  });

  it('goTo clamps to what can be undone or redone', async () => {
    const d = fakeDoc();
    const h = history(d);
    await h.execute(make(d.state, 1));
    await h.goTo(-3);
    expect(h.state.done).toHaveLength(0);
    await h.goTo(50);
    expect(h.state.done).toHaveLength(1);
  });

  it('lists undone entries with the next redo first', async () => {
    const d = fakeDoc();
    const h = history(d);
    for (const n of [1, 2, 3]) await h.execute({ ...make(d.state, n), label: { key: `step${n}` } });
    await h.goTo(0);
    expect(h.state.undone.map((e) => e.label.key)).toEqual(['step1', 'step2', 'step3']);
  });
});

describe('dirty tracking @FR-APP-04 @FR-APP-07', () => {
  it('is clean after markSaved, dirty after a change, clean again after undoing back to the saved point', async () => {
    const d = fakeDoc();
    const h = history(d);
    await h.execute(make(d.state, 1));
    expect(h.dirty).toBe(true);
    h.markSaved();
    expect(h.dirty).toBe(false);
    await h.execute(make(d.state, 2));
    expect(h.dirty).toBe(true);
    await h.undo();
    expect(h.dirty).toBe(false);
    await h.undo();
    expect(h.dirty).toBe(true);
    await h.redo();
    expect(h.dirty).toBe(false);
  });

  it('revision changes with every edit so recovery snapshots know what is new', async () => {
    const d = fakeDoc();
    const h = history(d);
    const r0 = h.revision;
    await h.execute(make(d.state, 1));
    const r1 = h.revision;
    await h.undo();
    expect(new Set([r0, r1, h.revision]).size).toBeGreaterThanOrEqual(2);
  });

  it('reset forgets the timeline, frees checkpoints and marks the document changed', async () => {
    const d = fakeDoc();
    const h = history(d);
    await h.execute(make(d.state, 1));
    h.markSaved();
    await h.reset();
    expect(h.state).toMatchObject({ canUndo: false, canRedo: false, done: [], undone: [] });
    expect(h.checkpoints.count).toBe(0);
    expect(h.dirty).toBe(true);
  });

  it('emits "changed" with the new state for each step', async () => {
    const d = fakeDoc();
    const h = history(d);
    const states: boolean[] = [];
    const off = h.events.on((e) => e.type === 'changed' && states.push(e.state.canUndo));
    await h.execute(make(d.state, 1));
    await h.undo();
    off();
    await h.redo();
    expect(states).toEqual([true, false]);
  });
});

describe('CompositeCommand @FR-APP-05', () => {
  it('rolls back applied members in reverse order when a later one fails (inverse members)', async () => {
    const log: string[] = [];
    const member = (n: string, fail = false): Command<string> => ({
      label,
      kind: 'annotation',
      apply: async () => {
        if (fail) throw new Error(`fail ${n}`);
        log.push(`do ${n}`);
        return n;
      },
      undo: async () => void log.push(`undo ${n}`),
    });
    const c = new CompositeCommand(label, [member('a'), member('b'), member('c', true), member('d')]);
    expect(c.undo).not.toBe('checkpoint');
    const ctx = {} as CommandContext;
    await expect(c.apply(ctx)).rejects.toThrow('fail c');
    expect(log).toEqual(['do a', 'do b', 'undo b', 'undo a']);
  });

  it('undoes members newest first and returns every result', async () => {
    const log: string[] = [];
    const member = (n: string): Command<string> => ({
      label,
      kind: 'content',
      apply: async () => n,
      undo: async () => void log.push(n),
    });
    const c = new CompositeCommand(label, [member('a'), member('b'), member('c')]);
    expect(await c.apply({} as CommandContext)).toEqual(['a', 'b', 'c']);
    await (c.undo as (ctx: CommandContext) => Promise<void>)({} as CommandContext);
    expect(log).toEqual(['c', 'b', 'a']);
  });

  it('is a checkpoint command as soon as one member needs a checkpoint, and the history rolls it back', async () => {
    const d = fakeDoc(3);
    const h = history(d);
    const c = new CompositeCommand(label, [
      inverse(d.state, 10),
      {
        label,
        kind: 'content',
        undo: 'checkpoint',
        apply: async () => {
          throw new Error('late');
        },
      },
    ]);
    expect(c.undo).toBe('checkpoint');
    await expect(h.execute(c)).rejects.toThrow('late');
    expect(d.state.value).toBe(3); // restored from the checkpoint taken before the composite
  });

  it('defaults its kind to content when empty', () => {
    expect(new CompositeCommand(label, []).kind).toBe('content');
  });
});

describe('CheckpointStore spill @FR-APP-05 @NFR-07', () => {
  const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

  it('spills the oldest checkpoints to storage over budget and reads them back', async () => {
    const storage = new CountingStorage();
    const s = new CheckpointStore({ budgetBytes: 250, storage, sessionId: 's1' });
    const a = await s.put(bytes(100, 1));
    const b = await s.put(bytes(100, 2));
    const c = await s.put(bytes(100, 3));
    expect(s.memoryBytes).toBeLessThanOrEqual(250);
    expect(s.spilledCount()).toBe(1);
    expect([...storage.items.keys()]).toEqual([`history/s1/${a}.pdf`]);
    expect((await s.get(a))[0]).toBe(1);
    expect((await s.get(b))[0]).toBe(2);
    expect((await s.get(c))[0]).toBe(3);
  });

  it('never spills the checkpoint that was just taken, even if it alone exceeds the budget', async () => {
    const storage = new CountingStorage();
    const s = new CheckpointStore({ budgetBytes: 10, storage, sessionId: 's' });
    const id = await s.put(bytes(100));
    expect(storage.writes).toBe(0);
    expect(s.has(id)).toBe(true);
    expect((await s.get(id)).length).toBe(100);
  });

  it('removes spill files on drop and clear', async () => {
    const storage = new CountingStorage();
    const s = new CheckpointStore({ budgetBytes: 100, storage, sessionId: 's' });
    const ids = [await s.put(bytes(100)), await s.put(bytes(100)), await s.put(bytes(100))];
    expect(storage.items.size).toBe(2);
    await s.drop(ids[0]!);
    expect(storage.items.size).toBe(1);
    await s.drop(ids[0]!); // idempotent
    await s.clear();
    expect([storage.items.size, s.count, s.memoryBytes]).toEqual([0, 0, 0]);
  });

  it('reports unknown and vanished checkpoints with a clear error', async () => {
    const storage = new CountingStorage();
    const s = new CheckpointStore({ budgetBytes: 100, storage, sessionId: 's' });
    await expect(s.get(42)).rejects.toThrow('Unknown checkpoint 42');
    const a = await s.put(bytes(100));
    await s.put(bytes(100));
    storage.items.clear(); // external cleanup removed the spill file
    await expect(s.get(a)).rejects.toThrow(`Checkpoint ${a} is missing from storage`);
  });

  it('dispose frees everything', async () => {
    const d = fakeDoc();
    const storage = new CountingStorage();
    const h = history(d, { storage, checkpointBudgetBytes: 4, sessionId: 'x' });
    await h.execute(make(d.state, 1));
    await h.execute(make(d.state, 2));
    expect(storage.items.size).toBe(1);
    await h.dispose();
    expect(storage.items.size).toBe(0);
  });

  it('undo through a spilled checkpoint restores the exact earlier state', async () => {
    const d = fakeDoc(9);
    const storage = new CountingStorage();
    const h = history(d, { storage, checkpointBudgetBytes: 4, sessionId: 'x' });
    await h.execute(make(d.state, 1));
    await h.execute(make(d.state, 2));
    await h.execute(make(d.state, 3));
    expect(h.checkpoints.spilledCount()).toBeGreaterThan(0);
    await h.goTo(0);
    expect(d.state.value).toBe(9);
  });
});
