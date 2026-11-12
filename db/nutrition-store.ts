import { NUTRITION_MEALS, NutritionValidationError, presentNutritionEntry, type NutritionEntry, type NutritionInput, type NutritionDayStatus, type NutritionDayStatusInput, type NutritionMeal, type NutritionMealStatus } from '../lib/nutrition.ts';

export type NutritionDatabase = Pick<D1Database, 'prepare' | 'batch'>;
interface NutritionRow extends NutritionEntry { userId: string; creationHash: string; foodJson: string | null }
export interface NutritionDateSelection { from: string; to: string; includeDeleted?: boolean }
const columns = `id, user_id AS userId, date, meal, name, portion, note, calories_tenth AS caloriesTenth, carbs_tenth AS carbsTenth, protein_tenth AS proteinTenth, fat_tenth AS fatTenth, food_json AS foodJson,
  creation_hash AS creationHash, revision, created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt`;
function entry(row: NutritionRow): NutritionEntry {
  return { id: row.id, date: row.date, meal: row.meal, name: row.name, portion: row.portion, note: row.note,
    caloriesTenth: row.caloriesTenth, carbsTenth: row.carbsTenth ?? null, proteinTenth: row.proteinTenth ?? null, fatTenth: row.fatTenth ?? null, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt, deletedAt: row.deletedAt, ...(row.foodJson ? { food: JSON.parse(row.foodJson) } : {}) };
}
export class NutritionConflictError extends Error {
  readonly code = 'NUTRITION_CONFLICT';
  constructor(message = '这条饮食记录已更新，请刷新后检查再保存。') { super(message); this.name = 'NutritionConflictError'; }
}
function legacyFoodSnapshot(food: NonNullable<NutritionInput['food']>) {
  const { carbsTenth: _carbs, proteinTenth: _protein, fatTenth: _fat,
    carbsPer100g: _carbsPer100g, proteinPer100g: _proteinPer100g, fatPer100g: _fatPer100g, ...legacy } = food;
  return legacy;
}
export async function creationFingerprint(input: NutritionInput) {
  // The parser normalizes whitespace and calorie tenths before persistence.
  const values: unknown[] = [input.date, input.meal, input.name, input.portion, input.note, input.caloriesTenth];
  if (input.food) {
    // New snapshot nutrients do not change identities minted by the old API.
    values.push(legacyFoodSnapshot(input.food));
  }
  const macros = [input.carbsTenth ?? null, input.proteinTenth ?? null, input.fatTenth ?? null];
  if (macros.some((value) => value !== null)) values.push(macros);
  const canonical = JSON.stringify(values);
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
      creation_hash, revision, created_at, updated_at, deleted_at, food_json, carbs_tenth, protein_tenth, fat_tenth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id`)
      .bind(key, userId, input.date, input.meal, input.name, input.portion, input.note, input.caloriesTenth, hash, now, now, input.food ? JSON.stringify(input.food) : null, input.carbsTenth ?? null, input.proteinTenth ?? null, input.fatTenth ?? null),
    db.prepare(`SELECT ${columns} FROM nutrition_entries WHERE id = ?`).bind(key),
  ]);
  const row = result[1].results[0];
  if (!row) throw new Error('Nutrition entry was not saved');
  if (row.userId !== userId || row.creationHash !== hash) throw new NutritionConflictError('同一提交标识已用于另一条饮食记录，请重新提交。');
  return { entry: entry(row), replayed: result[0].results.length === 0 };
}
async function missingOrConflict(db: NutritionDatabase, userId: string, id: string): Promise<null> {
  if (await readNutritionEntry(db, userId, id)) throw new NutritionConflictError();
  return null;
}

/** Complete content replacement never changes owner, creation identity or deletion state. */
export async function replaceNutritionEntry(db: NutritionDatabase, userId: string, id: string, input: NutritionInput, expectedRevision: number, now = new Date().toISOString()): Promise<NutritionEntry | null> {
  const row = await db.prepare(`UPDATE nutrition_entries SET date = ?, meal = ?, name = ?, portion = ?, note = ?,
    calories_tenth = ?, food_json = ?,
    carbs_tenth = CASE WHEN ?=1 THEN ? ELSE carbs_tenth END,
    protein_tenth = CASE WHEN ?=1 THEN ? ELSE protein_tenth END,
    fat_tenth = CASE WHEN ?=1 THEN ? ELSE fat_tenth END, revision = revision + 1, updated_at = ?
    WHERE user_id = ? AND id = ? AND revision = ? RETURNING ${columns}`)
    .bind(input.date, input.meal, input.name, input.portion, input.note, input.caloriesTenth, input.food ? JSON.stringify(input.food) : null,
      Object.hasOwn(input, 'carbsTenth') ? 1 : 0, input.carbsTenth ?? null,
      Object.hasOwn(input, 'proteinTenth') ? 1 : 0, input.proteinTenth ?? null,
      Object.hasOwn(input, 'fatTenth') ? 1 : 0, input.fatTenth ?? null, now, userId, id.toLowerCase(), expectedRevision).first<NutritionRow>();
  return row ? entry(row) : missingOrConflict(db, userId, id);
}
export async function setNutritionEntryDeleted(db: NutritionDatabase, userId: string, id: string, deleted: boolean, expectedRevision: number, now = new Date().toISOString()): Promise<NutritionEntry | null> {
  const row = await db.prepare(`UPDATE nutrition_entries SET deleted_at = CASE WHEN ? = 1 THEN COALESCE(deleted_at, ?) ELSE NULL END,
    revision = revision + 1, updated_at = ? WHERE user_id = ? AND id = ? AND revision = ? RETURNING ${columns}`)
    .bind(deleted ? 1 : 0, now, now, userId, id.toLowerCase(), expectedRevision).first<NutritionRow>();
  return row ? entry(row) : missingOrConflict(db, userId, id);
}

/** A batch key owns an immutable ordered request. Entries are inserted in one D1 transaction. */
export async function createNutritionBatch(db: NutritionDatabase, userId: string, inputs: readonly NutritionInput[], id: string, now = new Date().toISOString()) {
  if (!inputs.length || inputs.length > 30) throw new NutritionValidationError([{ path: 'entries', message: '一次请保存 1 至 30 条食物记录。' }]);
  const key = id.toLowerCase();
  const hashes = await Promise.all(inputs.map(creationFingerprint));
  const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((part) => part.toString(16).padStart(2, '0')).join('');
  const requestHash = await digest(JSON.stringify(hashes));
  const ids = await Promise.all(inputs.map(async (_input, index) => {
    const hash = await digest(JSON.stringify([userId, key, index]));
    return hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-4' + hash.slice(13, 16) + '-8' + hash.slice(17, 20) + '-' + hash.slice(20, 32);
  }));
  // A deliberately preoccupied entry id cannot produce a partially saved batch.
  const noCollisions = ids.map(() => 'NOT EXISTS (SELECT 1 FROM nutrition_entries WHERE id=? AND (user_id<>? OR creation_hash<>?))').join(' AND ');
  const collisionValues = ids.flatMap((entryId, index) => [entryId, userId, hashes[index]]);
  const commands = [db.prepare(`INSERT INTO nutrition_batches (user_id,id,request_hash,entry_ids_json,created_at)
    SELECT ?,?,?,?,? WHERE ${noCollisions} ON CONFLICT(user_id,id) DO NOTHING RETURNING id`)
    .bind(userId, key, requestHash, JSON.stringify(ids), now, ...collisionValues)];
  for (const [index, input] of inputs.entries()) commands.push(db.prepare(`INSERT INTO nutrition_entries
    (id,user_id,date,meal,name,portion,note,calories_tenth,creation_hash,revision,created_at,updated_at,deleted_at,food_json,carbs_tenth,protein_tenth,fat_tenth)
    SELECT ?,?,?,?,?,?,?,?,?,1,?,?,NULL,?,?,?,? WHERE EXISTS
      (SELECT 1 FROM nutrition_batches WHERE user_id=? AND id=? AND request_hash=?)
    ON CONFLICT(id) DO NOTHING`)
    .bind(ids[index], userId, input.date, input.meal, input.name, input.portion, input.note, input.caloriesTenth,
      hashes[index], now, now, input.food ? JSON.stringify(input.food) : null, input.carbsTenth ?? null, input.proteinTenth ?? null, input.fatTenth ?? null, userId, key, requestHash));
  commands.push(db.prepare('SELECT request_hash AS requestHash FROM nutrition_batches WHERE user_id=? AND id=?').bind(userId, key));
  for (const entryId of ids) commands.push(db.prepare(`SELECT ${columns} FROM nutrition_entries WHERE user_id=? AND id=?`).bind(userId, entryId));
  const result = await db.batch<NutritionRow & { requestHash: string }>(commands);
  if (result[inputs.length + 1].results[0]?.requestHash !== requestHash) throw new NutritionConflictError('这次批量提交标识已用于其他内容，请重新核对后保存。');
  const rows = result.slice(inputs.length + 2).map((item) => item.results[0]);
  if (rows.some((row, index) => !row || row.creationHash !== hashes[index])) throw new NutritionConflictError('部分食物的提交标识已变化，请重新核对。');
  return { entries: rows.map(entry), replayed: result[0].results.length === 0 };
}

interface StatusRow { date: string; complete: number; mealsJson: string; revision: number }
const mealKeys = Object.keys(NUTRITION_MEALS) as NutritionMeal[];
function dayStatus(selected: string, entries: readonly NutritionEntry[], saved?: StatusRow): NutritionDayStatus {
  const stored = saved ? JSON.parse(saved.mealsJson) as Partial<Record<NutritionMeal, NutritionMealStatus>> : {};
  const meals = Object.fromEntries(mealKeys.map((meal) => [meal,
    entries.some((item) => item.date === selected && item.meal === meal && item.deletedAt === null) ? 'recorded' : stored[meal] === 'skipped' ? 'skipped' : 'unrecorded',
  ])) as Record<NutritionMeal, NutritionMealStatus>;
  return { date: selected, complete: saved?.complete === 1 && ['breakfast', 'lunch', 'dinner'].every((meal) => meals[meal as NutritionMeal] !== 'unrecorded'), meals, revision: saved?.revision ?? 0 };
}
/** Entries and completion flags must share one transaction before any aggregate is derived. */
export async function readNutritionRangeSnapshot(db: NutritionDatabase, userId: string, selection: NutritionDateSelection): Promise<{ entries: NutritionEntry[]; statuses: NutritionDayStatus[] }> {
  const result = await db.batch<StatusRow & NutritionRow>([
    db.prepare(`SELECT ${columns} FROM nutrition_entries WHERE user_id=? AND date>=? AND date<=?
      ${selection.includeDeleted ? '' : 'AND deleted_at IS NULL'}
      ORDER BY date ASC, CASE meal WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'dinner' THEN 2 ELSE 3 END,created_at ASC,id ASC`)
      .bind(userId, selection.from, selection.to),
    db.prepare('SELECT date,complete,meals_json AS mealsJson,revision FROM nutrition_day_status WHERE user_id=? AND date>=? AND date<=? ORDER BY date')
      .bind(userId, selection.from, selection.to),
  ]);
  const entries = result[0].results.map(entry), rows = result[1].results;
  const dates = [...new Set([...rows.map((row) => row.date), ...entries.filter((item) => item.deletedAt === null).map((item) => item.date)])].sort();
  return { entries, statuses: dates.map((selected) => dayStatus(selected, entries, rows.find((row) => row.date === selected))) };
}
export async function listNutritionDayStatuses(db: NutritionDatabase, userId: string, selection: { from: string; to: string }): Promise<NutritionDayStatus[]> {
  return (await readNutritionRangeSnapshot(db, userId, selection)).statuses;
}
export async function readNutritionDayStatus(db: NutritionDatabase, userId: string, selected: string): Promise<NutritionDayStatus> {
  return (await listNutritionDayStatuses(db, userId, { from: selected, to: selected }))[0] ?? dayStatus(selected, []);
}
export async function writeNutritionDayStatus(db: NutritionDatabase, userId: string, input: NutritionDayStatusInput, now = new Date().toISOString()): Promise<NutritionDayStatus> {
  const current = await readNutritionDayStatus(db, userId, input.date);
  if (current.revision !== input.expectedRevision) throw new NutritionConflictError('当天饮食记录已经变化，请重新读取后标记。');
  for (const meal of mealKeys) {
    if ((current.meals[meal] === 'recorded') !== (input.meals[meal] === 'recorded')) throw new NutritionValidationError([{ path: 'meals.' + meal, message: current.meals[meal] === 'recorded' ? '这餐已有食物记录，不能标记为未进食或尚未记录。' : '请先添加这餐的食物，再标记为已记录。' }]);
  }
  const availability = mealKeys.map((meal) => `${input.meals[meal] === 'recorded' ? '' : 'NOT '}EXISTS
    (SELECT 1 FROM nutrition_entries WHERE user_id=? AND date=? AND meal=? AND deleted_at IS NULL)`).join(' AND ');
  const matching = input.expectedRevision === 0 ? 'NOT EXISTS (SELECT 1 FROM nutrition_day_status WHERE user_id=? AND date=?)'
    : 'EXISTS (SELECT 1 FROM nutrition_day_status WHERE user_id=? AND date=? AND revision=?)';
  const versionValues = input.expectedRevision === 0 ? [userId, input.date] : [userId, input.date, input.expectedRevision];
  const row = await db.prepare(`INSERT INTO nutrition_day_status (user_id,date,complete,meals_json,revision,updated_at)
    SELECT ?,?,?,?,1,? WHERE ${matching} AND ${availability}
    ON CONFLICT(user_id,date) DO UPDATE SET complete=excluded.complete,meals_json=excluded.meals_json,revision=nutrition_day_status.revision+1,updated_at=excluded.updated_at
    WHERE nutrition_day_status.revision=? RETURNING date,complete,meals_json AS mealsJson,revision`)
    .bind(userId, input.date, input.complete ? 1 : 0, JSON.stringify(input.meals), now, ...versionValues,
      ...mealKeys.flatMap((meal) => [userId, input.date, meal]), input.expectedRevision).first<StatusRow>();
  if (!row) throw new NutritionConflictError('当天饮食记录已经变化，请重新读取后标记。');
  return { date: row.date, complete: row.complete === 1, meals: input.meals, revision: row.revision };
}

export interface NutritionFavorite { id: string; name: string; portion: string; calories: string | null; carbs: string | null; protein: string | null; fat: string | null; note: string; food?: NutritionInput['food'] }
interface FavoriteRow { id: string; templateJson: string }
function favorite(row: FavoriteRow): NutritionFavorite { const template = JSON.parse(row.templateJson); return { id: row.id, ...template, carbs: template.carbs ?? null, protein: template.protein ?? null, fat: template.fat ?? null }; }
export function nutritionFavoriteTemplate(item: NutritionEntry, forFingerprint = false) {
  const view = presentNutritionEntry(item);
  const macros = [view.carbs, view.protein, view.fat];
  return { name: item.name, portion: item.portion, calories: view.calories, note: item.note, ...(item.food ? { food: forFingerprint ? legacyFoodSnapshot(item.food) : item.food } : {}),
    ...(macros.some((value) => value !== null) ? { carbs: view.carbs, protein: view.protein, fat: view.fat } : {}) };
}
export async function listNutritionFavorites(db: NutritionDatabase, userId: string): Promise<NutritionFavorite[]> {
  const rows = await db.prepare('SELECT id,template_json AS templateJson FROM nutrition_favorites WHERE user_id=? ORDER BY created_at DESC,id DESC').bind(userId).all<FavoriteRow>();
  return rows.results.map(favorite);
}
export async function addNutritionFavorite(db: NutritionDatabase, userId: string, entryId: string, now = new Date().toISOString()): Promise<NutritionFavorite | null> {
  const item = await readNutritionEntry(db, userId, entryId);
  if (!item || item.deletedAt !== null) return null;
  const template = nutritionFavoriteTemplate(item);
  const json = JSON.stringify(template);
  const canonical = JSON.stringify(nutritionFavoriteTemplate(item, true));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))].map((part) => part.toString(16).padStart(2, '0')).join('');
  const id = crypto.randomUUID();
  const result = await db.batch<FavoriteRow>([
    db.prepare(`INSERT INTO nutrition_favorites (id,user_id,template_hash,template_json,created_at)
      SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM nutrition_favorites WHERE user_id=?)<100
      ON CONFLICT(user_id,template_hash) DO NOTHING`).bind(id, userId, hash, json, now, userId),
    db.prepare('SELECT id,template_json AS templateJson FROM nutrition_favorites WHERE user_id=? AND template_hash=?').bind(userId, hash),
  ]);
  const row = result[1].results[0];
  if (!row) throw new NutritionValidationError([{ path: 'favorite', message: '常用食物最多保存 100 项，请先移除不常用的食物。' }]);
  return favorite(row);
}
export async function removeNutritionFavorite(db: NutritionDatabase, userId: string, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM nutrition_favorites WHERE user_id=? AND id=? RETURNING id').bind(userId, id.toLowerCase()).all<{ id: string }>();
  return result.results.length > 0;
}
export async function recentNutritionFoods(db: NutritionDatabase, userId: string, selected: string) {
  const from = new Date(Date.parse(selected + 'T12:00:00Z') - 29 * 86400000).toISOString().slice(0, 10);
  const items = await listNutritionEntries(db, userId, { from: from < '1970-01-01' ? '1970-01-01' : from, to: selected });
  const seen = new Set<string>();
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).filter((item) => {
    const key = JSON.stringify([item.name, item.portion, item.caloriesTenth, item.food?.foodId, item.carbsTenth ?? null, item.proteinTenth ?? null, item.fatTenth ?? null]);
    if (seen.has(key)) return false; seen.add(key); return true;
  }).slice(0, 12).map(presentNutritionEntry);
}
