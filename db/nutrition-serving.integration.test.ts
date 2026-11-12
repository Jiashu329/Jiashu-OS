import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { calculateFoodSelection, foodSelectionFromSnapshot, LEGACY_FOOD_CATALOG_RELEASE, searchFoods } from '../lib/food-catalog.ts';
import { parseNutritionCreate, presentNutritionEntry } from '../lib/nutrition.ts';
import { parseNutritionTemplate, parseNutritionTemplatePreview } from '../lib/nutrition-templates.ts';
import { BACKUP_TABLE_NAMES, comparableBackupRow, parseDataBackup } from '../lib/data-backup.ts';
import type { DataBackup } from '../lib/data-backup.ts';
import { addNutritionFavorite, createNutritionBatch, createNutritionEntry, listNutritionEntries, listNutritionFavorites, readNutritionEntry, readNutritionHistory, replaceNutritionEntry } from './nutrition-store.ts';
import { copyNutritionMeal, previewNutritionCopy } from './nutrition-reuse-store.ts';
import { createNutritionTemplate, previewStoredNutritionTemplate, readNutritionTemplate } from './nutrition-templates-store.ts';
import { exportDataBackup, previewDataRestore, restoreDataBackup } from './data-backup-store.ts';

const NOW = '2026-11-10T04:00:00.000Z', LATER = '2026-11-10T05:00:00.000Z', DAY = '2026-11-10';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444', E = '55555555-5555-4555-8555-555555555555';
interface Statement { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; execute(): { results: unknown[]; meta: { changes: number } } }
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');t.after(() => sqlite.close());
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  const db = { prepare(sql: string) {
    const prepared = sqlite.prepare(sql);let values: SQLInputValue[] = [];
    const statement: Statement = { bind(...parameters) { values = parameters as SQLInputValue[];return statement; }, async first<T>() { return prepared.get(...values) as T ?? null; }, async all<T>() { return { results: prepared.all(...values) as T[] }; }, execute() { const changes = Number(sqlite.prepare('SELECT total_changes() n').get()!.n);const results = prepared.columns().length ? prepared.all(...values) : (prepared.run(...values), []);return { results, meta: { changes: Number(sqlite.prepare('SELECT total_changes() n').get()!.n) - changes } }; } };return statement;
  }, async batch(commands: Statement[]) { sqlite.exec('BEGIN');try { const result = commands.map((command) => command.execute());sqlite.exec('COMMIT');return result; } catch (error) { sqlite.exec('ROLLBACK');throw error; } } } as unknown as D1Database;
  return { sqlite, db };
}
const semantic = (backup: DataBackup) => Object.fromEntries(BACKUP_TABLE_NAMES.map((table) => [table, backup.tables[table].map((row) => comparableBackupRow(table, row))]));

