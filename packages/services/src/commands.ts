import { msg, type Command, type CommandContext, type CommandKind, type Invalidation, type Msg } from '@folio/core';

/** Command whose undo restores the snapshot taken by the history before `apply`. */
export function checkpointCommand<R>(
  label: Msg,
  kind: CommandKind,
  apply: (ctx: CommandContext) => Promise<R>,
  invalidation: Invalidation = { kind: 'all' },
): Command<R> {
  return {
    label,
    kind,
    undo: 'checkpoint',
    async apply(ctx) {
      const result = await apply(ctx);
      ctx.invalidate(invalidation);
      return result;
    },
  };
}

/** Command with a real inverse. Both directions report the same invalidation. */
export function inverseCommand<R>(
  label: Msg,
  kind: CommandKind,
  apply: (ctx: CommandContext) => Promise<R>,
  undo: (ctx: CommandContext) => Promise<void>,
  invalidation: Invalidation,
  merge?: Command['merge'],
): Command<R> {
  return {
    label,
    kind,
    async apply(ctx) {
      const result = await apply(ctx);
      ctx.invalidate(invalidation);
      return result;
    },
    async undo(ctx) {
      await undo(ctx);
      ctx.invalidate(invalidation);
    },
    merge,
  };
}

export const label = msg;
