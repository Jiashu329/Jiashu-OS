import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test, { type TestContext } from 'node:test';
import { runInThisContext } from 'node:vm';
import { SQLiteD1Database } from '../../../../../selfhost/database.ts';
import * as recipes from '../../../../../db/nutrition-recipes-store.ts';
import * as validation from '../../../../../lib/nutrition-recipes.ts';
import { validNutritionId } from '../../../../../lib/nutrition.ts';
import { NutritionPhotoImageError } from '../../../../../lib/nutrition-photo-image.ts';
import { TINY_JPEG_DATA_URL } from '../../../../../tests/fixtures/nutrition-photo.ts';

const ORIGIN = 'https://recipes.synthetic.example';
const ID = '11111111-1111-4111-8111-111111111111';
const PATH = '/api/health/nutrition/recipes';
const SOURCE = 'https://www.xiachufang.com/recipe/107271414/';

function load<T>(path: string, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return runInThisContext('(function(' + Object.keys(bindings).join(',') + '){' + source
    + '\nreturn {' + names.join(',') + '};})')(...Object.values(bindings)) as T;
}

type Handler = (request: Request) => Promise<Response>;
type PhotoHandler = (request: Request, context: { params: Promise<{ id: string; cookingId: string }> }) => Promise<Response>;

function fixture(t: TestContext) {
  const db = new SQLiteD1Database(':memory:');
  t.after(() => db.close());
  db.transaction(() => db.executeMigrationSQL(readFileSync(new URL('../../../../../drizzle/0037_nutrition_recipes.sql', import.meta.url), 'utf8')));
  let userId: string | null = 'alice';
  const base = load<Record<string, unknown>>('../../../_shared.ts', {
    getChatGPTUser: async () => userId ? { userId } : null,
    getChatGPTAccess: async () => ({ identity: null }),
  }, ['apiUser', 'json', 'unauthenticated', 'unavailable', 'isSameOrigin', 'invalidOrigin']);
  const nutrition = load<Record<string, unknown>>('../_shared.ts', { ...base, env: { DB: db }, validNutritionId }, [
    'nutritionBody', 'nutritionDatabase', 'nutritionGuard', 'nutritionRequestId', 'invalidNutritionRequestId',
  ]);
  const common = { ...base, ...nutrition, ...recipes, ...validation, validNutritionId, NutritionPhotoImageError };
  const shared = load<Record<string, unknown>>('./_shared.ts', common, ['recipeId', 'recipeRead', 'recipeWrite']);
  const collection = load<{ GET: Handler; POST: Handler }>('./route.ts', { ...common, ...shared }, ['GET', 'POST']);
  const photo = load<{ GET: PhotoHandler }>('./[id]/cookings/[cookingId]/photo/route.ts', { ...common, ...shared }, ['GET']);
  const context = { params: Promise.resolve({ id: ID, cookingId: ID }) };
  return { ...collection, openPhoto: () => photo.GET(new Request(ORIGIN + PATH), context), signIn(id: string | null) { userId = id; } };
}

function submit(body: object, extraHeaders: Record<string, string> = {}) {
  return new Request(ORIGIN + PATH, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': ID, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

void test('recipe write guards auth, exact Origin, JSON type, stable operation and page owner before saving', async (t) => {
  const f = fixture(t), body = { title: 'Synthetic recipe' };
  f.signIn(null);
  assert.equal((await f.POST(submit(body))).status, 401);
  f.signIn('alice');
  assert.equal((await f.POST(submit(body, { Origin: 'https://foreign.synthetic.example' }))).status, 403);
  assert.equal((await f.POST(submit(body, { 'Content-Type': 'application/json-other' }))).status, 415);
  assert.equal((await f.POST(submit(body, { 'X-Page-Owner': 'bob' }))).status, 409);
  assert.equal((await f.POST(submit(body, { 'Idempotency-Key': 'wrong' }))).status, 400);
  const list = await f.GET(new Request(ORIGIN + PATH));
  assert.deepEqual(await list.json(), { recipes: [], nextOffset: null });
});

void test('source lookup and photo responses are private and all metadata stays free of image bytes', async (t) => {
  const f = fixture(t), body = { title: 'Synthetic recipe', sourceUrl: SOURCE, photoDataUrl: TINY_JPEG_DATA_URL };
  const saved = await f.POST(submit(body));
  assert.equal(saved.status, 200);
  assert.doesNotMatch(await saved.text(), /data:image|photoDataUrl/);
  const lookup = () => f.GET(new Request(ORIGIN + PATH + '?' + new URLSearchParams({ sourceUrl: SOURCE })));
  const existing = await lookup();
  assert.equal(existing.status, 200);
  assert.equal(existing.headers.get('cache-control'), 'no-store');
  assert.equal((await existing.json() as { recipe: { id: string } }).recipe.id, ID);
  const photo = await f.openPhoto();
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await photo.json(), { photoDataUrl: TINY_JPEG_DATA_URL });
  f.signIn('bob');
  assert.equal((await lookup()).status, 404);
  assert.equal((await f.openPhoto()).status, 404);
  f.signIn(null);
  assert.equal((await f.openPhoto()).status, 401);
});
