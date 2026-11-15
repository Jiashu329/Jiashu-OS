import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementSync } from 'node:sqlite';

const BUSY_TIMEOUT_MS = 5_000;

export function databasePath(value = process.env.SELFHOST_DB_PATH ?? '/data/app.sqlite3'): string {
  if (!isAbsolute(value) || value.includes('\0')) throw new Error('SELFHOST_DB_PATH must be an absolute file path');
  return value;
}

// SQLite itself finds statement boundaries, including trigger bodies and quoted
// semicolons. This helper only consumes separators between complete statements.
export function sqlWithoutLeadingComments(sql: string): string {
  let rest = sql;
  for (;;) {
    rest = rest.replace(/^[\s;]+/, '');
    if (rest.startsWith('--')) {
      const newline = rest.indexOf('\n');
      rest = newline < 0 ? '' : rest.slice(newline + 1);
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      if (end < 0) throw new Error('Unterminated SQL comment');
      rest = rest.slice(end + 2);
    } else return rest;
  }
}

function forbidTransactionControl(sql: string): void {
  if (/^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|VACUUM|PRAGMA)\b/i.test(sqlWithoutLeadingComments(sql))) {
    throw new Error('Transaction and connection control SQL must use the administration interface');
  }
}

function binding(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  throw new TypeError('D1 bindings must be null, finite numbers, strings, integers or binary data');
}

function numeric(value: number | bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError('SQLite integer exceeds the safe JavaScript integer range');
  return number;
}

function output(value: unknown): unknown {
  return typeof value === 'bigint' ? numeric(value) : value;
}

type ArrayStatement = StatementSync & { setReturnArrays(enabled: boolean): void };
type Bound = { owner: SQLiteD1Database; sql: string; values: SQLInputValue[] };
const statements = new WeakMap<object, Bound>();

class SQLiteD1PreparedStatement implements D1PreparedStatement {
  constructor(owner: SQLiteD1Database, sql: string, values: SQLInputValue[] = []) {
    statements.set(this, { owner, sql, values });
  }

  bind(...values: unknown[]): D1PreparedStatement {
    const state = statements.get(this)!;
    return new SQLiteD1PreparedStatement(state.owner, state.sql, values.map(binding));
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const state = statements.get(this)!;
    const result = state.owner.execute(state);
    const row = result.results[0];
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!Object.hasOwn(row as object, column)) throw new Error('D1_COLUMN_NOTFOUND');
    return (row as Record<string, unknown>)[column] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const state = statements.get(this)!;
    return state.owner.execute(state) as D1Result<T>;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const state = statements.get(this)!;
    const { rows, columns } = state.owner.executeArrays(state);
    return options?.columnNames ? [columns, ...rows as T[]] : rows as T[];
  }
}

/** The D1 query subset used by the application, backed by one Node 24 connection. */
export class SQLiteD1Database implements D1Database {
  readonly sqlite: DatabaseSync;
  readonly path: string;
  private closed = false;
  private inTransaction = false;

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    if (path !== ':memory:') databasePath(path);
    this.path = path;
    if (path !== ':memory:' && !options.readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sqlite = new DatabaseSync(path, {
      readOnly: options.readOnly ?? false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      // SQLite derives WAL/SHM permissions from the main file. Tighten it before
      // enabling WAL so newly created sidecars never start world-readable.
      if (path !== ':memory:' && !options.readOnly) chmodSync(path, 0o600);
      this.sqlite.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys=ON;`);
      if (!options.readOnly) {
        this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        if (path !== ':memory:') {
          for (const sidecar of [`${path}-wal`, `${path}-shm`]) if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
        }
      }
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLite database is closed');
  }

  private statement(sql: string): ArrayStatement {
    this.assertOpen();
    forbidTransactionControl(sql);
    const statement = this.sqlite.prepare(sql) as ArrayStatement;
    if (sqlWithoutLeadingComments(sql.slice(statement.sourceSQL.length))) throw new Error('D1 prepare accepts exactly one SQL statement');
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    return statement;
  }

  prepare(sql: string): D1PreparedStatement {
    this.statement(sql); // Fail early, as D1 does, and reject hidden second statements.
    return new SQLiteD1PreparedStatement(this, sql);
  }

  executeArrays(state: Bound): { rows: unknown[][]; columns: string[]; meta: D1Meta & Record<string, unknown> } {
    if (state.owner !== this) throw new Error('Prepared statement belongs to another database');
    const started = performance.now();
    const statement = this.statement(state.sql);
    const columns = statement.columns().map(column => column.name);
    const before = this.sqlite.prepare('SELECT total_changes() AS count').get()!.count as number;
    let rows: unknown[][] = [];
    if (columns.length) rows = (statement.all(...state.values) as unknown as unknown[][]).map(row => row.map(output));
    else statement.run(...state.values);
    const counts = this.sqlite.prepare('SELECT total_changes() AS total, changes() AS changes, last_insert_rowid() AS last_id');
    counts.setReadBigInts(true);
    const after = counts.get()!;
    const written = numeric(after.total as bigint) - before;
    return {
      rows, columns,
      meta: {
        duration: performance.now() - started,
        size_after: 0,
        rows_read: rows.length,
        rows_written: written,
        last_row_id: numeric(after.last_id as bigint),
        changed_db: written > 0,
        changes: written > 0 ? numeric(after.changes as bigint) : 0,
      },
    };
  }

  execute(state: Bound): D1Result {
    const { rows, columns, meta } = this.executeArrays(state);
    const results = rows.map(row => Object.fromEntries(columns.map((name, index) => [name, row[index]])));
    return { success: true, results, meta };
  }

  /** Synchronous callback: no request can interleave inside an atomic batch. */
  transaction<T>(callback: () => T): T {
    this.assertOpen();
    if (this.inTransaction) throw new Error('Nested SQLite transactions are not supported');
    this.sqlite.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = callback();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('SQLite transactions require a synchronous callback');
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  async batch<T = unknown>(batch: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const bound = batch.map(statement => {
      const state = statements.get(statement);
      if (!state || state.owner !== this) throw new Error('Prepared statement belongs to another database');
      return state;
    });
    return this.transaction(() => bound.map(state => this.execute(state) as D1Result<T>));
  }

  /** Administration only. The caller owns the surrounding migration transaction. */
  executeMigrationSQL(sql: string): void {
    this.assertOpen();
    if (!this.inTransaction) throw new Error('Migration SQL requires an explicit transaction');
    let rest = sqlWithoutLeadingComments(sql);
    while (rest) {
      forbidTransactionControl(rest);
      const statement = this.sqlite.prepare(rest);
      const consumed = statement.sourceSQL.length;
      if (!consumed) throw new Error('Unable to identify a migration statement');
      // .all completes RETURNING statements too, before the next changes() probe.
      if (statement.columns().length) statement.all();
      else statement.run();
      rest = sqlWithoutLeadingComments(rest.slice(consumed));
    }
  }

  async exec(_query: string): Promise<D1ExecResult> {
    throw new Error('D1 exec is unavailable; use the selfhost migration CLI');
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('D1 dump is unavailable; use the selfhost backup CLI');
  }

  withSession(_constraintOrBookmark?: string): D1DatabaseSession {
    throw new Error('D1 sessions are unavailable on the single-connection SQLite runtime');
  }

  close(): void {
    if (!this.closed) {
      this.sqlite.close();
      this.closed = true;
    }
  }
}
