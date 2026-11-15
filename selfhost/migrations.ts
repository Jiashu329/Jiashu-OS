import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backupDatabase, backupPathForMigration } from './backup.ts';
import { databasePath, SQLiteD1Database } from './database.ts';

export const MIGRATIONS_TABLE = '_selfhost_migrations';
export type Migration = { idx: number; tag: string; checksum: string; sql: string };
export type SchemaReadiness = { schemaReady: boolean; applied: number; total: number; pending: number };

export class MigrationError extends Error {
  constructor(message: string) { super(message); this.name = 'MigrationError'; }
}

export function loadMigrations(directory = resolve(process.cwd(), 'drizzle')): Migration[] {
  let journal: unknown;
  try { journal = JSON.parse(readFileSync(resolve(directory, 'meta/_journal.json'), 'utf8')); }
  catch { throw new MigrationError('Migration journal is missing or invalid'); }
  if (!journal || typeof journal !== 'object' || !('entries' in journal) || !Array.isArray(journal.entries) || !journal.entries.length) throw new MigrationError('Migration journal is empty or invalid');
  const tags = new Set<string>();
  const migrations = journal.entries.map((entry: unknown, idx: number) => {
    if (!entry || typeof entry !== 'object' || !('idx' in entry) || entry.idx !== idx || !('tag' in entry) || typeof entry.tag !== 'string' || !/^\d{4}_[a-zA-Z0-9_-]+$/.test(entry.tag) || tags.has(entry.tag)) throw new MigrationError('Migration order or tag is invalid');
    tags.add(entry.tag);
    let bytes: Buffer;
    try { bytes = readFileSync(resolve(directory, `${entry.tag}.sql`)); }
    catch { throw new MigrationError('A journaled migration file is missing'); }
    let sql: string;
    try { sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new MigrationError('Migration SQL is not valid UTF-8'); }
    return { idx, tag: entry.tag, checksum: createHash('sha256').update(bytes).digest('hex'), sql };
  });
  const files = readdirSync(directory).filter(name => name.endsWith('.sql'));
  if (files.length !== migrations.length || files.some(name => !tags.has(name.slice(0, -4)))) throw new MigrationError('Migration SQL files and journal disagree');
  return migrations;
}

function hasLedger(database: SQLiteD1Database): boolean {
  return !!database.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(MIGRATIONS_TABLE);
}

function nonemptySchema(database: SQLiteD1Database): boolean {
  return !!database.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name<>? LIMIT 1").get(MIGRATIONS_TABLE);
}

function appliedCount(database: SQLiteD1Database, migrations: Migration[]): number {
  if (!hasLedger(database)) {
    if (nonemptySchema(database)) throw new MigrationError('Existing database has no selfhost migration ledger; refusing to replay historical migrations');
    return 0;
  }
  let rows: Array<{ idx: number; tag: string; checksum: string }>;
  try { rows = database.sqlite.prepare(`SELECT idx, tag, checksum FROM ${MIGRATIONS_TABLE} ORDER BY idx`).all() as typeof rows; }
  catch { throw new MigrationError('Selfhost migration ledger schema is invalid'); }
  if (!rows.length && nonemptySchema(database)) throw new MigrationError('Nonempty database has an empty migration ledger; refusing historical migration replay');
  for (let idx = 0; idx < rows.length; idx++) {
    const expected = migrations[idx], actual = rows[idx];
    if (!expected || actual.idx !== idx || actual.tag !== expected.tag || actual.checksum !== expected.checksum) throw new MigrationError('An applied migration is missing, reordered or changed; restore its original file before deploying');
  }
  return rows.length;
}

/** Read-only: callers must open an existing database, never migrate from health checks. */
export function checkDatabase(database: SQLiteD1Database, migrations = loadMigrations()): SchemaReadiness {
  database.sqlite.prepare('SELECT 1').get();
  const applied = appliedCount(database, migrations);
  return { schemaReady: applied === migrations.length, applied, total: migrations.length, pending: migrations.length - applied };
}

export async function migrateDatabase(options: { path?: string; directory?: string } = {}): Promise<SchemaReadiness & { changed: number; appliedMigrationNames: string[]; backupPath?: string }> {
  const path = databasePath(options.path);
  const migrations = loadMigrations(options.directory);
  const database = new SQLiteD1Database(path);
  let changed = 0;
  const appliedMigrationNames: string[] = [];
  let backupPath: string | undefined;
  try {
    // Validate before the first schema mutation. Existing Sites/D1 exports must
    // go through an explicit migration-ledger-aware import, not this fresh path.
    const initial = checkDatabase(database, migrations);
    if (initial.applied > 0 && initial.pending > 0) {
      backupPath = backupPathForMigration(path);
      await backupDatabase(path, backupPath);
    }
    database.transaction(() => {
      appliedCount(database, migrations);
      database.sqlite.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        idx INTEGER PRIMARY KEY CHECK(idx >= 0),
        tag TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL CHECK(length(checksum) = 64),
        applied_at TEXT NOT NULL
      ) STRICT`);
    });
    for (const migration of migrations) {
      database.transaction(() => {
        const applied = appliedCount(database, migrations);
        if (applied > migration.idx) return;
        if (applied !== migration.idx) throw new MigrationError('Migration ledger is not an ordered prefix');
        database.executeMigrationSQL(migration.sql);
        database.sqlite.prepare(`INSERT INTO ${MIGRATIONS_TABLE}(idx,tag,checksum,applied_at) VALUES (?,?,?,?)`).run(migration.idx, migration.tag, migration.checksum, new Date().toISOString());
        changed++;
        appliedMigrationNames.push(migration.tag);
      });
    }
    return { ...checkDatabase(database, migrations), changed, appliedMigrationNames, ...(backupPath ? { backupPath } : {}) };
  } finally { database.close(); }
}

export function readDatabaseReadiness(path = databasePath(), directory?: string): SchemaReadiness {
  const migrations = loadMigrations(directory);
  if (!existsSync(path)) return { schemaReady: false, applied: 0, total: migrations.length, pending: migrations.length };
  const database = new SQLiteD1Database(path, { readOnly: true });
  try { return checkDatabase(database, migrations); }
  finally { database.close(); }
}

function isCLI(): boolean {
  return !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isCLI()) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command !== 'migrate' && command !== 'readiness') throw new MigrationError('Usage: node selfhost/migrations.ts migrate|readiness [--database /absolute/path] [--directory /migration/directory]');
    const options: { path?: string; directory?: string } = {};
    for (let idx = 0; idx < args.length; idx += 2) {
      const flag = args[idx], value = args[idx + 1];
      if (!value || (flag !== '--database' && flag !== '--directory')) throw new MigrationError('Invalid migration CLI arguments');
      const key = flag === '--database' ? 'path' : 'directory';
      if (options[key]) throw new MigrationError('Duplicate migration CLI argument');
      options[key] = value;
    }
    const result = command === 'migrate' ? await migrateDatabase(options) : readDatabaseReadiness(databasePath(options.path), options.directory);
    console.log(JSON.stringify(result));
    if (!result.schemaReady) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof MigrationError ? error.message : 'SQLite migration failed; no data values are logged. Inspect the migration files and database permissions.');
    process.exitCode = 1;
  }
}