void test('official serving food survives save/edit/favorite/template/copy and full empty-database restoration without manufactured weights', async (t) => {
  const source = fixture(t), food = searchFoods('巨无霸', 50).find((item) => item.basis === 'perServing');assert.ok(food);
  const payload = (amount: number) => ({ date: DAY, meal: 'lunch', name: food.name, portion: amount + '份', note: '官网标准份，克重未知', calories: null, carbs: null, protein: null, fat: null, food: { id: food.id, amount, unit: '份', catalogRelease: food.catalogRelease }, provenance: { calories: { source: 'catalog' } } });
  const initial = parseNutritionCreate(payload(1)), created = await createNutritionEntry(source.db, 'alice', initial, A, NOW);
  assert.equal(created.entry.food?.grams, null);assert.equal(created.entry.food?.kcalPer100g, null);assert.equal(created.entry.caloriesTenth, 5130);
  const edited = await replaceNutritionEntry(source.db, 'alice', A, parseNutritionCreate(payload(0.5)), 1, LATER);assert.ok(edited);
  assert.equal(edited.food?.amount, 0.5);assert.equal(edited.caloriesTenth, 2565);
  assert.equal((await createNutritionEntry(source.db, 'alice', initial, A, LATER)).replayed, true);
  assert.equal((await readNutritionHistory(source.db, 'alice', A))!.length, 2);
  const favorite = await addNutritionFavorite(source.db, 'alice', A, LATER);assert.ok(favorite);
  assert.equal(favorite.food?.grams, null);assert.equal(favorite.food?.basis, 'perServing');
  const visible = presentNutritionEntry(edited), definition = parseNutritionTemplate({ kind: 'meal', name: '麦当劳午餐模板', note: '保留每份来源', baseServings: '1', totalWeight: null, components: [{ name: visible.name, portion: visible.portion, grams: null, calories: visible.calories, carbs: visible.carbs, protein: visible.protein, fat: visible.fat, food: foodSelectionFromSnapshot(edited.food!), provenance: edited.provenance }] });
  await createNutritionTemplate(source.db, 'alice', definition, B, LATER);
  const previewInput = parseNutritionTemplatePreview({ mode: 'servings', amount: '2', date: DAY, meal: 'lunch', expectedRevision: 1 });
  const preview = await previewStoredNutritionTemplate(source.db, 'alice', B, previewInput);assert.ok(preview);
  assert.equal(preview.rows[0].portion, '1份');assert.equal(preview.rows[0].food?.amount, 1);assert.equal(preview.rows[0].calories, '513.0');
  await assert.rejects(previewStoredNutritionTemplate(source.db, 'alice', B, { ...previewInput, mode: 'weight', amount: '100' }), /成品总重量/);
  await createNutritionBatch(source.db, 'alice', preview.rows.map((row) => parseNutritionCreate(row)), C, LATER);
  const selection = { fromDate: DAY, fromMeal: 'lunch' as const, toDate: DAY, toMeal: 'dinner' as const }, copyPreview = await previewNutritionCopy(source.db, 'alice', selection);
  const copied = await copyNutritionMeal(source.db, 'alice', selection, copyPreview.previewToken, D, LATER);
  assert.equal(copied.entries.length, 2);for (const item of copied.entries) { assert.equal(item.food?.grams, null);assert.equal(item.food?.kcalPer100g, null); }
  // A pre-versioning TFDA entry shares the same complete backup, retaining its original missing release field.
  const rice = searchFoods('白饭', 20).find((item) => item.basis !== 'perServing');assert.ok(rice);
  const legacy = parseNutritionCreate({ date: DAY, meal: 'breakfast', name: rice.name, calories: null, food: { id: rice.id, amount: 100, unit: 'g' } });
  assert.equal(Object.hasOwn(legacy.food!, 'catalogRelease'), false);
  const legacyBytes = JSON.stringify(legacy.food);await createNutritionEntry(source.db, 'alice', legacy, E, NOW);
  const backup = await exportDataBackup(source.db, 'alice', LATER), target = fixture(t), restorePreview = await previewDataRestore(target.db, 'restored', backup);
  assert.equal(restorePreview.canRestore, true);await restoreDataBackup(target.db, 'restored', backup, restorePreview.previewHash);
  assert.deepEqual(semantic(await exportDataBackup(target.db, 'restored', LATER)), semantic(backup));
  const rows = await listNutritionEntries(target.db, 'restored', { from: DAY, to: DAY });
  for (const row of rows.filter((item) => item.food?.basis === 'perServing')) { assert.equal(row.food!.grams, null);assert.equal(row.food!.kcalPer100g, null);assert.deepEqual(row.food!.source, food.source); }
  assert.equal(JSON.stringify((await readNutritionEntry(target.db, 'restored', E))!.food), legacyBytes);
  assert.equal((await readNutritionTemplate(target.db, 'restored', B))!.components[0].grams, null);
  assert.equal((await listNutritionFavorites(target.db, 'restored'))[0].food?.grams, null);
  assert.equal(await readNutritionEntry(target.db, 'other-user', A), null);
  assert.equal((await createNutritionEntry(target.db, 'restored', initial, A, LATER)).replayed, true);
  assert.equal((await createNutritionEntry(target.db, 'restored', legacy, E, LATER)).replayed, true);
  assert.equal((await createNutritionTemplate(target.db, 'restored', definition, B, LATER)).replayed, true);
  assert.equal((await copyNutritionMeal(target.db, 'restored', selection, copyPreview.previewToken, D, LATER)).replayed, true);
  assert.equal((await previewDataRestore(target.db, 'restored', backup)).total.added, 0);
});

void test('serving backups reject invented grams, invented per-100g values and modified official serving bases before restoration', async (t) => {
  const source = fixture(t), food = searchFoods('巨无霸', 50).find((item) => item.basis === 'perServing');assert.ok(food);
  const input = parseNutritionCreate({ date: DAY, meal: 'lunch', name: food.name, calories: null, food: { id: food.id, amount: 1, unit: '份', catalogRelease: food.catalogRelease } });
  await createNutritionEntry(source.db, 'alice', input, A, NOW);
  const backup = await exportDataBackup(source.db, 'alice', NOW);
  const snapshot = calculateFoodSelection({ id: food.id, amount: 1, unit: '份', catalogRelease: food.catalogRelease });assert.ok(snapshot.basis === 'perServing');
  for (const change of [{ grams: 200 }, { kcalPer100g: 256.5 }, { serving: { ...snapshot.serving, kcal: 1 } }]) {
    const bad = structuredClone(backup), row = bad.tables.nutrition_entries[0];row.food_json = JSON.stringify({ ...JSON.parse(row.food_json as string), ...change });
    assert.throws(() => parseDataBackup(bad));
  }
  const legacyFood = searchFoods('白饭', 20).find((item) => item.basis !== 'perServing');assert.ok(legacyFood);
  const legacySnapshot = calculateFoodSelection({ id: legacyFood.id, amount: 100, unit: 'g', catalogRelease: LEGACY_FOOD_CATALOG_RELEASE });
  assert.equal(Object.hasOwn(legacySnapshot, 'basis'), false);assert.equal(typeof legacySnapshot.grams, 'number');
});
