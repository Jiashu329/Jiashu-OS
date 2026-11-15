import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { backupDatabase } from './backup.ts';
import { SQLiteD1Database } from './database.ts';
import { checkDatabase, loadMigrations, migrateDatabase, readDatabaseReadiness } from './migrations.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'selfhost-migrations-'));
  const directory = join(root, 'drizzle'), path = join(root, 'app.sqlite3');
  mkdirSync(join(directory, 'meta'), { recursive: true });
  function migrations(sql: string[]) {
    const entries = sql.map((content, idx) => {
      const tag = `${String(idx).padStart(4, '0')}_fixture`;
      writeFileSync(join(directory, `${tag}.sql`), content);
      return { idx, tag };
    });
    writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({ entries }));
  }
  return { root, path, directory, migrations, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

void test('all current migrations initialize an empty database once, before owner bootstrap', async () => {
  const f = fixture();
  try {
    const result = await migrateDatabase({ path: f.path, directory: resolve('drizzle') });
    assert.equal(result.schemaReady, true);
    assert.equal(result.changed, 34);
    assert.equal(result.applied, 34);
    assert.equal(result.backupPath, undefined);
    const db = new SQLiteD1Database(f.path);
    try {
      assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM app_owner_identity').first('count'), 0);
      assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM douban_items').first('count'), 0);
      assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM douban_data_resets').first('count'), 0);
      assert.equal(checkDatabase(db).schemaReady, true);
    } finally { db.close(); }
    const again = await migrateDatabase({ path: f.path, directory: resolve('drizzle') });
    assert.equal(again.changed, 0);
    assert.equal(again.backupPath, undefined);
    assert.equal(existsSync(join(f.root, 'backups')), false);
  } finally { f.cleanup(); }
});

void test('each migration is atomic, respects trigger semicolons and changes(), and safely retries', async () => {
  const f = fixture();
  const first = `CREATE TABLE value(id INTEGER PRIMARY KEY, content TEXT NOT NULL);
    CREATE TABLE audit(content TEXT);
    CREATE TRIGGER value_audit AFTER INSERT ON value BEGIN INSERT INTO audit VALUES('inside; trigger'); INSERT INTO audit VALUES('second'); END;
    INSERT INTO value VALUES(1,'saved');
    --> statement-breakpoint
    SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END;`;
  try {
    f.migrations([first, 'CREATE TABLE rolled_back(value TEXT); INSERT INTO value VALUES(2,NULL);']);
    await assert.rejects(migrateDatabase(f), /NOT NULL constraint/);
    const db = new SQLiteD1Database(f.path);
    try {
      assert.equal(db.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='rolled_back'").get(), undefined);
      assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM _selfhost_migrations').first('count'), 1);
      assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM audit').first('count'), 2);
    } finally { db.close(); }
    f.migrations([first, "INSERT INTO value VALUES(2,'retry');"]);
    const retry = await migrateDatabase(f);
    assert.equal(retry.changed, 1);
    assert.equal(retry.schemaReady, true);
    assert.ok(retry.backupPath);
  } finally { f.cleanup(); }
});

void test('existing data without a ledger is rejected without historical maintenance or new schema', async () => {
  const f = fixture();
  try {
    f.migrations(['DELETE FROM important;']);
    const db = new DatabaseSync(f.path);
    db.exec("CREATE TABLE important(value TEXT); INSERT INTO important VALUES('keep me');");
    db.close();
    await assert.rejects(migrateDatabase(f), /no selfhost migration ledger/);
    assert.throws(() => readDatabaseReadiness(f.path, f.directory), /no selfhost migration ledger/);
    const probe = new DatabaseSync(f.path);
    try {
      assert.equal(probe.prepare('SELECT value FROM important').get()!.value, 'keep me');
      assert.equal(probe.prepare("SELECT 1 FROM sqlite_schema WHERE name='_selfhost_migrations'").get(), undefined);
    } finally { probe.close(); }
    assert.equal(existsSync(join(f.root, 'backups')), false);
  } finally { f.cleanup(); }
});

void test('ledger rejects changed, missing, reordered and unlisted applied migrations', async () => {
  const f = fixture();
  const sql = 'CREATE TABLE initial(value TEXT);';
  try {
    f.migrations([sql]);
    await migrateDatabase(f);
    f.migrations([`${sql}\n-- changed`]);
    await assert.rejects(migrateDatabase(f), /missing, reordered or changed/);
    f.migrations([sql]);
    rmSync(join(f.directory, '0000_fixture.sql'));
    await assert.rejects(migrateDatabase(f), /migration file is missing/);
    f.migrations([sql]);
    writeFileSync(join(f.directory, 'unlisted.sql'), 'SELECT 1;');
    assert.throws(() => loadMigrations(f.directory), /journal disagree/);
    rmSync(join(f.directory, 'unlisted.sql'));
    const db = new DatabaseSync(f.path);
    db.prepare('UPDATE _selfhost_migrations SET idx=4').run();
    db.close();
    await assert.rejects(migrateDatabase(f), /missing, reordered or changed/);
  } finally { f.cleanup(); }
});

void test('incremental upgrades back up the old schema and committed WAL rows without overwrites', async () => {
  const f = fixture();
  const sql = 'CREATE TABLE initial(value TEXT);';
  try {
    f.migrations([sql]);
    await migrateDatabase(f);
    const writer = new SQLiteD1Database(f.path);
    try {
      await writer.prepare('INSERT INTO initial VALUES(?)').bind('committed WAL value').run();
      assert.equal(existsSync(`${f.path}-wal`), true);
      f.migrations([sql, 'ALTER TABLE initial ADD COLUMN extra TEXT;']);
      assert.equal(readDatabaseReadiness(f.path, f.directory).pending, 1);
      const result = await migrateDatabase(f);
      assert.ok(result.backupPath);
      const snapshot = new DatabaseSync(result.backupPath, { readOnly: true });
      try {
        assert.equal(snapshot.prepare('SELECT value FROM initial').get()!.value, 'committed WAL value');
        assert.deepEqual(snapshot.prepare('PRAGMA table_info(initial)').all().map(row => row.name), ['value']);
        assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM _selfhost_migrations').get()!.count, 1);
        assert.equal(snapshot.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      } finally { snapshot.close(); }
      const original = readFileSync(result.backupPath);
      await assert.rejects(backupDatabase(f.path, result.backupPath), /new file/);
      assert.deepEqual(readFileSync(result.backupPath), original);
      assert.equal(statSync(result.backupPath).mode & 0o777, 0o600);
      assert.equal(readdirSync(join(f.root, 'backups')).length, 1);
    } finally { writer.close(); }
  } finally { f.cleanup(); }
});

void test('readiness is read-only for a missing database and pending empty schema', () => {
  const f = fixture();
  try {
    f.migrations(['CREATE TABLE initial(value TEXT);']);
    assert.deepEqual(readDatabaseReadiness(f.path, f.directory), { schemaReady: false, applied: 0, total: 1, pending: 1 });
    assert.equal(existsSync(f.path), false);
    const empty = new DatabaseSync(f.path); empty.close();
    assert.equal(readDatabaseReadiness(f.path, f.directory).schemaReady, false);
    const probe = new DatabaseSync(f.path, { readOnly: true });
    try { assert.equal(probe.prepare('SELECT COUNT(*) AS count FROM sqlite_schema').get()!.count, 0); }
    finally { probe.close(); }
  } finally { f.cleanup(); }
});

void test('a failed first migration rolls schema and ledger back together and can resume', async () => {
  const f = fixture();
  try {
    f.migrations(['CREATE TABLE partial(value TEXT); BEGIN;']);
    await assert.rejects(migrateDatabase(f), /control SQL/);
    const database = new DatabaseSync(f.path);
    try {
      assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE name='partial'").get(), undefined);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM _selfhost_migrations').get()!.count, 0);
    } finally { database.close(); }
    f.migrations(['CREATE TABLE complete(value TEXT);']);
    assert.equal((await migrateDatabase(f)).changed, 1);
  } finally { f.cleanup(); }
});
