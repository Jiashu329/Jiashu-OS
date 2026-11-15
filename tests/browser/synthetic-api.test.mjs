import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticState, interceptSyntheticAPI, DAY, ACCOUNT_ID } from './synthetic-api.mjs';
import { FinanceMetadataConflictError } from '../../db/finance-store.ts';
import { ACTIVE_FOOD_CATALOG_RELEASE } from '../../lib/food-catalog.ts';
import { presentNutritionEntry } from '../../lib/nutrition.ts';

async function fixture() {
  const state = syntheticState();
  let handler;
  await interceptSyntheticAPI({ route: async (_pattern, callback) => { handler = callback; } }, state);
  return { state, async request(path, method = 'GET', body = null, key = null) {
    let result;
    await handler({
      request: () => ({ url: () => 'http://127.0.0.1:4175' + path, method: () => method, postDataJSON: () => body, headers: () => key ? { 'idempotency-key': key } : {} }),
      fulfill: async (value) => { result = { status: value.status, body: JSON.parse(value.body) }; },
      abort: async (reason) => { result = { aborted: reason }; },
    });
    return result;
  } };
}

test('browser API fixtures use current nutrition normalization, replay a lost batch response, and preserve audit versions', async () => {
  const { state, request } = await fixture();
  const parsed = await request('/api/health/nutrition/parse', 'POST', { meal: 'lunch' });
  assert.equal(parsed.body.drafts[0].protein, '25.0');
  const draft = { date: DAY, meal: 'lunch', name: '合成食物', portion: '1份', calories: '120', carbs: null, protein: '10', fat: '0', note: '' };
  state.loseNextBatchReply = true;
  assert.deepEqual(await request('/api/health/nutrition/batch', 'POST', { entries: [draft] }, 'synthetic-replay-key'), { aborted: 'connectionreset' });
  const replay = await request('/api/health/nutrition/batch', 'POST', { entries: [draft] }, 'synthetic-replay-key');
  assert.equal(replay.body.replayed, true); assert.equal(state.entries.length, 1);
  const entryId = state.entries[0].id;
  const initialSnapshot = structuredClone(state.histories.get(entryId)[0]);
  await request('/api/health/nutrition/' + entryId, 'PATCH', { ...draft, protein: '20',
    food: { id: 'mcd-cn:49:28', amount: 1, unit: '份', catalogRelease: ACTIVE_FOOD_CATALOG_RELEASE }, expectedRevision: 1 });
  const priorCreatedAt = state.entries[0].createdAt;
  const restored = await request('/api/health/nutrition/' + entryId + '/restore', 'POST', { revision: 1, expectedRevision: 2 });
  assert.equal(restored.body.entry.revision, 3); assert.equal(restored.body.entry.protein, '10.0');
  assert.equal(state.entries[0].proteinTenth, 100);
  assert.equal(presentNutritionEntry(state.entries[0]).protein, '10.0');
  assert.equal(Object.hasOwn(state.entries[0], 'protein'), false, 'fixture storage must keep the real internal Entry format');
  assert.equal(state.entries[0].createdAt, priorCreatedAt);
  assert.equal(Object.hasOwn(state.entries[0], 'food'), false, 'a manual source snapshot clears a later catalog selection');
  assert.deepEqual(state.histories.get(entryId)[0], initialSnapshot, 'restoring adds a revision without mutating the source snapshot');
  const history = await request('/api/health/nutrition/' + entryId + '/history');
  assert.equal(history.body.history.length, 3); assert.equal(history.body.history[2].action, 'restore');
  const review = await request('/api/health/nutrition?date=' + DAY);
  assert.equal(review.body.entries[0].protein, '10.0');
  const goals = await request('/api/health/nutrition/goals', 'PUT', { calories: '2000', carbs: null, protein: '100', fat: null, expectedRevision: 0 });
  assert.equal(goals.body.goals.protein, '100.0');
  assert.equal((await request('/api/health/records')).body.today, DAY);
  assert.equal((await request('/api/overview')).status, 200);
  assert.equal((await request('/api/unexpected')).status, 501);
});

