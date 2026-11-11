import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

test('financial schema additions preserve existing health, connection and exact balance records', () => {
  const db = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  const migrations = readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const run = (name: string) => db.exec(readFileSync(new URL(name, directory), 'utf8'));
  for (const name of migrations.filter((name) => name < '0003')) run(name);
  // Synthetic local fixtures: no production records are read or modified.
  const health = '{"metric":"steps","value":1234,"unit":"count"}';
  db.prepare('INSERT INTO health_measurements VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('migration-check', 'steps:2026-11-09', 'steps', '2026-11-09', health, '2026-11-09T01:00:00Z', '2026-11-09T01:00:00Z');
  db.prepare('INSERT INTO sync_devices VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('migration-connection', 'migration-check', 'synthetic connection', 'synthetic-hash', '2026-11-09T01:00:00Z', null, null);
  db.prepare(`INSERT INTO finance_accounts
    (id,user_id,ledger,name,type,currency,note,created_at,updated_at,archived_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run('migration-account', 'migration-check', 'personal', 'synthetic account', 'bank', 'CNY', '', '2026-11-09T01:00:00Z', '2026-11-09T01:00:00Z', null);
  db.prepare(`INSERT INTO finance_balance_entries
    (id,user_id,account_id,amount_minor,as_of_date,note,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run('migration-balance', 'migration-check', 'migration-account', '9007199254740993', '2026-11-09', '', '2026-11-09T01:00:00Z');
  for (const name of migrations.filter((name) => name >= '0003')) run(name);
  assert.equal(db.prepare('SELECT measurement_json FROM health_measurements WHERE user_id=?').get('migration-check')?.measurement_json, health);
  assert.equal(db.prepare('SELECT token_hash FROM sync_devices WHERE id=?').get('migration-connection')?.token_hash, 'synthetic-hash');
  assert.equal(db.prepare('SELECT revoked_at FROM sync_devices WHERE id=?').get('migration-connection')?.revoked_at, null);
  assert.equal(db.prepare('SELECT amount_minor FROM finance_balance_entries WHERE id=?').get('migration-balance')?.amount_minor, '9007199254740993');
  assert.equal(db.prepare('SELECT name FROM finance_accounts WHERE id=?').get('migration-account')?.name, 'synthetic account');
  assert.equal(db.prepare('SELECT balance_revision FROM finance_accounts WHERE id=?').get('migration-account')?.balance_revision, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM finance_balance_changes').get()?.count, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM health_import_batches').get()?.count, 0);
  db.close();
});
