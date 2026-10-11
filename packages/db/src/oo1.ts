import type { Database } from '@folio/ports';

/** The slice of SQLite WASM's object-oriented API (oo1) this adapter needs. */
export interface Oo1Db {
  exec(opts: { sql: string; bind?: unknown[]; rowMode?: 'object'; returnValue?: 'resultRows'; resultRows?: unknown[] }): unknown;
  changes(): number;
  selectValue(sql: string): unknown;
}

/** `Database` port over SQLite WASM (web build on OPFS; also runs in Node for parity tests). */
export class Oo1Database implements Database {
  private depth = 0;
  constructor(private readonly db: Oo1Db) {
    this.db.exec({ sql: 'PRAGMA foreign_keys=ON' });
  }
  private static bind(params: unknown[] = []): unknown[] {
    return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
  }
  async execute(sql: string, params?: unknown[]): Promise<{ changes: number; lastId?: number }> {
    this.db.exec({ sql, bind: Oo1Database.bind(params) });
    return { changes: this.db.changes(), lastId: Number(this.db.selectValue('SELECT last_insert_rowid()')) };
  }
  async select<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const rows: unknown[] = [];
    this.db.exec({ sql, bind: Oo1Database.bind(params), rowMode: 'object', resultRows: rows });
    return rows as T[];
  }
  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const name = `sp_${this.depth++}`;
    this.db.exec({ sql: `SAVEPOINT ${name}` });
    try {
      const result = await fn(this);
      this.db.exec({ sql: `RELEASE ${name}` });
      return result;
    } catch (e) {
      this.db.exec({ sql: `ROLLBACK TO ${name}; RELEASE ${name}` });
      throw e;
    } finally {
      this.depth--;
    }
  }
}
