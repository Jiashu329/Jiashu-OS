import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { consumeAIQuota, readAIQuota, type AIUsageDatabase } from './ai-usage-store.ts';

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE ai_usage_limits (
    user_id TEXT PRIMARY KEY NOT NULL, day TEXT NOT NULL, day_count INTEGER NOT NULL,
    minute INTEGER NOT NULL, minute_count INTEGER NOT NULL
  )`);
  t.after(() => sqlite.close());
  function client(): AIUsageDatabase {
    return {
      prepare(sql: string) {
        const statement = sqlite.prepare(sql);
        let values: SQLInputValue[] = [];
        const bound = {
          bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; return bound; },
          async first<T>() {
            // Independent requests reach SQLite together; each reservation
            // still has to check and increment its counters in one statement.
            await Promise.resolve();
            return (statement.get(...values) as T | undefined) ?? null;
          },
        };
        return bound;
      },
    } as unknown as AIUsageDatabase;
  }
  return { db: client(), anotherWorker: client(), sqlite };
}

const NOW = Date.parse('2026-11-11T02:20:30.250Z');

void test('reading remaining application quota never consumes requests and reflects minute reset',async(t)=>{
  const {db,sqlite}=fixture(t);
  assert.deepEqual(await readAIQuota(db,'alice',NOW),{allowed:true,retryAfter:0,remainingToday:20});
  assert.equal(sqlite.prepare('SELECT count(*) count FROM ai_usage_limits').get()?.count,0);
  for(let i=0;i<3;i++)await consumeAIQuota(db,'alice',NOW);
  assert.deepEqual(await readAIQuota(db,'alice',NOW),{allowed:false,retryAfter:30,remainingToday:17});
  assert.deepEqual(await readAIQuota(db,'alice',NOW+60000),{allowed:true,retryAfter:0,remainingToday:17});
  assert.equal(sqlite.prepare('SELECT day_count FROM ai_usage_limits WHERE user_id=?').get('alice')?.day_count,3);
});

void test('each user has an independent minute and Shanghai-day allowance', async (t) => {
  const { db, sqlite } = fixture(t);
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(await consumeAIQuota(db, 'alice', NOW), { allowed: true, retryAfter: 0, remainingToday: 19 - index });
  }
  assert.deepEqual(await consumeAIQuota(db, 'alice', NOW), { allowed: false, retryAfter: 30, remainingToday: 17 });
  assert.deepEqual(await consumeAIQuota(db, 'bob', NOW), { allowed: true, retryAfter: 0, remainingToday: 19 });
  assert.deepEqual(sqlite.prepare('SELECT user_id, day_count, minute_count FROM ai_usage_limits ORDER BY user_id').all()
    .map((row) => ({ ...row })), [
    { user_id: 'alice', day_count: 3, minute_count: 3 },
    { user_id: 'bob', day_count: 1, minute_count: 1 },
  ]);
});

void test('simultaneous requests from different workers cannot exceed the minute limit', async (t) => {
  const { db, anotherWorker, sqlite } = fixture(t);
  const results = await Promise.all(Array.from({ length: 40 }, (_, index) => consumeAIQuota(index % 2 ? db : anotherWorker, 'alice', NOW)));
  assert.equal(results.filter((result) => result.allowed).length, 3);
  assert.equal(results.filter((result) => !result.allowed).length, 37);
  assert.ok(results.filter((result) => !result.allowed).every((result) => result.remainingToday === 17 && result.retryAfter === 30));
  assert.deepEqual({ ...sqlite.prepare('SELECT day_count, minute_count FROM ai_usage_limits WHERE user_id=?').get('alice') }, { day_count: 3, minute_count: 3 });
});

void test('minute allowance resets at the exact UTC minute without resetting the daily count', async (t) => {
  const { db } = fixture(t);
  const nearBoundary = Date.parse('2026-11-11T02:20:59.999Z');
  for (let index = 0; index < 3; index++) await consumeAIQuota(db, 'alice', nearBoundary);
  assert.deepEqual(await consumeAIQuota(db, 'alice', nearBoundary), { allowed: false, retryAfter: 1, remainingToday: 17 });
  assert.deepEqual(await consumeAIQuota(db, 'alice', nearBoundary + 1), { allowed: true, retryAfter: 0, remainingToday: 16 });
});

void test('the twentieth daily request is accepted and rejection waits until Shanghai midnight', async (t) => {
  const { db, sqlite } = fixture(t);
  for (let index = 0; index < 20; index++) {
    const result = await consumeAIQuota(db, 'alice', NOW + Math.floor(index / 3) * 60000);
    assert.equal(result.allowed, true);
    assert.equal(result.remainingToday, 19 - index);
  }
  const rejectedAt = NOW + 10 * 60000;
  const result = await consumeAIQuota(db, 'alice', rejectedAt);
  assert.deepEqual(result, {
    allowed: false,
    retryAfter: Math.ceil((Date.parse('2026-11-11T16:00:00Z') - rejectedAt) / 1000),
    remainingToday: 0,
  });
  assert.equal(sqlite.prepare('SELECT day_count FROM ai_usage_limits WHERE user_id=?').get('alice')?.day_count, 20);
});

void test('simultaneous requests cannot exceed the final daily slots even in a fresh minute', async (t) => {
  const { db, anotherWorker, sqlite } = fixture(t);
  for (let index = 0; index < 18; index++) await consumeAIQuota(db, 'alice', NOW + Math.floor(index / 3) * 60000);
  const attemptsAt = NOW + 6 * 60000;
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => consumeAIQuota(index % 2 ? db : anotherWorker, 'alice', attemptsAt)));
  assert.equal(results.filter((result) => result.allowed).length, 2);
  assert.equal(sqlite.prepare('SELECT day_count FROM ai_usage_limits WHERE user_id=?').get('alice')?.day_count, 20);
  assert.ok(results.filter((result) => !result.allowed).every((result) => result.remainingToday === 0 && result.retryAfter > 60));
});

void test('daily exhaustion takes priority over minute exhaustion and resets at Shanghai midnight', async (t) => {
  const { db, sqlite } = fixture(t);
  const beforeMidnight = Date.parse('2026-11-11T15:59:59.500Z');
  sqlite.prepare('INSERT INTO ai_usage_limits VALUES (?,?,?,?,?)')
    .run('alice', '2026-11-11', 20, Math.floor(beforeMidnight / 60000), 3);
  assert.deepEqual(await consumeAIQuota(db, 'alice', beforeMidnight), { allowed: false, retryAfter: 1, remainingToday: 0 });
  assert.deepEqual(await consumeAIQuota(db, 'alice', Date.parse('2026-11-11T16:00:00Z')), { allowed: true, retryAfter: 0, remainingToday: 19 });
  assert.deepEqual({ ...sqlite.prepare('SELECT day, day_count, minute_count FROM ai_usage_limits WHERE user_id=?').get('alice') }, {
    day: '2026-11-12', day_count: 1, minute_count: 1,
  });
});

void test('UTC midnight does not reset the Shanghai day', async (t) => {
  const { db } = fixture(t);
  assert.deepEqual(await consumeAIQuota(db, 'alice', Date.parse('2026-11-10T23:59:59Z')), { allowed: true, retryAfter: 0, remainingToday: 19 });
  assert.deepEqual(await consumeAIQuota(db, 'alice', Date.parse('2026-11-11T00:00:00Z')), { allowed: true, retryAfter: 0, remainingToday: 18 });
});

void test('a delayed worker cannot roll counters back across a minute or daily boundary', async (t) => {
  const { db, anotherWorker, sqlite } = fixture(t);
  await consumeAIQuota(db, 'alice', NOW);
  await consumeAIQuota(anotherWorker, 'alice', NOW + 60000);
  assert.equal((await consumeAIQuota(db, 'alice', NOW)).allowed, false);
  assert.deepEqual({ ...sqlite.prepare('SELECT day_count, minute, minute_count FROM ai_usage_limits WHERE user_id=?').get('alice') }, {
    day_count: 2, minute: Math.floor((NOW + 60000) / 60000), minute_count: 1,
  });
  await consumeAIQuota(anotherWorker, 'alice', Date.parse('2026-11-11T16:00:00Z'));
  assert.equal((await consumeAIQuota(db, 'alice', Date.parse('2026-11-11T15:59:59Z'))).allowed, false);
  assert.deepEqual({ ...sqlite.prepare('SELECT day, day_count, minute_count FROM ai_usage_limits WHERE user_id=?').get('alice') }, {
    day: '2026-11-12', day_count: 1, minute_count: 1,
  });
});
