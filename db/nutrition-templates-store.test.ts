import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { archiveNutritionTemplate, createNutritionTemplate, listNutritionTemplates, previewStoredNutritionTemplate, readNutritionTemplate, replaceNutritionTemplate } from './nutrition-templates-store.ts';
import { NutritionConflictError } from './nutrition-store.ts';
import { parseNutritionTemplate, parseNutritionTemplatePreview } from '../lib/nutrition-templates.ts';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-11-10T00:00:00.000Z';
interface Statement { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; execute(): { results: unknown[]; meta: { changes: number } } }
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const migrationDir = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(migrationDir).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, migrationDir), 'utf8'));
  let hook: (() => void) | null = null;
  const db = { prepare(sql: string) { const stmt = sqlite.prepare(sql); let values: SQLInputValue[] = []; const s: Statement = {
    bind(...v) { values = v as SQLInputValue[]; return s; }, async first<T>() { return (s.execute().results[0] as T) ?? null; }, async all<T>() { return { results: s.execute().results as T[] }; },
    execute() { const before = Number(sqlite.prepare('SELECT total_changes() n').get()?.n); const results = stmt.columns().length ? stmt.all(...values) : (stmt.run(...values), []); return { results, meta: { changes: Number(sqlite.prepare('SELECT total_changes() n').get()?.n) - before } }; },
  }; return s; }, async batch(statements: Statement[]) { const h = hook; hook = null; h?.(); sqlite.exec('BEGIN'); try { const result = statements.map((s) => s.execute()); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } } as unknown as D1Database;
  return { db, sqlite, race(fn: () => void) { hook = fn; }, count() { return Number(sqlite.prepare('SELECT COUNT(*) n FROM nutrition_templates').get()?.n); }, receipts() { return Number(sqlite.prepare('SELECT COUNT(*) n FROM nutrition_template_operations').get()?.n); } };
}
const definition = (name = 'synthetic breakfast') => parseNutritionTemplate({ kind: 'meal', name, note: 'test only', baseServings: '1', totalWeight: '100', components: [{ name: 'oats', portion: 'bowl', grams: '100', calories: null, carbs: '0', protein: '1.2', fat: '3', provenance: { protein: { source: 'label' } } }] });
const preview = () => parseNutritionTemplatePreview({ mode: 'servings', amount: '2', date: '2026-11-10', meal: 'lunch', expectedRevision: 1 });

