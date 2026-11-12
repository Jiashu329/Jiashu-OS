import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInThisContext } from 'node:vm';
import * as rules from './nutrition.ts';
import * as templates from './nutrition-templates.ts';
import { NutritionConflictError } from '../db/nutrition-store.ts';
const ORIGIN = 'https://synthetic-nutrition.example', ID = '11111111-1111-4111-8111-111111111111';
type Route = Record<string, (...args: unknown[]) => Promise<Response>>;
function load(path: string, bindings: Record<string, unknown>): Route {
  const raw = readFileSync(new URL(path, import.meta.url), 'utf8');
  const exports = [...raw.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map((m) => m[1]);
  const source = stripTypeScriptTypes(raw, { mode: 'strip' }).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return runInThisContext('(function(' + Object.keys(bindings).join(',') + '){' + source + ';return{' + exports.join(',') + '}})')(...Object.values(bindings));
}
const definition = () => ({ kind: 'food', name: 'my food', note: '', baseServings: '1', totalWeight: '100', components: [{ name: 'oats', portion: '', grams: '100', calories: '50', carbs: null, protein: '3', fat: '0', provenance: { calories: { source: 'label' } } }] });
function fixture() {
  let owner: string | null = 'alice', calls = 0, fail: unknown = null, missing = false; const writes: unknown[][] = [];
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const common = { ...rules, ...templates, NutritionConflictError, json, unavailable: () => json({ error: 'storage' }, 503), invalidOrigin: () => json({ error: 'origin' }, 403), isSameOrigin: (r: Request) => r.headers.get('origin') === ORIGIN };
  const shared = load('../app/api/health/nutrition/_shared.ts', { ...common, env: { DB: {} } });
  const template = { ...templates.parseNutritionTemplate(definition()), id: ID, revision: 1, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', archivedAt: null };
  function result(args: unknown[]) { writes.push(args); if (fail) throw fail; return missing ? null : { template, replayed: false }; }
  const bindings = { ...common, ...shared, apiUser: async () => owner ? { userId: owner } : null, unauthenticated: () => json({ error: 'sign in' }, 401), nutritionDatabase() { calls++; return {}; },
    listNutritionTemplates: async (...args: unknown[]) => { writes.push(args); if (fail) throw fail; return [template]; },
    readNutritionTemplate: async (...args: unknown[]) => { writes.push(args); if (fail) throw fail; return missing ? null : template; },
    createNutritionTemplate: async (...args: unknown[]) => result(args), replaceNutritionTemplate: async (...args: unknown[]) => result(args), archiveNutritionTemplate: async (...args: unknown[]) => result(args),
    previewStoredNutritionTemplate: async (...args: unknown[]) => { writes.push(args); if (fail) throw fail; return missing ? null : templates.previewNutritionTemplate(template, args[3] as templates.NutritionTemplatePreviewInput); } };
  const list = load('../app/api/health/nutrition/templates/route.ts', bindings), detail = load('../app/api/health/nutrition/templates/[id]/route.ts', bindings), preview = load('../app/api/health/nutrition/templates/[id]/preview/route.ts', bindings);
  const request = (body?: unknown, headers: Record<string, string> = {}, method = 'POST') => new Request(ORIGIN + '/api/health/nutrition/templates', { method, headers: { origin: ORIGIN, 'content-type': 'application/json', 'idempotency-key': ID, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const context = (id = ID) => ({ params: Promise.resolve({ id }) });
  return { list, detail, preview, request, context, writes, calls: () => calls, signIn(value: string | null) { owner = value; }, fail(value: unknown) { fail = value; }, missing() { missing = true; } };
}
test('template routes authenticate before lookup or mutation and guard every JSON POST/PUT/DELETE', async () => {
  const f = fixture(); f.signIn(null);
  assert.equal((await f.list.GET(f.request())).status, 401); assert.equal((await f.list.POST(f.request(definition()))).status, 401);
  assert.equal((await f.detail.GET(f.request(), f.context())).status, 401); assert.equal((await f.detail.PUT(f.request(definition(), {}, 'PUT'), f.context())).status, 401);
  assert.equal((await f.detail.DELETE(f.request({ expectedRevision: 1 }, {}, 'DELETE'), f.context())).status, 401);
  assert.equal((await f.preview.POST(f.request({}), f.context())).status, 401); assert.equal(f.calls(), 0);
  f.signIn('alice');
  assert.equal((await f.list.POST(f.request(definition(), { origin: 'https://other.example' }))).status, 403);
  assert.equal((await f.detail.PUT(f.request({ ...definition(), expectedRevision: 1 }, { 'content-type': 'text/plain' }, 'PUT'), f.context())).status, 415);
  assert.equal((await f.detail.DELETE(f.request({ expectedRevision: 1 }, { origin: '' }, 'DELETE'), f.context())).status, 403);
  assert.equal((await f.preview.POST(f.request({}, { origin: '' }), f.context())).status, 403); assert.equal(f.calls(), 0);
});
test('all writes require valid idempotency keys and valid record IDs before database access', async () => {
  const f = fixture(); const headers = { 'idempotency-key': 'bad' };
  assert.equal((await f.list.POST(f.request(definition(), headers))).status, 400);
  assert.equal((await f.detail.PUT(f.request({ ...definition(), expectedRevision: 1 }, headers, 'PUT'), f.context())).status, 400);
  assert.equal((await f.detail.DELETE(f.request({ expectedRevision: 1 }, headers, 'DELETE'), f.context())).status, 400);
  assert.equal((await f.detail.GET(f.request(), f.context('bad'))).status, 404);
  assert.equal((await f.preview.POST(f.request({}), f.context('bad'))).status, 404); assert.equal(f.calls(), 0);
});
test('create/edit/archive use canonical definitions, current owner, revisions and exact operation keys', async () => {
  const f = fixture(); assert.equal((await f.list.POST(f.request(definition()))).status, 200);
  assert.equal((f.writes[0][2] as templates.NutritionTemplateDefinition).components[0].calories, '50.0'); assert.equal(f.writes[0][1], 'alice'); assert.equal(f.writes[0][3], ID);
  assert.equal((await f.detail.PUT(f.request({ ...definition(), expectedRevision: 3 }, {}, 'PUT'), f.context())).status, 200);
  assert.equal(f.writes[1][4], 3); assert.equal(f.writes[1][5], ID);
  assert.equal((await f.detail.DELETE(f.request({ expectedRevision: 4 }, {}, 'DELETE'), f.context())).status, 200);
  assert.equal(f.writes[2][3], 4); assert.equal(f.writes[2][4], ID);
});
test('preview requires no mutation key, returns batch rows and calls only pure preview backend', async () => {
  const f = fixture(); const response = await f.preview.POST(f.request({ mode: 'weight', amount: '50', date: '2026-11-10', meal: 'dinner', expectedRevision: 1 }, { 'idempotency-key': '' }), f.context());
  assert.equal(response.status, 200); const body = await response.json() as { preview: templates.NutritionTemplatePreview };
  assert.equal(body.preview.rows[0].calories, '25.0'); assert.equal(body.preview.rows[0].meal, 'dinner'); assert.equal(f.writes.length, 1);
});
test('strict payload validation and byte limits prevent oversized or malformed writes', async () => {
  const f = fixture();
  assert.equal((await f.list.POST(f.request({ ...definition(), unexpected: true }))).status, 400);
  assert.equal((await f.detail.PUT(f.request({ ...definition(), expectedRevision: 0 }, {}, 'PUT'), f.context())).status, 400);
  assert.equal((await f.detail.DELETE(f.request({ expectedRevision: 1, name: 'oops' }, {}, 'DELETE'), f.context())).status, 400);
  assert.equal((await f.list.POST(f.request(definition(), { 'content-length': '65537' }))).status, 413);
  assert.equal((await f.preview.POST(f.request({ mode: 'servings', amount: 'NaN', date: '2026-11-10', meal: 'lunch', expectedRevision: 1 }), f.context())).status, 400);
  assert.equal(f.calls(), 0);
});
test('missing templates and backend conflicts are surfaced without silently creating another template', async () => {
  const f = fixture(); f.missing(); assert.equal((await f.detail.GET(f.request(), f.context())).status, 404);
  assert.equal((await f.detail.PUT(f.request({ ...definition(), expectedRevision: 1 }, {}, 'PUT'), f.context())).status, 404);
  f.fail(new NutritionConflictError('changed in another tab')); assert.equal((await f.detail.DELETE(f.request({ expectedRevision: 1 }, {}, 'DELETE'), f.context())).status, 409);
  const response = await f.list.GET(new Request(ORIGIN + '/api/health/nutrition/templates?includeArchived=1')); assert.equal(response.status, 409);
});
