import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { homeActionDates, readHomeActions } from './home-actions-store.ts';
import { writeWeeklyAction } from './health-weekly-actions-store.ts';
import { buildHealthSummary } from '../lib/health.ts';
import { buildHomeOverview } from '../lib/home-overview.ts';
import type { HomeActionsInput, HomeOverviewSources } from '../lib/home-overview.ts';
import { parseHealthWeekQuery } from '../lib/health-weekly.ts';

const NOW = '2026-11-12T08:00:00Z';
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  t.after(() => sqlite.close());
  const db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql);
    let values: SQLInputValue[] = [];
    const bound = {
      bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; return bound; },
      async first<T>() { const row = statement.get(...values); return row ? { ...row } as T : null; },
      async all<T>() { return { results: statement.all(...values).map((row) => ({ ...row })) as T[] }; },
    };
    return bound;
  } } as unknown as D1Database;
  let sequence = 0;
  function food(owner: string, date: string, options: { calories?: number | null; deleted?: boolean } = {}) {
    sqlite.prepare(`INSERT INTO nutrition_entries (id,user_id,date,meal,name,portion,note,calories_tenth,
      creation_hash,revision,created_at,updated_at,deleted_at) VALUES (?,?,?,'lunch','synthetic','','',?,'hash',1,?,?,?)`)
      .run('food-' + ++sequence, owner, date, options.calories ?? null, NOW, NOW, options.deleted ? NOW : null);
  }
  function health(owner: string, key: string, day: string) {
    const measurement = { id: key, metric: 'weight', value: 70, unit: 'kg', startDate: day + 'T08:00:00+08:00' };
    sqlite.prepare('INSERT INTO health_measurements (user_id,record_key,metric,day,measurement_json,exported_at,received_at) VALUES (?,?,?,?,?,?,?)')
      .run(owner, key, 'weight', day, JSON.stringify(measurement), NOW, NOW);
  }
  function override(owner: string, key: string, day: string, deleted: boolean, hasValue = true) {
    const measurement = { id: key, metric: 'weight', value: 70, unit: 'kg', startDate: day + 'T08:00:00+08:00' };
    sqlite.prepare(`INSERT INTO health_record_overrides
      (user_id,record_key,metric,day,override_json,deleted,revision,last_change_id,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)`)
      .run(owner, key, 'weight', day, hasValue ? JSON.stringify(measurement) : null, deleted ? 1 : 0, key + '-change', NOW, NOW);
  }
  function goal(owner: string, ledger: 'personal' | 'family', currency: 'CNY' | 'USD', archived = false) {
    sqlite.prepare(`INSERT INTO finance_goal_plans
      (id,user_id,ledger,currency,name,target_minor,deadline,account_ids_json,creation_hash,created_at,updated_at,archived_at)
      VALUES (?,?,?,?,?,'10000','2026-11-20','[]','hash',?,?,?)`)
      .run('goal-' + ++sequence, owner, ledger, currency, owner + '-private-goal', NOW, NOW, archived ? NOW : null);
  }
  return { sqlite, db, food, health, override, goal };
}
function readySources(actions: HomeActionsInput): HomeOverviewSources {
  return {
    health: { summary: buildHealthSummary([
      { id:'steps',metric:'steps',value:5000,unit:'count',aggregation:'daily',startDate:'2026-11-12T00:00:00+08:00',endDate:'2026-11-12T12:00:00+08:00' },
      { id:'weight',metric:'weight',value:70,unit:'kg',startDate:'2026-11-12T08:00:00+08:00' },
    ]), lastSync: NOW },
    personal: { accounts: [{ id:'personal',ledger:'personal',type:'bank',currency:'CNY',balanceMinor:'100',asOfDate:'2026-11-12' }] },
    family: { accounts: [{ id:'family',ledger:'family',type:'bank',currency:'CNY',balanceMinor:'100',asOfDate:'2026-11-12' }] },
    actions,
  };
}

