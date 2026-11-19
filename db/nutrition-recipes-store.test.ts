import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { SQLiteD1Database } from '../selfhost/database.ts';
import { MAX_RECIPE_PHOTO_STORAGE_CHARS, parseRecipeCreation, parseRecipeDefinition, parseRecipeList, parseRecipePhoto } from '../lib/nutrition-recipes.ts';
import { TINY_JPEG_DATA_URL } from '../tests/fixtures/nutrition-photo.ts';
import { addRecipeCooking, changeRecipe, changeRecipeCooking, createRecipe, listRecipes, readRecipe, readRecipeBySource, readRecipePhoto, RecipeConflictError } from './nutrition-recipes-store.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-11-19T10:00:00.000Z';
const SOURCE = 'https://www.xiachufang.com/recipe/107271414/?tracking=example';
const PHOTO = parseRecipePhoto(TINY_JPEG_DATA_URL);
const definition = parseRecipeDefinition({ title: '清炒茄子', servings: '2 份', ingredients: '茄子\n葱', steps: '切块\n炒软' });
const linked = parseRecipeCreation({ ...definition, sourceUrl: SOURCE, sourceTitle: '原菜谱标题', sourceAuthor: '原作者' });

function fixture(t: TestContext) {
  const db = new SQLiteD1Database(':memory:');
  t.after(() => db.close());
  db.transaction(() => db.executeMigrationSQL(readFileSync(new URL('../drizzle/0037_nutrition_recipes.sql', import.meta.url), 'utf8')));
  return db;
}

function select(query = '') {
  return parseRecipeList(new URLSearchParams(query));
}

void test('linked recipes deduplicate normalized sources per account while keeping exact create retries safe', async (t) => {
  const db = fixture(t);
  const results = await Promise.all([createRecipe(db, 'alice', linked, A, NOW), createRecipe(db, 'alice', linked, A, NOW)]);
  assert.equal(results.filter(result => result.replayed).length, 1);
  assert.equal(results[0].recipe.sourceUrl, 'https://www.xiachufang.com/recipe/107271414/');
  assert.equal(results[0].recipe.sourceTitle, '原菜谱标题');
  assert.equal(results[0].recipe.sourceAuthor, '原作者');
  assert.equal(results[0].recipe.ingredients, definition.ingredients);
  assert.equal(await readRecipe(db, 'bob', A), null);
  const alias = parseRecipeCreation({ title: '同一菜谱', sourceUrl: 'https://m.xiachufang.com/recipe/107271414/' });
  await assert.rejects(createRecipe(db, 'alice', alias, B, NOW), { code: 'RECIPE_ALREADY_SAVED' });
  await assert.rejects(createRecipe(db, 'alice', alias, A, NOW), RecipeConflictError);
  assert.equal((await readRecipeBySource(db, 'alice', alias.sourceKey!))?.id, A);
  assert.equal(await readRecipeBySource(db, 'bob', alias.sourceKey!), null);
  await createRecipe(db, 'bob', alias, B, NOW);
  assert.equal((await readRecipeBySource(db, 'bob', alias.sourceKey!))?.id, B);
  assert.deepEqual((await listRecipes(db, 'alice', select('source=linked&q=原作者'))).recipes.map(item => item.id), [A]);
  assert.deepEqual((await listRecipes(db, 'bob', select('source=xiachufang'))).recipes.map(item => item.id), [B]);
  assert.deepEqual((await listRecipes(db, 'alice', select('q=%25'))).recipes, [], 'Search treats query text literally');
});

void test('link saves, own cooking notes and photo are isolated, discoverable and never enter receipts or metadata', async (t) => {
  const db = fixture(t);
  const own = parseRecipeCreation({ ...definition, photoDataUrl: PHOTO, cookingNote: '今天用少量油' });
  const saved = await createRecipe(db, 'alice', own, A, NOW);
  await createRecipe(db, 'alice', linked, B, NOW);
  assert.equal(saved.recipe.source, 'own');
  assert.equal(saved.recipe.coverCookingId, A);
  assert.equal(saved.recipe.cookings[0].note, '今天用少量油');
  assert.equal(saved.recipe.cookings[0].hasPhoto, true);
  assert.doesNotMatch(JSON.stringify(saved), /data:image|photoDataUrl/);
  assert.equal(await readRecipePhoto(db, 'alice', A, A), PHOTO);
  assert.equal(await readRecipePhoto(db, 'bob', A, A), null);
  assert.equal(await readRecipePhoto(db, 'alice', B, A), null);
  assert.equal(await addRecipeCooking(db, 'bob', B, C, { note: 'wrong owner', photoDataUrl: PHOTO }, NOW), null);
  const linkedCooking = await addRecipeCooking(db, 'alice', B, C, { note: '按链接做的', photoDataUrl: PHOTO }, NOW);
  assert.equal(linkedCooking?.recipe.coverCookingId, C);
  assert.equal(linkedCooking?.recipe.revision, 2);
  assert.equal((await addRecipeCooking(db, 'alice', B, C, { note: '按链接做的', photoDataUrl: PHOTO }, NOW))?.replayed, true);
  assert.equal(await readRecipePhoto(db, 'alice', B, C), PHOTO);
  const page = await listRecipes(db, 'alice', select('cooked=1&limit=1'));
  assert.deepEqual(page.recipes.map(item => item.id), [B]);
  assert.equal(page.nextOffset, 1);
  assert.deepEqual((await listRecipes(db, 'alice', select('cooked=1&limit=1&offset=1'))).recipes.map(item => item.id), [A]);
  assert.equal((await listRecipes(db, 'alice', select('cooked=1&limit=1&offset=1'))).nextOffset, null);
  const rows = db.sqlite.prepare('SELECT result_json FROM nutrition_recipe_operations').all();
  assert.deepEqual(rows.map(row => JSON.parse(String(row.result_json))), [
    { recipeId: A, cookingId: A }, { recipeId: B, cookingId: null }, { recipeId: B, cookingId: C },
  ]);
});

