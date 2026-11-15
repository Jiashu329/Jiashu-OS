import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import * as nutrition from '../../../../../lib/nutrition.ts';
import * as insight from '../../../../../lib/nutrition-review.ts';
import type { NutritionDayStatus, NutritionEntry } from '../../../../../lib/nutrition.ts';
import { NutritionConflictError } from '../../../../../db/nutrition-store.ts';

const NOW = Date.parse('2026-11-11T18:00:00+08:00');
const ORIGIN = 'https://synthetic-nutrition-review.example';
function load(path: URL, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(bindings), source + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings));
}
function fixture() {
  let owner: string | null = 'alice', fail = false;
  const env: { DB?: D1Database } = { DB: {} as D1Database };
  const reads: Array<{ owner: string; selection: { from: string; to: string }; kind: string }> = [];
  const shared = load(new URL('../../../_shared.ts', import.meta.url), {
    getChatGPTAccess: async () => ({ identity: null, allowed: false, isOwner: false, reason: 'signed_out' }), getChatGPTUser: async () => owner ? { userId: owner } : null,
  }, ['apiUser', 'json', 'unauthenticated', 'unavailable', 'invalidOrigin', 'isSameOrigin']);
  const helpers = load(new URL('../_shared.ts', import.meta.url), { ...shared, ...nutrition, NutritionConflictError, env }, ['nutritionDatabase', 'nutritionError']);
  const route = load(new URL('./route.ts', import.meta.url), { ...shared, ...helpers, ...insight,
    parseNutritionInsightQuery: (params: URLSearchParams) => insight.parseNutritionInsightQuery(params, NOW),
    readNutritionRangeSnapshot: async (_db: unknown, user: string, selection: { from: string; to: string }): Promise<{ entries: NutritionEntry[]; statuses: NutritionDayStatus[] }> => {
      reads.push({ owner: user, selection, kind: 'snapshot' });
      if (fail) throw new Error('PRIVATE_STORAGE_FAILURE');
      return {
        entries: [{ id: 'PRIVATE_FOOD_ID', date: '2026-11-10', meal: 'lunch', name: 'PRIVATE_FOOD_NAME', portion: 'PRIVATE_PORTION', note: 'PRIVATE_NOTE',
          caloriesTenth: user === 'alice' ? 1000 : 9000, revision: 1, createdAt: '2026-11-10T12:00:00Z', updatedAt: '2026-11-10T12:00:00Z', deletedAt: null }],
        statuses: [{ date: '2026-11-10', complete: user === 'alice', revision: 1,
          meals: { breakfast: 'skipped', lunch: 'recorded', dinner: 'skipped', snack: 'unrecorded' } }],
      };
    },
  }, ['GET']) as { GET(request: Request): Promise<Response> };
  return { reads, env, signIn(value: string | null) { owner = value; }, fail() { fail = true; },
    get(query = '') { return route.GET(new Request(ORIGIN + '/api/health/nutrition/review' + query)); } };
}

test('review requires authentication and validates the complete range before storage reads', async () => {
  const f = fixture(); f.signIn(null);
  assert.equal((await f.get()).status, 401); assert.equal(f.reads.length, 0);
  f.signIn('alice');
  for (const query of ['?days=90', '?days=7&days=30', '?date=2026-11-12', '?date=2026-02-30', '?userId=bob']) {
    assert.equal((await f.get(query)).status, 400);
  }
  assert.equal(f.reads.length, 0);
});

test('review reads only the authenticated owner and returns safe, source-backed aggregates', async () => {
  const f = fixture();
  const response = await f.get('?days=30&date=2026-11-11');
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const data = await response.json() as insight.NutritionInsight;
  assert.equal(data.days.length, 30); assert.equal(data.summary.knownCalories, '100.0');
  assert.equal(data.summary.comparableDays, 1); assert.equal(data.summary.averageCompleteKcal, '100.0');
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].kind, 'snapshot');
  assert.ok(f.reads.every((read) => read.owner === 'alice' && read.selection.from === '2026-10-13' && read.selection.to === '2026-11-11'));
  assert.ok(!JSON.stringify(data).includes('PRIVATE_'));
  f.signIn('bob'); const other = await (await f.get()).json() as insight.NutritionInsight;
  assert.equal(other.summary.knownCalories, '900.0'); assert.equal(other.summary.comparableDays, 0);
  assert.equal(f.reads.at(-1)!.owner, 'bob');
});

test('storage failure is an unavailable response rather than an empty successful review', async () => {
  const f = fixture(); f.fail();
  const response = await f.get(); assert.equal(response.status, 503);
  const text = await response.text(); assert.ok(!text.includes('PRIVATE_')); assert.match(text, /HEALTH_STORAGE_UNAVAILABLE/);
  const missing = fixture(); missing.env.DB = undefined;
  assert.equal((await missing.get()).status, 503); assert.equal(missing.reads.length, 0);
});