void test('home action dates cross a Shanghai week at local midnight and normalize year boundaries', () => {
  assert.deepEqual(homeActionDates('2026-11-08T15:59:59Z'), {
    today:'2026-11-08',weekStart:'2026-11-02',previousWeekStart:'2026-10-26',recentFrom:'2026-11-02',
  });
  assert.deepEqual(homeActionDates('2026-11-08T16:00:00Z'), {
    today:'2026-11-09',weekStart:'2026-11-09',previousWeekStart:'2026-11-02',recentFrom:'2026-11-03',
  });
  assert.deepEqual(homeActionDates('2026-12-31T16:00:00Z'), {
    today:'2027-01-01',weekStart:'2026-12-28',previousWeekStart:'2026-12-21',recentFrom:'2026-12-26',
  });
});

void test('all optional action facts remain scoped to their owner and finance scope', async (t) => {
  const f=fixture(t);
  f.food('bob','2026-11-12');f.health('bob','bob-weight','2026-11-03');
  f.goal('bob','family','USD');f.goal('bob','personal','CNY',true);
  await writeWeeklyAction(f.db,'bob',{weekStart:'2026-11-09',text:'Bob private action',status:'planned',feedback:'',expectedRevision:0});
  const alice=await readHomeActions(f.db,'alice',NOW);
  assert.deepEqual(alice.nutrition,{entryCountToday:0,recordedDays7:0});
  assert.equal(alice.weekly?.previousHasRecords,false);assert.equal(alice.weekly?.reviewed,false);
  assert.deepEqual(alice.decisions,[]);
  const bob=await readHomeActions(f.db,'bob',NOW);
  assert.equal(bob.nutrition?.entryCountToday,1);assert.equal(bob.weekly?.previousHasRecords,true);assert.equal(bob.weekly?.reviewed,true);
  assert.equal(bob.decisions?.length,1);assert.equal(bob.decisions?.[0].ledger,'family');assert.equal(bob.decisions?.[0].currency,'USD');
  assert.equal(bob.decisions?.[0].goals[0].name,'bob-private-goal');
  assert.deepEqual((await readHomeActions(f.db,"alice' OR 1=1 --",NOW)).decisions,[]);
});

void test('nutrition today and rolling seven days count real entries and dates, including zero and unknown calories', async (t) => {
  const f=fixture(t);
  f.food('alice','2026-11-06',{calories:0});f.food('alice','2026-11-06');
  f.food('alice','2026-11-11');f.food('alice','2026-11-12');f.food('alice','2026-11-12',{calories:0});
  f.food('alice','2026-11-05');f.food('alice','2026-11-13');f.food('alice','2026-11-10',{deleted:true});
  f.food('bob','2026-11-07');
  assert.deepEqual((await readHomeActions(f.db,'alice',NOW)).nutrition,{entryCountToday:2,recordedDays7:3});
});

void test('the execution-week review marker advances exactly at Shanghai Monday midnight', async (t) => {
  const f=fixture(t);f.health('alice','earlier-week','2026-10-28');f.health('alice','last-week','2026-11-04');
  await writeWeeklyAction(f.db,'alice',{weekStart:'2026-11-09',text:'下一周行动',status:'planned',feedback:'',expectedRevision:0});
  const before=await readHomeActions(f.db,'alice','2026-11-08T15:59:59Z');
  assert.equal(before.weekly?.weekStart,'2026-11-02');assert.equal(before.weekly?.previousHasRecords,true);assert.equal(before.weekly?.reviewed,false);
  const after=await readHomeActions(f.db,'alice','2026-11-08T16:00:00Z');
  assert.equal(after.weekly?.weekStart,'2026-11-09');assert.equal(after.weekly?.previousWeekStart,'2026-11-02');
  assert.equal(after.weekly?.previousHasRecords,true);assert.equal(after.weekly?.reviewed,true);
});

