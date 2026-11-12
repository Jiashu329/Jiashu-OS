import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSyntheticNutritionTemplates, syntheticNutritionTemplate } from './nutrition-templates-api.mjs';

function fixture() {
  const state = { templates: [syntheticNutritionTemplate()] };
  return { state, async request(path, method = 'GET', body = null, key = null) {
    let result;
    const handled = await handleSyntheticNutritionTemplates({ state, url: new URL(path, 'http://127.0.0.1:4175'), method, body, key,
      route: { abort: async (reason) => { result = { aborted: reason }; } },
      send: async (value, status = 200) => { result = { status, body: value }; },
      fail: async (error, code, status = 409) => { result = { status, body: { error, code } }; },
    });
    return { handled, ...result };
  } };
}

test('template browser fixture uses production scaling and keeps preview read-only', async () => {
  const app = fixture(), original = structuredClone(app.state.templates[0]), id = original.id;
  const result = await app.request('/api/health/nutrition/templates/' + id + '/preview', 'POST', { mode: 'weight', amount: '75', date: '2026-11-11', meal: 'breakfast', expectedRevision: 1 });
  assert.equal(result.body.preview.rows.length, 2); assert.equal(result.body.preview.rows[0].calories, '25.0'); assert.equal(result.body.preview.rows[0].fat, '0.0'); assert.equal(result.body.preview.rows[1].carbs, null);
  assert.deepEqual(app.state.templates[0], original);
  assert.equal((await app.request('/api/other')).handled, false);
});

test('template fixture replays original confirmed receipts after response loss without editing current versions', async () => {
  const app = fixture(), original = app.state.templates[0], id = original.id;
  const definition = { kind: original.kind, name: '原编辑', note: original.note, baseServings: original.baseServings, totalWeight: original.totalWeight, components: original.components, expectedRevision: 1 };
  const key = '99999999-9999-4999-8999-999999999999';
  app.state.loseNextTemplateReply = true;
  assert.equal((await app.request('/api/health/nutrition/templates/' + id, 'PUT', definition, key)).aborted, 'connectionreset');
  assert.equal(app.state.templates[0].revision, 2);
  app.state.templates[0].name = '更新的版本'; app.state.templates[0].revision = 3;
  const retry = await app.request('/api/health/nutrition/templates/' + id, 'PUT', definition, key);
  assert.equal(retry.body.replayed, true); assert.equal(retry.body.template.name, '原编辑'); assert.equal(retry.body.template.revision, 2); assert.equal(app.state.templates[0].name, '更新的版本');
  assert.equal((await app.request('/api/health/nutrition/templates/' + id, 'PUT', { ...definition, name: '替换请求' }, key)).status, 409);
  assert.equal((await app.request('/api/health/nutrition/templates/' + id, 'DELETE', { expectedRevision: 3 }, '77777777-7777-4777-8777-777777777777')).body.template.revision, 4);
  assert.equal((await app.request('/api/health/nutrition/templates')).body.templates.length, 0);
  assert.equal((await app.request('/api/health/nutrition/templates?includeArchived=1')).body.templates.length, 1);
});
