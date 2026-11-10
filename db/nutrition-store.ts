import type { NutritionEntry, NutritionInput } from '../lib/nutrition.ts';

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