test('browser restoration replays a saved food snapshot without reparsing a catalog selection', async () => {
  const { state, request } = await fixture();
  const selection = { id: 'mcd-cn:49:28', amount: 1, unit: '份', catalogRelease: ACTIVE_FOOD_CATALOG_RELEASE };
  const draft = { date: DAY, meal: 'lunch', name: '食物快照', portion: '1份', calories: null, carbs: null, protein: null, fat: null, note: '', food: selection };
  const created = await request('/api/health/nutrition', 'POST', draft, 'saved-food');
  const entryId = created.body.entry.id;
  const original = structuredClone(state.histories.get(entryId)[0]);
  await request('/api/health/nutrition/' + entryId, 'PATCH', { ...draft, food: null, calories: '100', protein: '20', expectedRevision: 1 });
  const restored = await request('/api/health/nutrition/' + entryId + '/restore', 'POST', { revision: 1, expectedRevision: 2 });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.entry.revision, 3);
  assert.deepEqual(state.entries[0].food, original.after.food);
  assert.equal(state.entries[0].caloriesTenth, original.after.caloriesTenth);
  assert.equal(state.entries[0].proteinTenth, original.after.proteinTenth);
  assert.equal(restored.body.entry.protein, original.after.protein);
  assert.deepEqual(state.histories.get(entryId)[0], original);
  assert.equal(state.histories.get(entryId).length, 3);

});

test('browser finance conflict fixture uses the production metadata conflict code and retains the pending edit', async () => {
  const { state, request } = await fixture();
  const originalName = state.accounts[0].name;
  state.rejectNextAccountEdit = true;
  const conflict = await request('/api/finance/accounts/' + ACCOUNT_ID, 'PATCH', { name: '保留待核对的修改', expectedRevision: 1 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, new FinanceMetadataConflictError().code);
  assert.equal(state.accounts[0].name, originalName);
  assert.equal(state.accounts[0].metadataRevision, 2);
  const latest = await request('/api/finance/accounts/' + ACCOUNT_ID);
  assert.equal(latest.body.account.metadataRevision, 2);
});

test('browser health fixture commits a timed-out write once and only replays its exact original key and payload', async () => {
  const { state, request } = await fixture();
  const key = '22222222-2222-4222-8222-222222222222';
  const body = { metric: 'steps', value: 5678, date: DAY, capturedAt: new Date().toISOString(), reason: '原提交' };
  state.hangNextHealthWrite = true;
  assert.equal(await request('/api/health/records', 'POST', body, key), undefined);
  assert.equal(state.healthRecords.length, 1);
  const replay = await request('/api/health/records', 'POST', body, key);
  assert.equal(replay.status, 201); assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.record.effective.value, 5678); assert.equal(state.healthRecords.length, 1);
  assert.equal((await request('/api/health/records', 'POST', { ...body, value: 1 }, key)).status, 409);
  assert.equal((await request('/api/health/records')).body.records.length, 1);
  assert.equal((await request('/api/health/records', 'POST', { ...body, unsupported: true }, '33333333-3333-4333-8333-333333333333')).status, 400);
});

test('browser goals fixture retains a delayed GET snapshot and rejects stale target revisions', async () => {
  const { state, request } = await fixture();
  state.goals = { ...state.goals, revision: 7, calories: '1900.0' };
  let release;
  state.goalsReadGate = new Promise(resolve => { release = resolve; });
  const delayed = request('/api/health/nutrition/goals');
  for (let count = 0; count < 20 && state.goalsReadGate; count++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.goalsReadGate, null, 'the route must capture its snapshot before delaying the reply');
  const body = { calories: '2100', carbs: null, protein: '110', fat: null, expectedRevision: 7 };
  const saved = await request('/api/health/nutrition/goals', 'PUT', body);
  assert.equal(saved.body.goals.revision, 8); release();
  assert.equal((await delayed).body.goals.revision, 7);
  assert.equal((await request('/api/health/nutrition/goals', 'PUT', body)).status, 409);
  assert.equal(state.goals.calories, '2100.0'); assert.equal(state.goals.revision, 8);
});

test('browser permission fixture distinguishes unavailable storage from a signed-out session', async () => {
  const { state, request } = await fixture();
  state.sessionFailure = { status: 503, body: { error: '权限服务暂时不可用。', code: 'ACCOUNT_ACCESS_UNAVAILABLE' } };
  assert.deepEqual(await request('/api/session'), { status: 503, body: state.sessionFailure.body });
  state.sessionFailure = null;
  assert.equal((await request('/api/session')).body.userId, state.owner);
  state.sessionFailure = { status: 401, body: { error: '请重新登录。', code: 'SIGN_IN_REQUIRED' } };
  assert.equal((await request('/api/session')).status, 401);
});
