import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticState, interceptSyntheticAPI, DAY, ACCOUNT_ID } from './synthetic-api.mjs';
import { FinanceMetadataConflictError } from '../../db/finance-store.ts';

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
  await request('/api/health/nutrition/' + entryId, 'PATCH', { ...draft, protein: '20', expectedRevision: 1 });
  const restored = await request('/api/health/nutrition/' + entryId + '/restore', 'POST', { revision: 1, expectedRevision: 2 });
  assert.equal(restored.body.entry.revision, 3); assert.equal(restored.body.entry.protein, '10.0');
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
