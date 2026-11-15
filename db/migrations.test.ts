import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

void test('browser provenance migration preserves prior private records, details, classifications and indexes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const directory = new URL('../drizzle/', import.meta.url);
    const migrations = readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of migrations.filter(name => name < '0028')) db.exec(readFileSync(new URL(name, directory), 'utf8'));
    const now = '2026-11-14T08:00:00.000Z';
    db.prepare(`INSERT INTO douban_items(user_id,profile_id,domain,subject_id,kind,title,url,cover_url,rating,marked_date,comment,published_at,source,
      observed_at,created_at,updated_at,metadata_checked_run_id,details_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('migration-owner','private-profile','screen','1234','movie','Private title','https://movie.douban.com/subject/1234/',null,5,'2026-11-10','Private comment',null,'import',now,now,now,'manual-kind','{"summary":"Saved details"}');
    const before = db.prepare('SELECT * FROM douban_items').get();
    db.exec(readFileSync(new URL('0028_douban_browser_source.sql', directory), 'utf8'));
    assert.deepEqual(db.prepare('SELECT * FROM douban_items').get(), before);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='douban_items'").all().map(row => row.name);
    assert.ok(indexes.includes('douban_items_owner_date_idx')); assert.ok(indexes.includes('douban_items_owner_profile_kind_idx'));
    db.prepare("UPDATE douban_items SET source='browser',rating=NULL,comment=NULL").run();
    assert.deepEqual({ ...db.prepare('SELECT source,rating,comment FROM douban_items').get() }, { source: 'browser', rating: null, comment: null });
    assert.throws(() => db.prepare("UPDATE douban_items SET source='unknown'").run());
  } finally { db.close(); }
});

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
    const afterTriggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='nutrition_entries' ORDER BY name").all();
    for(const trigger of beforeTriggers)assert.ok(afterTriggers.some((row)=>row.name===trigger.name));
    assert.equal(db.prepare('SELECT action FROM nutrition_entry_history WHERE user_id=? AND entry_id=?').get('migration-user','legacy-food')?.action,'baseline');
    for (const column of ['carbs_tenth', 'protein_tenth', 'fat_tenth']) {
      db.prepare(`UPDATE nutrition_entries SET ${column}=? WHERE id=?`).run(0, 'legacy-food');
      db.prepare(`UPDATE nutrition_entries SET ${column}=? WHERE id=?`).run(200000, 'legacy-food');
      for (const value of [-1, 200001, 0.5, 'not-a-number']) assert.throws(() => db.prepare(`UPDATE nutrition_entries SET ${column}=? WHERE id=?`).run(value, 'legacy-food'));
    }
  } finally { db.close(); }
});

test('P2 migration preserves legacy plans and request hashes while recording an explicit finance baseline',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    const directory=new URL('../drizzle/',import.meta.url),files=readdirSync(directory).filter((file)=>/^\d.*\.sql$/.test(file)).sort();
    for(const file of files.filter((file)=>file<'0017'))db.exec(readFileSync(new URL(file,directory),'utf8'));
    const now='2026-11-10T04:00:00.000Z';
    db.prepare('INSERT INTO health_weight_plan_settings(user_id,baseline_weight,target_weight,start_date,deadline,enabled,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?)').run('legacy',75,70,'2026-11-01','2026-12-01',1,now,now,0);
    for(const [id,type,archived]of [['bank','bank',null],['investment','investment',null],['property','property',now]] as const)db.prepare('INSERT INTO finance_accounts(id,user_id,ledger,name,type,currency,creation_hash,note,created_at,updated_at,archived_at,metadata_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'legacy','personal',id,type,'CNY','original-hash','',now,now,archived,7);
    for(const file of files.filter((file)=>file>='0017'))db.exec(readFileSync(new URL(file,directory),'utf8'));
    assert.deepEqual({...db.prepare('SELECT cycle_id,archived_at,revision,target_weight FROM health_weight_plan_settings').get()},{cycle_id:'legacy',archived_at:null,revision:0,target_weight:70});
    assert.equal(db.prepare('SELECT count(*) AS n FROM health_weight_plan_cycles').get()?.n,0);
    assert.deepEqual(db.prepare('SELECT liquidity_kind,usable_bps FROM finance_accounts ORDER BY id').all().map((row)=>({...row})),[{liquidity_kind:'liquid',usable_bps:10000},{liquidity_kind:'unreviewed',usable_bps:0},{liquidity_kind:'illiquid',usable_bps:0}]);
    const history=db.prepare('SELECT revision,effective_from,origin,archived FROM finance_account_classifications ORDER BY account_id').all();
    assert.equal(history.length,3);assert.ok(history.every((row)=>row.revision===7&&row.effective_from==='1970-01-01'&&row.origin==='baseline'));assert.equal(history[2].archived,1);
    assert.ok(db.prepare('SELECT creation_hash,metadata_revision FROM finance_accounts').all().every((row)=>row.creation_hash==='original-hash'&&row.metadata_revision===7));
  }finally{db.close();}
});
