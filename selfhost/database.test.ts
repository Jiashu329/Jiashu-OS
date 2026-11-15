import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { databasePath, SQLiteD1Database } from './database.ts';

void test('D1 independent bind, first(column), JSON1, RETURNING and raw column names', async () => {
  const db = new SQLiteD1Database(':memory:');
  try {
    const query = db.prepare('SELECT ? AS value');
    const first = query.bind('first'), second = query.bind('second');
    assert.equal(await first.first('value'), 'first');
    assert.equal(await second.first('value'), 'second');
    assert.equal(await first.first('value'), 'first');
    assert.equal(await db.prepare('SELECT 1 WHERE 0').first(), null);
    await assert.rejects(db.prepare('SELECT 1 AS value').first('missing'), /D1_COLUMN_NOTFOUND/);
    assert.equal(await db.prepare('SELECT json_extract(?, ?) AS value').bind('{"a":3}', '$.a').first('value'), 3);
    await db.prepare('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)').run();
    const inserted = await db.prepare('INSERT INTO items(value) VALUES(?) RETURNING id,value').bind('test').all();
    assert.deepEqual(inserted.results, [{ id: 1, value: 'test' }]);
    assert.equal(inserted.meta.changes, 1);
    assert.equal(inserted.meta.last_row_id, 1);
    assert.equal((await db.prepare('SELECT * FROM items').all()).meta.changes, 0);
    assert.deepEqual(await db.prepare('SELECT 1 AS same,2 AS same').raw({ columnNames: true }), [['same', 'same'], [1, 2]]);
    assert.deepEqual(await db.prepare('SELECT 1 AS empty WHERE 0').raw({ columnNames: true }), [['empty']]);
    assert.deepEqual(await db.prepare('SELECT 1 AS number').raw(), [[1]]);
  } finally { db.close(); }
});

void test('batch preserves changes() guards and rolls every prior write back on failure', async () => {
  const db = new SQLiteD1Database(':memory:');
  try {
    await db.prepare('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)').run();
    const result = await db.batch([
      db.prepare('INSERT INTO items(id,value) VALUES(1,?)').bind('first'),
      db.prepare('SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END AS guarded'),
      db.prepare('UPDATE items SET value=? WHERE id=1').bind('second'),
      db.prepare('SELECT changes() AS prior_changes'),
    ]);
    assert.equal(result[1].meta.changes, 0);
    assert.deepEqual(result[3].results, [{ prior_changes: 1 }]);
    await assert.rejects(db.batch([
      db.prepare('INSERT INTO items(id,value) VALUES(2,?)').bind('rollback'),
      db.prepare('UPDATE items SET value=? WHERE id=999').bind('missing'),
      db.prepare('SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END AS guarded'),
    ]), /integer overflow/);
    assert.deepEqual((await db.prepare('SELECT * FROM items').all()).results, [{ id: 1, value: 'second' }]);
  } finally { db.close(); }
});

void test('binary binding snapshots values and rejects unsafe bindings and control statements', async () => {
  const db = new SQLiteD1Database(':memory:'), other = new SQLiteD1Database(':memory:');
  try {
    const source = new Uint8Array([1, 2, 3]);
    const query = db.prepare('SELECT ? AS bytes').bind(source);
    source.fill(9);
    assert.deepEqual(await query.first('bytes'), new Uint8Array([1, 2, 3]));
    for (const invalid of [undefined, true, {}, NaN, Infinity]) assert.throws(() => db.prepare('SELECT ?').bind(invalid));
    assert.throws(() => db.prepare('SELECT 1; DELETE FROM sqlite_schema'), /exactly one/);
    assert.throws(() => db.prepare('/* comment */ BEGIN'), /control SQL/);
    await assert.rejects(db.batch([other.prepare('SELECT 1')]), /another database/);
    assert.throws(() => db.transaction(() => db.transaction(() => 1)), /Nested/);
    assert.throws(() => db.transaction(() => Promise.resolve()), /synchronous callback/);
    assert.equal(await db.prepare("SELECT 'a;b' AS value; -- fine\n /* fine */").first('value'), 'a;b');
  } finally { db.close(); other.close(); }
  assert.throws(() => db.prepare('SELECT 1'), /closed/);
});

void test('file connections use WAL, enforce foreign keys and complete triggers atomically', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'selfhost-db-'));
  const db = new SQLiteD1Database(join(directory, 'app.sqlite3'));
  try {
    assert.equal(db.sqlite.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    assert.equal(db.sqlite.prepare('PRAGMA busy_timeout').get()!.timeout, 5000);
    db.transaction(() => db.executeMigrationSQL(`
      CREATE TABLE parent(id INTEGER PRIMARY KEY);
      --> statement-breakpoint
      CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      CREATE TABLE audit(event TEXT);
      CREATE TRIGGER parent_audit AFTER INSERT ON parent BEGIN
        INSERT INTO audit(event) VALUES('semicolon; still inside trigger');
        INSERT INTO audit(event) VALUES('second');
      END;
    `));
    await assert.rejects(db.prepare('INSERT INTO child VALUES(1,999)').run(), /FOREIGN KEY/);
    const inserted = await db.prepare('INSERT INTO parent VALUES(1)').run();
    assert.equal(inserted.meta.changes, 1);
    assert.equal(inserted.meta.rows_written, 3);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM audit').first('count')), 2);
    for (const suffix of ['', '-wal', '-shm']) {
      const path = join(directory, `app.sqlite3${suffix}`);
      assert.equal(existsSync(path), true);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  assert.throws(() => databasePath('relative.sqlite3'), /absolute/);
});
