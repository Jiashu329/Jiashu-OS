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

test('second-batch schema preserves existing plans and starts their concurrency versions without inventing history', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const directory = new URL('../drizzle/', import.meta.url);
    const migrations = readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    const run = (name: string) => db.exec(readFileSync(new URL(name, directory), 'utf8'));
    for (const name of migrations.filter((name) => name < '0013')) run(name);
    const now = '2026-11-10T04:00:00.000Z';
    db.prepare('INSERT INTO health_goal_settings VALUES (?,?,?,?,?)').run('legacy-plans',6000,7,400,now);
    db.prepare('INSERT INTO health_weight_plan_settings VALUES (?,?,?,?,?,?,?,?)').run('legacy-plans',75,70,'2026-11-01','2026-12-01',1,now,now);
    db.prepare('INSERT INTO finance_runway_settings VALUES (?,?,?,?,?,?,?,?)').run('legacy-plans','personal','CNY','10000',6,'[]',now,now);
    for (const name of migrations.filter((name) => name >= '0013')) run(name);
    assert.deepEqual({ ...db.prepare('SELECT steps_target,sleep_target,active_energy_target,revision FROM health_goal_settings').get() },
      { steps_target:6000,sleep_target:7,active_energy_target:400,revision:0 });
    assert.deepEqual({ ...db.prepare('SELECT target_weight,enabled,revision FROM health_weight_plan_settings').get() },
      { target_weight:70,enabled:1,revision:0 });
    assert.deepEqual({ ...db.prepare('SELECT monthly_expense_minor,target_months,revision FROM finance_runway_settings').get() },
      { monthly_expense_minor:'10000',target_months:6,revision:0 });
    for (const table of ['health_goal_versions','health_sync_attempts','nutrition_favorites','nutrition_copy_operations']) {
      assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count,0);
    }
  } finally { db.close(); }
});

test('macro columns preserve old nutrition data and completeness triggers while enforcing integer gram bounds', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const directory = new URL('../drizzle/', import.meta.url);
    const migrations = readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    const run = (name: string) => db.exec(readFileSync(new URL(name, directory), 'utf8'));
    for (const name of migrations.filter((name) => name < '0015')) run(name);
    const now = '2026-11-12T04:00:00.000Z';
    db.prepare(`INSERT INTO nutrition_entries(id,user_id,date,meal,name,portion,note,calories_tenth,creation_hash,revision,created_at,updated_at,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,?,?,NULL)`).run('legacy-food', 'migration-user', '2026-11-12', 'lunch', '旧食物', '1份', '保留备注', 1234, 'legacy-hash', now, now);
    const beforeTriggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='nutrition_entries' ORDER BY name").all();
    for (const name of migrations.filter((name) => name >= '0015')) run(name);
    const row = db.prepare('SELECT name,note,calories_tenth,creation_hash,carbs_tenth,protein_tenth,fat_tenth FROM nutrition_entries WHERE id=?').get('legacy-food');
    assert.deepEqual({ ...row }, { name: '旧食物', note: '保留备注', calories_tenth: 1234, creation_hash: 'legacy-hash', carbs_tenth: null, protein_tenth: null, fat_tenth: null });
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='nutrition_entries' ORDER BY name").all(), beforeTriggers);
    for (const column of ['carbs_tenth', 'protein_tenth', 'fat_tenth']) {
      db.prepare(`UPDATE nutrition_entries SET ${column}=? WHERE id=?`).run(0, 'legacy-food');
      db.prepare(`UPDATE nutrition_entries SET ${column}=? WHERE id=?`).run(200000, 'legacy-food');
      for (const value of [-1, 200001, 0.5, 'not-a-number']) assert.throws(() => db.prepare(`UPDATE nutrition_entries SET ${column}=? WHERE id=?`).run(value, 'legacy-food'));
    }
  } finally { db.close(); }
});