test('create is idempotent, owner scoped and stores independently of legacy favorites', async (t) => {
  const f = fixture(t); const first = await createNutritionTemplate(f.db, 'alice', definition(), A, NOW);
  assert.equal(first.replayed, false); assert.equal(first.template.components[0].calories, null); assert.equal(first.template.components[0].carbs, '0.0');
  assert.equal((await createNutritionTemplate(f.db, 'alice', definition(), A, NOW)).replayed, true);
  assert.equal(f.count(), 1); assert.equal(f.receipts(), 1);
  assert.equal(await readNutritionTemplate(f.db, 'bob', A), null); assert.deepEqual(await listNutritionTemplates(f.db, 'bob'), []);
  await assert.rejects(createNutritionTemplate(f.db, 'bob', definition(), A, NOW), NutritionConflictError);
  await assert.rejects(createNutritionTemplate(f.db, 'alice', definition('changed body'), A, NOW), NutritionConflictError);
});
test('CAS edit preserves original creation identity and exact receipt retry cannot overwrite newer content', async (t) => {
  const f = fixture(t); await createNutritionTemplate(f.db, 'alice', definition(), A, NOW);
  const edit = await replaceNutritionTemplate(f.db, 'alice', A, definition('version two'), 1, B, NOW);
  assert.equal(edit?.template.revision, 2); assert.equal(edit?.template.createdAt, NOW);
  await replaceNutritionTemplate(f.db, 'alice', A, definition('version three'), 2, C, NOW);
  const retry = await replaceNutritionTemplate(f.db, 'alice', A, definition('version two'), 1, B, NOW);
  assert.equal(retry?.replayed, true); assert.equal(retry?.template.revision, 2);
  assert.equal((await readNutritionTemplate(f.db, 'alice', A))?.name, 'version three');
  await assert.rejects(replaceNutritionTemplate(f.db, 'alice', A, definition('stale'), 1, D, NOW), NutritionConflictError);
  assert.equal(f.receipts(), 3);
});
test('edit and archive never mutate another owner and operation IDs cannot change action or target', async (t) => {
  const f = fixture(t); await createNutritionTemplate(f.db, 'alice', definition(), A, NOW);
  assert.equal(await replaceNutritionTemplate(f.db, 'bob', A, definition('wrong owner'), 1, B, NOW), null);
  assert.equal(await archiveNutritionTemplate(f.db, 'bob', A, 1, B, NOW), null);
  await assert.rejects(archiveNutritionTemplate(f.db, 'alice', A, 1, A, NOW), NutritionConflictError);
  assert.equal((await readNutritionTemplate(f.db, 'alice', A))?.revision, 1); assert.equal(f.receipts(), 1);
});
test('archive is versioned and retry-safe; active list and preview exclude archived content', async (t) => {
  const f = fixture(t); await createNutritionTemplate(f.db, 'alice', definition(), A, NOW);
  const archived = await archiveNutritionTemplate(f.db, 'alice', A, 1, B, NOW);
  assert.equal(archived?.template.archivedAt, NOW); assert.equal(archived?.template.revision, 2);
  assert.equal((await archiveNutritionTemplate(f.db, 'alice', A, 1, B, NOW))?.replayed, true);
  assert.deepEqual(await listNutritionTemplates(f.db, 'alice'), []); assert.equal((await listNutritionTemplates(f.db, 'alice', true)).length, 1);
  await assert.rejects(previewStoredNutritionTemplate(f.db, 'alice', A, preview()), NutritionConflictError);
  await assert.rejects(replaceNutritionTemplate(f.db, 'alice', A, definition(), 2, C, NOW), NutritionConflictError);
});
test('preview returns batch-compatible scaled rows without writes and rejects stale versions', async (t) => {
  const f = fixture(t); await createNutritionTemplate(f.db, 'alice', definition(), A, NOW);
  const result = await previewStoredNutritionTemplate(f.db, 'alice', A, preview());
  assert.equal(result?.rows[0].protein, '2.4'); assert.equal(result?.rows[0].calories, null); assert.equal(result?.rows[0].provenance.protein?.source, 'label');
  assert.equal(f.count(), 1); assert.equal(f.receipts(), 1);
  assert.equal(await previewStoredNutritionTemplate(f.db, 'bob', A, preview()), null);
  await replaceNutritionTemplate(f.db, 'alice', A, definition('changed'), 1, B, NOW);
  await assert.rejects(previewStoredNutritionTemplate(f.db, 'alice', A, preview()), NutritionConflictError);
});
test('race at transaction boundary prevents edit receipt and partial overwrite', async (t) => {
  const f = fixture(t); await createNutritionTemplate(f.db, 'alice', definition(), A, NOW);
  f.race(() => f.sqlite.prepare('UPDATE nutrition_templates SET revision=2,name=? WHERE id=?').run('racing change', A));
  await assert.rejects(replaceNutritionTemplate(f.db, 'alice', A, definition('stale overwrite'), 1, B, NOW), NutritionConflictError);
  assert.equal(f.sqlite.prepare('SELECT name FROM nutrition_templates WHERE id=?').get(A)?.name, 'racing change'); assert.equal(f.receipts(), 1);
});
test('transaction rollback removes receipt if template insert or edit fails', async (t) => {
  const f = fixture(t); f.sqlite.exec("CREATE TRIGGER reject_create BEFORE INSERT ON nutrition_templates BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  await assert.rejects(createNutritionTemplate(f.db, 'alice', definition(), A, NOW)); assert.equal(f.count(), 0); assert.equal(f.receipts(), 0);
  f.sqlite.exec('DROP TRIGGER reject_create'); await createNutritionTemplate(f.db, 'alice', definition(), A, NOW);
  f.sqlite.exec("CREATE TRIGGER reject_edit BEFORE UPDATE ON nutrition_templates BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  await assert.rejects(replaceNutritionTemplate(f.db, 'alice', A, definition('failed'), 1, B, NOW)); assert.equal(f.receipts(), 1); assert.equal((await readNutritionTemplate(f.db, 'alice', A))?.revision, 1);
});
test('simultaneous retries resolve to one receipt and one mutation', async (t) => {
  const f = fixture(t); const results = await Promise.all([createNutritionTemplate(f.db, 'alice', definition(), A, NOW), createNutritionTemplate(f.db, 'alice', definition(), A, NOW)]);
  assert.equal(f.count(), 1); assert.equal(f.receipts(), 1); assert.equal(results.filter((result) => result.replayed).length, 1);
  const edits = await Promise.all([replaceNutritionTemplate(f.db, 'alice', A, definition('two'), 1, B, NOW), replaceNutritionTemplate(f.db, 'alice', A, definition('two'), 1, B, NOW)]);
  assert.equal(edits.filter((result) => result?.replayed).length, 1); assert.equal((await readNutritionTemplate(f.db, 'alice', A))?.revision, 2);
});