void test('saving the current execution week action clears the prior-week review and the link opens its exact review week', async (t) => {
  const f=fixture(t);f.health('alice','prior','2026-11-04');f.food('alice','2026-11-11');
  for (const weekStart of ['2026-11-02','2026-11-16']) await writeWeeklyAction(f.db,'alice',{
    weekStart,text:'another week',status:'planned',feedback:'',expectedRevision:0,
  });
  const before=await readHomeActions(f.db,'alice',NOW);
  assert.equal(before.weekly?.reviewed,false);
  const priorities=buildHomeOverview(readySources(before),NOW).priorities;
  assert.deepEqual(priorities.map((priority)=>priority.id),['weekly-review','nutrition-today']);
  const link=new URL(priorities[0].href,'https://synthetic-home.example');
  assert.equal(link.pathname,'/health/review');
  const selection=parseHealthWeekQuery(link.searchParams,new Date(NOW));
  assert.equal(selection.weekStart,'2026-11-02');assert.equal(selection.weekEnd,'2026-11-08');
  assert.equal(homeActionDates(NOW).weekStart,'2026-11-09');
  await writeWeeklyAction(f.db,'alice',{weekStart:'2026-11-09',text:'午饭后散步',status:'planned',feedback:'',expectedRevision:0});
  assert.deepEqual(buildHomeOverview(readySources(await readHomeActions(f.db,'alice',NOW)),NOW).priorities.map((priority)=>priority.id),['nutrition-today']);
  f.food('alice','2026-11-12');
  assert.deepEqual(buildHomeOverview(readySources(await readHomeActions(f.db,'alice',NOW)),NOW).priorities,[]);
});

void test('prior review availability uses effective health records rather than hidden bases or superseded dates', async (t) => {
  const f=fixture(t);
  f.health('alice','hidden','2026-11-04');f.override('alice','hidden','2026-11-04',true,false);
  f.health('alice','moved','2026-11-05');f.override('alice','moved','2026-11-10',false);
  f.food('alice','2026-11-03',{deleted:true});
  assert.equal((await readHomeActions(f.db,'alice',NOW)).weekly?.previousHasRecords,false);
  f.override('alice','manual','2026-11-06',false);
  assert.equal((await readHomeActions(f.db,'alice',NOW)).weekly?.previousHasRecords,true);
});

void test('a missing weekly-action table does not discard nutrition or financial decisions', async (t) => {
  const f=fixture(t);f.food('alice','2026-11-12');f.goal('alice','personal','CNY');
  f.sqlite.exec('DROP TABLE health_weekly_actions');
  const result=await readHomeActions(f.db,'alice',NOW);
  assert.deepEqual(result.nutrition,{entryCountToday:1,recordedDays7:1});assert.equal(result.weekly,null);
  assert.equal(result.decisions?.length,1);assert.equal(result.decisions?.[0].goals[0].name,'alice-private-goal');
});

void test('a failed finance helper leaves independent nutrition and weekly facts available', async (t) => {
  const f=fixture(t);f.food('alice','2026-11-12');f.health('alice','last-week','2026-11-02');
  f.sqlite.exec('DROP TABLE finance_goal_plans');
  const result=await readHomeActions(f.db,'alice',NOW);
  assert.equal(result.decisions,null);assert.equal(result.nutrition?.entryCountToday,1);
  assert.equal(result.weekly?.previousHasRecords,true);assert.equal(result.weekly?.reviewed,false);
});

void test('a missing nutrition table leaves financial decisions available without claiming other facts are completed', async (t) => {
  const f=fixture(t);f.goal('alice','family','CNY');f.sqlite.exec('DROP TABLE nutrition_entries');
  const result=await readHomeActions(f.db,'alice',NOW);
  assert.equal(result.nutrition,null);assert.equal(result.weekly,null);assert.equal(result.decisions?.length,1);
});
