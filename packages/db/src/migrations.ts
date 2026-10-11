import type { Database } from '@folio/ports';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// The SQL lives in migrations/*.sql for review and for the Tauri SQL plugin; this module embeds the
// same text so every runtime (Node, SQLite WASM, desktop) applies identical statements.
// `tools/sync-migrations.ts` regenerates the embedded copy and CI fails when they differ.
import { EMBEDDED } from './migrations.generated.ts';
export const MIGRATIONS: Migration[] = EMBEDDED;

/** Splits a migration file into statements (no triggers or string-embedded semicolons are used). */
export function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Applies pending migrations, each inside a transaction, and records them in schema_migrations. */
export async function migrate(db: Database, migrations: Migration[] = MIGRATIONS): Promise<number[]> {
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((await db.select<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    await db.transaction(async (tx) => {
      for (const statement of splitStatements(m.sql)) await tx.execute(statement);
      await tx.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))", [m.version]);
    });
    applied.push(m.version);
  }
  return applied;
}
