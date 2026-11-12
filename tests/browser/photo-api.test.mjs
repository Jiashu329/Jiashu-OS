import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSyntheticPhoto, syntheticPhotoAnswer } from './photo-api.mjs';
import { syntheticState, interceptSyntheticAPI, DAY } from './synthetic-api.mjs';
import { syntheticPhotoPNG, jpegDimensions } from './photo-fixture.mjs';
import { TINY_JPEG_DATA_URL } from '../fixtures/nutrition-photo.ts';

function fixture() {
  const state = { entries: [] };
  return { state, async request(body, path = '/api/health/nutrition/photo') {
    let result;
    const handled = await handleSyntheticPhoto({ state, url: new URL(path, 'http://127.0.0.1:4175'), method: 'POST', body,
      route: { abort: async (reason) => { result = { aborted: reason }; } },
      send: async (value, status = 200) => { result = { status, body: value }; },
      fail: async (error, code, status = 409) => { result = { status, body: { error, code } }; } });
    return { handled, ...result };
  } };
}
const input = () => ({ image: { dataUrl: TINY_JPEG_DATA_URL }, text: '只吃了一半', date: DAY, meal: 'dinner' });

test('photo acceptance mocks use real JPEG validation and visual-result parsing without writing meals', async () => {
  const f = fixture(), answer = syntheticPhotoAnswer();
  answer.items[0].estimate.carbs = null; answer.items[0].estimate.fat = 0; f.state.photoAnswer = answer;
  const result = await f.request(input());
  assert.equal(result.status, 200); assert.equal(result.body.drafts.length, 1);
  assert.deepEqual(Object.fromEntries(['date','meal','calories','carbs','protein','fat','amount','unit','food'].map((key) => [key, result.body.drafts[0][key]])),
    { date: DAY, meal: 'dinner', calories: '450.0', carbs: null, protein: '25.0', fat: '0.0', amount: null, unit: null, food: null });
  assert.equal(result.body.drafts[0].provenance.calories.source, 'ai');
  assert.equal(result.body.drafts[0].provenance.carbs.source, 'unknown');
  assert.equal(f.state.entries.length, 0); assert.equal((await f.request(input(), '/api/unrelated')).handled, false);
  assert.deepEqual(jpegDimensions(TINY_JPEG_DATA_URL), { width: 1, height: 1 });
  const png = syntheticPhotoPNG(2200, 1100);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 2200); assert.equal(png.readUInt32BE(20), 1100);
});

test('invalid, nonfood and failed recognition paths cannot create an inferred consumption record', async () => {
  const f = fixture();
  assert.equal((await f.request({ ...input(), image: { dataUrl: 'data:image/jpeg;base64,PHN2Zz48L3N2Zz4=' } })).status, 400);
  f.state.photoEmpty = true; assert.equal((await f.request(input())).body.drafts.length, 0);
  f.state.photoEmpty = false; f.state.photoFailure = { status: 429, code: 'AI_RATE_LIMITED', message: '合成额度已到限制。' };
  const limited = await f.request(input()); assert.equal(limited.status, 429); assert.equal(limited.body.code, 'AI_RATE_LIMITED');
  const retry = await f.request(input()); assert.equal(retry.status, 200); assert.equal(retry.body.drafts.length, 1);
  assert.equal(f.state.entries.length, 0);
});

test('the shared synthetic interceptor short-circuits the photo route and blocks external image destinations', async () => {
  const state = syntheticState(); let handler;
  await interceptSyntheticAPI({ route: async (_pattern, callback) => { handler = callback; } }, state);
  let result;
  await handler({
    request: () => ({ url: () => 'http://127.0.0.1:4175/api/health/nutrition/photo', method: () => 'POST', postDataJSON: input, headers: () => ({}) }),
    fulfill: async (value) => { result = { status: value.status, body: JSON.parse(value.body) }; }, abort: async (reason) => { result = { aborted: reason }; },
  });
  assert.equal(result.status, 200); assert.equal(result.body.drafts[0].meal, 'dinner'); assert.equal(state.entries.length, 0);
  await handler({ request: () => ({ url: () => 'https://images.example.invalid/food.jpg' }), abort: async (reason) => { result = { aborted: reason }; } });
  assert.equal(result.aborted, 'blockedbyclient'); assert.deepEqual(state.externalRequests, ['https://images.example.invalid']);
});