void test('CAS prevents overwrites and archives wipe photo bytes while exact receipts remain valid', async (t) => {
  const db = fixture(t);
  await createRecipe(db, 'alice', linked, A, NOW);
  const add = await addRecipeCooking(db, 'alice', A, B, { note: '初次', photoDataUrl: PHOTO }, NOW);
  assert.equal(add?.recipe.revision, 2);
  await assert.rejects(changeRecipe(db, 'alice', A, C, 1, definition, NOW), RecipeConflictError);
  const edit = await changeRecipe(db, 'alice', A, C, 2, { ...definition, title: '更新菜名' }, NOW);
  assert.equal(edit?.recipe.revision, 3);
  assert.equal(edit?.recipe.source, 'xiachufang');
  assert.equal((await changeRecipe(db, 'alice', A, C, 2, { ...definition, title: '更新菜名' }, NOW))?.replayed, true);
  const cookingEdit = { note: '照片继续保留', photoDataUrl: undefined };
  assert.equal(await changeRecipeCooking(db, 'bob', A, B, D, 1, cookingEdit, NOW), null);
  const cooked = await changeRecipeCooking(db, 'alice', A, B, D, 1, cookingEdit, NOW);
  assert.equal(cooked?.recipe.cookings[0].revision, 2);
  assert.equal(await readRecipePhoto(db, 'alice', A, B), PHOTO);
  await assert.rejects(changeRecipeCooking(db, 'alice', A, B, E, 1, null, NOW), RecipeConflictError);
  assert.equal((await changeRecipeCooking(db, 'alice', A, B, E, 2, null, NOW))?.recipe.cookings.length, 0);
  assert.equal(await readRecipePhoto(db, 'alice', A, B), null);
  assert.equal((await changeRecipeCooking(db, 'alice', A, B, E, 2, null, NOW))?.replayed, true);
  const another = randomUUID();
  const again = await addRecipeCooking(db, 'alice', A, another, { note: '又做了一次', photoDataUrl: PHOTO }, NOW);
  const archiveId = randomUUID();
  const archived = await changeRecipe(db, 'alice', A, archiveId, again!.recipe.revision, null, NOW);
  assert.equal(archived?.recipe.archivedAt, NOW);
  assert.equal((await changeRecipe(db, 'alice', A, archiveId, again!.recipe.revision, null, NOW))?.replayed, true);
  assert.equal(await readRecipe(db, 'alice', A), null);
  assert.equal(await readRecipePhoto(db, 'alice', A, another), null);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM nutrition_recipe_cookings WHERE photo_data_url IS NOT NULL').get()?.n, 0);
  assert.equal((await createRecipe(db, 'alice', linked, randomUUID(), NOW)).replayed, false, 'The archived link may be saved again');
});

void test('photo budget is owner-scoped and a failed write leaves no receipt or partial cooking record', async (t) => {
  const db = fixture(t);
  await createRecipe(db, 'alice', linked, A, NOW);
  const insert = db.sqlite.prepare(`INSERT INTO nutrition_recipe_cookings
    (id,user_id,recipe_id,note,photo_data_url,revision,created_at,updated_at) VALUES(?,'alice',?,'fixture',?,1,?,?)`);
  const size = MAX_RECIPE_PHOTO_STORAGE_CHARS / 24;
  const ids = Array.from({ length: 24 }, () => randomUUID());
  for (const id of ids) insert.run(id, A, 'x'.repeat(size), NOW, NOW);
  const cooking = { note: '新菜', photoDataUrl: PHOTO };
  await assert.rejects(addRecipeCooking(db, 'alice', A, B, cooking, NOW), { code: 'RECIPE_PHOTO_STORAGE_FULL' });
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM nutrition_recipe_operations').get()?.n, 1);
  assert.equal((await readRecipe(db, 'alice', A))?.cookingCount, 24);
  await createRecipe(db, 'bob', parseRecipeCreation({ title: 'Bob 的菜', photoDataUrl: PHOTO }), C, NOW);
  await changeRecipeCooking(db, 'alice', A, ids[0], D, 1, null, NOW);
  assert.equal((await addRecipeCooking(db, 'alice', A, B, cooking, NOW))?.recipe.cookingCount, 24);
});
