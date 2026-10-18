// Shared state of the zero-warning guard (setup.ts). Kept free of vitest imports so that the testkit
// index can export `expectWarnings` to code that runs outside vitest (folio-cli, fixture builds).
export const guard = { allowed: false, seen: [] as string[] };

/** Marks the running test as one that provokes warnings on purpose; they are returned instead of failing it. */
export function expectWarnings(): string[] {
  guard.allowed = true;
  return guard.seen;
}
