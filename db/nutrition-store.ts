import type { NutritionEntry, NutritionInput } from '../lib/nutrition.ts';
import { MAX_NUTRITION_MEAL_ENTRIES } from '../lib/nutrition.ts';

export type NutritionDatabase = Pick<D1Database, 'prepare' | 'batch'>;
interface NutritionRow extends NutritionEntry { userId: string; creationHash: string }
export interface NutritionDateSelection { from: string; to: string; includeDeleted?: boolean }
const columns = `id, user_id AS userId, date, meal, name, portion, note, calories_tenth AS caloriesTenth,
  creation_hash AS creationHash, revision, created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt`;
function entry(row: NutritionRow): NutritionEntry {
  return { id: row.id, date: row.date, meal: row.meal, name: row.name, portion: row.portion, note: row.note,
    caloriesTenth: row.caloriesTenth, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt, deletedAt: row.deletedAt };
}
export class NutritionConflictError extends Error {
  readonly code = 'NUTRITION_CONFLICT';
  constructor(message = '这条饮食记录已更新，请刷新后检查再保存。') { super(message); this.name = 'NutritionConflictError'; }
}
async function creationFingerprint(input: NutritionInput) {
  // The parser normalizes whitespace and calorie tenths before persistence.
  const canonical = JSON.stringify([input.date, input.meal, input.name, input.portion, input.note, input.caloriesTenth]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  return [...digest].map((part) => part.toString(16).padStart(2, '0')).join('');
}
async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((part) => part.toString(16).padStart(2, '0')).join('');
}
/** Owner-scoped deterministic v4-shaped IDs let one atomic meal safely retry after a lost reply. */
async function mealEntryId(userId: string, requestId: string, index: number) {
  const hash = await digest(JSON.stringify(['nutrition-meal-v1', userId, requestId.toLowerCase(), index]));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export async function createNutritionMeal(db: NutritionDatabase, userId: string, inputs: readonly NutritionInput[], requestId: string, now = new Date().toISOString()) {
  if (!inputs.length || inputs.length > MAX_NUTRITION_MEAL_ENTRIES) throw new RangeError('A meal requires 1–40 entries');
  const canonical = inputs.map((input) => [input.date, input.meal, input.name, input.portion, input.note, input.caloriesTenth]);
  const batchHash = await digest(JSON.stringify(canonical));
  const rows = await Promise.all(inputs.map(async (input, index) => ({ ...input, id: await mealEntryId(userId, requestId, index), hash: 'meal:' + batchHash })));
  const serialized = JSON.stringify(rows);
  // Any identifier conflict suppresses the entire INSERT. The read belongs to the same
  // transaction, and validates both ownership and the immutable whole-meal fingerprint.
  const result = await db.batch<NutritionRow>([
    db.prepare(`INSERT INTO nutrition_entries (id, user_id, date, meal, name, portion, note, calories_tenth,
      creation_hash, revision, created_at, updated_at, deleted_at)
      SELECT json_extract(incoming.value, '$.id'), ?, json_extract(incoming.value, '$.date'),
        json_extract(incoming.value, '$.meal'), json_extract(incoming.value, '$.name'),
        json_extract(incoming.value, '$.portion'), json_extract(incoming.value, '$.note'),
        json_extract(incoming.value, '$.caloriesTenth'), json_extract(incoming.value, '$.hash'), 1, ?, ?, NULL
      FROM json_each(?) AS incoming WHERE NOT EXISTS (
        SELECT 1 FROM nutrition_entries AS existing JOIN json_each(?) AS proposed
          ON existing.id = json_extract(proposed.value, '$.id')
        WHERE existing.user_id <> ? OR existing.creation_hash <> json_extract(proposed.value, '$.hash')
      ) ON CONFLICT(id) DO NOTHING`).bind(userId, now, now, serialized, serialized, userId),
    db.prepare(`SELECT ${columns} FROM nutrition_entries
      WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`).bind(serialized),
  ]);
  const byId = new Map(result[1].results.map((row) => [row.id, row]));
  const saved = rows.map((row) => byId.get(row.id));
  if (saved.some((row) => !row || row.userId !== userId || row.creationHash !== 'meal:' + batchHash)) throw new NutritionConflictError('这次整餐提交标识已用于不同内容，请核对记录后重新复制。');
  return { entries: saved.map((row) => entry(row!)), replayed: result[0].meta.changes === 0 };
}
export async function readNutritionEntry(db: NutritionDatabase, userId: string, id: string): Promise<NutritionEntry | null> {
  const row = await db.prepare(`SELECT ${columns} FROM nutrition_entries WHERE user_id = ? AND id = ?`)
    .bind(userId, id.toLowerCase()).first<NutritionRow>();
  return row ? entry(row) : null;
}
/** Full selected dates, including zero-calorie and unknown-calorie entries. */
export async function listNutritionEntries(db: NutritionDatabase, userId: string, selection: NutritionDateSelection): Promise<NutritionEntry[]> {
  const rows = await db.prepare(`SELECT ${columns} FROM nutrition_entries
    WHERE user_id = ? AND date >= ? AND date <= ? ${selection.includeDeleted ? '' : 'AND deleted_at IS NULL'}
    ORDER BY date ASC, CASE meal WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'dinner' THEN 2 ELSE 3 END,
      created_at ASC, id ASC`).bind(userId, selection.from, selection.to).all<NutritionRow>();
  return rows.results.map(entry);
}

/** An immutable initial fingerprint makes a replay safe after edits or deletion. */
export async function createNutritionEntry(db: NutritionDatabase, userId: string, input: NutritionInput, id: string, now = new Date().toISOString()) {
  const key = id.toLowerCase();
  const hash = await creationFingerprint(input);
  const result = await db.batch<NutritionRow>([
    db.prepare(`INSERT INTO nutrition_entries (id, user_id, date, meal, name, portion, note, calories_tenth,
      creation_hash, revision, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL) ON CONFLICT(id) DO NOTHING`)
      .bind(key, userId, input.date, input.meal, input.name, input.portion, input.note, input.caloriesTenth, hash, now, now),
    db.prepare(`SELECT ${columns} FROM nutrition_entries WHERE id = ?`).bind(key),
  ]);
  const row = result[1].results[0];
  if (!row) throw new Error('Nutrition entry was not saved');
  if (row.userId !== userId || row.creationHash !== hash) throw new NutritionConflictError('同一提交标识已用于另一条饮食记录，请重新提交。');
  return { entry: entry(row), replayed: result[0].meta.changes !== 1 };
}
async function missingOrConflict(db: NutritionDatabase, userId: string, id: string): Promise<null> {
  if (await readNutritionEntry(db, userId, id)) throw new NutritionConflictError();
  return null;
}

/** Complete content replacement never changes owner, creation identity or deletion state. */
export async function replaceNutritionEntry(db: NutritionDatabase, userId: string, id: string, input: NutritionInput, expectedRevision: number, now = new Date().toISOString()): Promise<NutritionEntry | null> {
  const row = await db.prepare(`UPDATE nutrition_entries SET date = ?, meal = ?, name = ?, portion = ?, note = ?,
    calories_tenth = ?, revision = revision + 1, updated_at = ?
    WHERE user_id = ? AND id = ? AND revision = ? RETURNING ${columns}`)
    .bind(input.date, input.meal, input.name, input.portion, input.note, input.caloriesTenth, now, userId, id.toLowerCase(), expectedRevision).first<NutritionRow>();
  return row ? entry(row) : missingOrConflict(db, userId, id);
}
export async function setNutritionEntryDeleted(db: NutritionDatabase, userId: string, id: string, deleted: boolean, expectedRevision: number, now = new Date().toISOString()): Promise<NutritionEntry | null> {
  const row = await db.prepare(`UPDATE nutrition_entries SET deleted_at = CASE WHEN ? = 1 THEN COALESCE(deleted_at, ?) ELSE NULL END,
    revision = revision + 1, updated_at = ? WHERE user_id = ? AND id = ? AND revision = ? RETURNING ${columns}`)
    .bind(deleted ? 1 : 0, now, now, userId, id.toLowerCase(), expectedRevision).first<NutritionRow>();
  return row ? entry(row) : missingOrConflict(db, userId, id);
}
