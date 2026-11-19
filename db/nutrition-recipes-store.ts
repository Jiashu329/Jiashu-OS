import { MAX_RECIPE_PHOTO_STORAGE_CHARS, type RecipeCreation, type RecipeDefinition, type RecipeListSelection, type RecipeSource } from '../lib/nutrition-recipes.ts';
import type { NutritionDatabase } from './nutrition-store.ts';

export interface RecipeSummary {
  id: string;
  title: string;
  source: RecipeSource;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceAuthor: string | null;
  note: string;
  cookingCount: number;
  coverCookingId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface CookingRow {
  id: string;
  note: string;
  hasPhoto: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface RecipeDetail extends RecipeSummary, RecipeDefinition {
  cookings: Array<Omit<CookingRow, 'hasPhoto'> & { hasPhoto: boolean }>;
}

type Action = 'create' | 'edit' | 'archive' | 'cook' | 'edit-cooking' | 'delete-cooking';
interface ResultIdentity { recipeId: string; cookingId: string | null }
interface Operation extends ResultIdentity {
  id: string;
  action: Action;
  requestHash: string;
  resultJson: string;
}

export class RecipeConflictError extends Error {
  readonly code: string;

  constructor(message = '菜谱已更新，请重新读取后核对填写。', code = 'RECIPE_CONFLICT') {
    super(message);
    this.name = 'RecipeConflictError';
    this.code = code;
  }
}

const summaryColumns = `r.id,r.title,r.source,r.source_url AS sourceUrl,r.source_title AS sourceTitle,
  r.source_author AS sourceAuthor,r.note,r.revision,r.created_at AS createdAt,r.updated_at AS updatedAt,r.archived_at AS archivedAt,
  (SELECT COUNT(*) FROM nutrition_recipe_cookings c WHERE c.user_id=r.user_id AND c.recipe_id=r.id AND c.archived_at IS NULL) AS cookingCount,
  (SELECT c.id FROM nutrition_recipe_cookings c WHERE c.user_id=r.user_id AND c.recipe_id=r.id AND c.archived_at IS NULL
    AND c.photo_data_url IS NOT NULL ORDER BY c.created_at DESC,c.id DESC LIMIT 1) AS coverCookingId`;
const cookingColumns = `id,note,photo_data_url IS NOT NULL AS hasPhoto,revision,created_at AS createdAt,updated_at AS updatedAt`;
const photoStorage = `SELECT COALESCE(SUM(LENGTH(photo_data_url)),0) FROM nutrition_recipe_cookings WHERE user_id=?`;
const receiptGuard = `changes()=1 AND EXISTS(SELECT 1 FROM nutrition_recipe_operations WHERE id=? AND user_id=? AND request_hash=?)`;

export async function listRecipes(db: NutritionDatabase, userId: string, selection: RecipeListSelection) {
  const { source, cooked, query, offset, limit } = selection;
  const conditions = ['r.user_id=?', 'r.archived_at IS NULL'];
  const params: Array<string | number> = [userId];
  if (source === 'linked') conditions.push("r.source<>'own'");
  else if (source !== 'all') { conditions.push('r.source=?'); params.push(source); }
  if (cooked) conditions.push(`(r.source='own' OR EXISTS(SELECT 1 FROM nutrition_recipe_cookings c
    WHERE c.user_id=r.user_id AND c.recipe_id=r.id AND c.archived_at IS NULL))`);
  if (query) {
    conditions.push(`(INSTR(LOWER(r.title),LOWER(?))>0 OR INSTR(LOWER(r.note),LOWER(?))>0
      OR INSTR(LOWER(r.ingredients),LOWER(?))>0 OR INSTR(LOWER(COALESCE(r.source_title,'')),LOWER(?))>0
      OR INSTR(LOWER(COALESCE(r.source_author,'')),LOWER(?))>0)`);
    params.push(query, query, query, query, query);
  }
  const page = await db.prepare(`SELECT ${summaryColumns} FROM nutrition_recipes r WHERE ${conditions.join(' AND ')}
    ORDER BY r.updated_at DESC,r.id DESC LIMIT ? OFFSET ?`).bind(...params, limit + 1, offset).all<RecipeSummary>();
  return { recipes: page.results.slice(0, limit), nextOffset: page.results.length > limit ? offset + limit : null };
}

export async function readRecipe(db: NutritionDatabase, userId: string, id: string, includeArchived = false): Promise<RecipeDetail | null> {
  const [recipe, cookings] = await db.batch<RecipeDetail | CookingRow>([
    db.prepare(`SELECT ${summaryColumns},r.ingredients,r.steps,r.servings FROM nutrition_recipes r
      WHERE r.user_id=? AND r.id=? ${includeArchived ? '' : 'AND r.archived_at IS NULL'}`).bind(userId, id),
    db.prepare(`SELECT ${cookingColumns} FROM nutrition_recipe_cookings WHERE user_id=? AND recipe_id=? AND archived_at IS NULL
      ORDER BY created_at DESC,id DESC`).bind(userId, id),
  ]);
  const row = recipe.results[0] as RecipeDetail | undefined;
  if (!row) return null;
  return { ...row, cookings: (cookings.results as CookingRow[]).map((item) => ({ ...item, hasPhoto: !!item.hasPhoto })) };
}

export async function readRecipeBySource(db: NutritionDatabase, userId: string, sourceKey: string) {
  const row = await db.prepare('SELECT id FROM nutrition_recipes WHERE user_id=? AND source_key=? AND archived_at IS NULL')
    .bind(userId, sourceKey).first<{ id: string }>();
  return row ? readRecipe(db, userId, row.id) : null;
}

export async function readRecipePhoto(db: NutritionDatabase, userId: string, recipeId: string, cookingId: string) {
  const row = await db.prepare(`SELECT c.photo_data_url AS photoDataUrl FROM nutrition_recipe_cookings c
    JOIN nutrition_recipes r ON r.user_id=c.user_id AND r.id=c.recipe_id
    WHERE c.user_id=? AND c.recipe_id=? AND c.id=? AND c.archived_at IS NULL AND r.archived_at IS NULL`)
    .bind(userId, recipeId, cookingId).first<{ photoDataUrl: string | null }>();
  return row?.photoDataUrl ?? null;
}

async function operationIdentity(id: string, action: Action, recipeId: string, cookingId: string | null, input: unknown): Promise<Operation> {
  const bytes = new TextEncoder().encode(JSON.stringify([action, recipeId, cookingId, input]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const requestHash = [...hash].map((value) => value.toString(16).padStart(2, '0')).join('');
  return { id, action, recipeId, cookingId, requestHash, resultJson: JSON.stringify({ recipeId, cookingId }) };
}

async function readOperation(db: NutritionDatabase, userId: string, id: string) {
  return db.prepare(`SELECT id,action,recipe_id AS recipeId,cooking_id AS cookingId,request_hash AS requestHash,result_json AS resultJson
    FROM nutrition_recipe_operations WHERE user_id=? AND id=?`).bind(userId, id).first<Operation>();
}

async function operationResult(db: NutritionDatabase, userId: string, saved: Operation, operation: Operation, replayed: boolean) {
  if (saved.requestHash !== operation.requestHash || saved.recipeId !== operation.recipeId
    || saved.cookingId !== operation.cookingId || saved.action !== operation.action) {
    throw new RecipeConflictError('此提交标识已用于不同的菜谱操作。');
  }
  const recipe = await readRecipe(db, userId, saved.recipeId, true);
  if (!recipe) throw new Error('Recipe receipt refers to a missing recipe');
  return { recipe, replayed };
}

function writeOperation(db: NutritionDatabase, userId: string, operation: Operation, now: string, condition: string, ...params: Array<string | number | null>) {
  return db.prepare(`INSERT INTO nutrition_recipe_operations(id,user_id,recipe_id,cooking_id,action,request_hash,result_json,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${condition} ON CONFLICT(id) DO NOTHING`)
    .bind(operation.id, userId, operation.recipeId, operation.cookingId, operation.action, operation.requestHash, operation.resultJson, now, ...params);
}

function notEnoughStorage() {
  return new RecipeConflictError('本账号的菜谱照片空间已满，请先移除不需要的照片再保存。', 'RECIPE_PHOTO_STORAGE_FULL');
}

async function usedPhotoStorage(db: NutritionDatabase, userId: string) {
  return (await db.prepare(`SELECT (${photoStorage}) AS used`).bind(userId).first<{ used: number }>())?.used ?? 0;
}

export async function createRecipe(db: NutritionDatabase, userId: string, input: RecipeCreation, requestId: string, now = new Date().toISOString()) {
  const { source, sourceUrl, sourceKey, sourceTitle, sourceAuthor, title, note, ingredients, steps, servings, cookingNote, photoDataUrl } = input;
  const id = requestId, cookingId = cookingNote || photoDataUrl ? id : null;
  const operation = await operationIdentity(requestId, 'create', id, cookingId, input);
  const prior = await readOperation(db, userId, requestId);
  if (prior) return operationResult(db, userId, prior, operation, true);
  const photoSize = photoDataUrl?.length ?? 0;
  const statements = [
    writeOperation(db, userId, operation, now, `NOT EXISTS(SELECT 1 FROM nutrition_recipes WHERE id=?)
      AND NOT EXISTS(SELECT 1 FROM nutrition_recipes WHERE user_id=? AND source_key=? AND archived_at IS NULL)
      AND (?=0 OR (${photoStorage})+?<=?)`, id, userId, sourceKey, photoSize, userId, photoSize, MAX_RECIPE_PHOTO_STORAGE_CHARS),
    db.prepare(`INSERT INTO nutrition_recipes(id,user_id,source,source_url,source_key,source_title,source_author,title,note,
      ingredients,steps,servings,revision,created_at,updated_at,archived_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,NULL WHERE ${receiptGuard}`)
      .bind(id, userId, source, sourceUrl, sourceKey, sourceTitle, sourceAuthor, title, note, ingredients, steps, servings, now, now,
        requestId, userId, operation.requestHash),
  ];
  if (cookingId) statements.push(db.prepare(`INSERT INTO nutrition_recipe_cookings(id,user_id,recipe_id,note,photo_data_url,revision,created_at,updated_at,archived_at)
    SELECT ?,?,?,?,?,1,?,?,NULL WHERE ${receiptGuard}`)
    .bind(cookingId, userId, id, cookingNote, photoDataUrl, now, now, requestId, userId, operation.requestHash));
  const result = await db.batch(statements);
  const saved = await readOperation(db, userId, requestId);
  if (saved) return operationResult(db, userId, saved, operation, result[0].meta.changes === 0);
  if (sourceKey && await db.prepare('SELECT 1 FROM nutrition_recipes WHERE user_id=? AND source_key=? AND archived_at IS NULL').bind(userId, sourceKey).first()) {
    throw new RecipeConflictError('这条菜谱链接已收藏。', 'RECIPE_ALREADY_SAVED');
  }
  if (photoSize && await usedPhotoStorage(db, userId) + photoSize > MAX_RECIPE_PHOTO_STORAGE_CHARS) throw notEnoughStorage();
  throw new RecipeConflictError('未保存这份菜谱，请刷新后核对原操作。');
}

export async function changeRecipe(db: NutritionDatabase, userId: string, id: string, requestId: string, expectedRevision: number,
  definition: RecipeDefinition | null, now = new Date().toISOString()) {
  const operation = await operationIdentity(requestId, definition ? 'edit' : 'archive', id, null, [expectedRevision, definition]);
  const prior = await readOperation(db, userId, requestId);
  if (prior) return operationResult(db, userId, prior, operation, true);
  const statements = [
    writeOperation(db, userId, operation, now, `EXISTS(SELECT 1 FROM nutrition_recipes WHERE user_id=? AND id=? AND archived_at IS NULL AND revision=?)`,
      userId, id, expectedRevision),
    definition
      ? db.prepare(`UPDATE nutrition_recipes SET title=?,note=?,ingredients=?,steps=?,servings=?,updated_at=?,revision=revision+1
        WHERE user_id=? AND id=? AND ${receiptGuard}`)
        .bind(definition.title, definition.note, definition.ingredients, definition.steps, definition.servings, now,
          userId, id, requestId, userId, operation.requestHash)
      : db.prepare(`UPDATE nutrition_recipes SET archived_at=?,updated_at=?,revision=revision+1 WHERE user_id=? AND id=? AND ${receiptGuard}`)
        .bind(now, now, userId, id, requestId, userId, operation.requestHash),
  ];
  if (!definition) statements.push(db.prepare(`UPDATE nutrition_recipe_cookings SET photo_data_url=NULL,archived_at=?,updated_at=?,revision=revision+1
    WHERE user_id=? AND recipe_id=? AND archived_at IS NULL AND ${receiptGuard}`)
    .bind(now, now, userId, id, requestId, userId, operation.requestHash));
  const result = await db.batch(statements);
  const saved = await readOperation(db, userId, requestId);
  if (saved) return operationResult(db, userId, saved, operation, result[0].meta.changes === 0);
  if (!await activeRecipe(db, userId, id)) return null;
  throw new RecipeConflictError();
}

async function activeRecipe(db: NutritionDatabase, userId: string, id: string) {
  return db.prepare('SELECT 1 FROM nutrition_recipes WHERE user_id=? AND id=? AND archived_at IS NULL').bind(userId, id).first();
}

function updateAfterCooking(db: NutritionDatabase, userId: string, recipeId: string, now: string, operation: Operation) {
  return db.prepare(`UPDATE nutrition_recipes SET updated_at=?,revision=revision+1 WHERE user_id=? AND id=? AND ${receiptGuard}`)
    .bind(now, userId, recipeId, operation.id, userId, operation.requestHash);
}

export async function addRecipeCooking(db: NutritionDatabase, userId: string, recipeId: string, requestId: string,
  input: { note: string; photoDataUrl: string | null }, now = new Date().toISOString()) {
  const operation = await operationIdentity(requestId, 'cook', recipeId, requestId, input);
  const prior = await readOperation(db, userId, requestId);
  if (prior) return operationResult(db, userId, prior, operation, true);
  const size = input.photoDataUrl?.length ?? 0;
  const result = await db.batch([
    writeOperation(db, userId, operation, now, `EXISTS(SELECT 1 FROM nutrition_recipes WHERE user_id=? AND id=? AND archived_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM nutrition_recipe_cookings WHERE id=?) AND (?=0 OR (${photoStorage})+?<=?)`,
      userId, recipeId, requestId, size, userId, size, MAX_RECIPE_PHOTO_STORAGE_CHARS),
    db.prepare(`INSERT INTO nutrition_recipe_cookings(id,user_id,recipe_id,note,photo_data_url,revision,created_at,updated_at,archived_at)
      SELECT ?,?,?,?,?,1,?,?,NULL WHERE ${receiptGuard}`)
      .bind(requestId, userId, recipeId, input.note, input.photoDataUrl, now, now, requestId, userId, operation.requestHash),
    updateAfterCooking(db, userId, recipeId, now, operation),
  ]);
  const saved = await readOperation(db, userId, requestId);
  if (saved) return operationResult(db, userId, saved, operation, result[0].meta.changes === 0);
  if (!await activeRecipe(db, userId, recipeId)) return null;
  if (size && await usedPhotoStorage(db, userId) + size > MAX_RECIPE_PHOTO_STORAGE_CHARS) throw notEnoughStorage();
  throw new RecipeConflictError();
}

export async function changeRecipeCooking(db: NutritionDatabase, userId: string, recipeId: string, cookingId: string, requestId: string,
  expectedRevision: number, input: { note: string; photoDataUrl: string | null | undefined } | null, now = new Date().toISOString()) {
  const operation = await operationIdentity(requestId, input ? 'edit-cooking' : 'delete-cooking', recipeId, cookingId, [expectedRevision, input]);
  const prior = await readOperation(db, userId, requestId);
  if (prior) return operationResult(db, userId, prior, operation, true);
  const previous = await db.prepare(`SELECT c.revision,COALESCE(LENGTH(c.photo_data_url),0) AS photoSize FROM nutrition_recipe_cookings c
    JOIN nutrition_recipes r ON r.user_id=c.user_id AND r.id=c.recipe_id
    WHERE c.user_id=? AND c.recipe_id=? AND c.id=? AND c.archived_at IS NULL AND r.archived_at IS NULL`)
    .bind(userId, recipeId, cookingId).first<{ revision: number; photoSize: number }>();
  if (!previous) {
    const concurrent = await readOperation(db, userId, requestId);
    return concurrent ? operationResult(db, userId, concurrent, operation, true) : null;
  }
  const storageDelta = input?.photoDataUrl === undefined ? 0 : (input.photoDataUrl?.length ?? 0) - previous.photoSize;
  const result = await db.batch([
    writeOperation(db, userId, operation, now, `EXISTS(SELECT 1 FROM nutrition_recipe_cookings c
      JOIN nutrition_recipes r ON r.user_id=c.user_id AND r.id=c.recipe_id
      WHERE c.user_id=? AND c.recipe_id=? AND c.id=? AND c.revision=? AND c.archived_at IS NULL AND r.archived_at IS NULL)
      AND (?<=0 OR (${photoStorage})+?<=?)`, userId, recipeId, cookingId, expectedRevision, storageDelta,
      userId, storageDelta, MAX_RECIPE_PHOTO_STORAGE_CHARS),
    input
      ? db.prepare(`UPDATE nutrition_recipe_cookings SET note=?,photo_data_url=CASE WHEN ? THEN ? ELSE photo_data_url END,updated_at=?,revision=revision+1
        WHERE user_id=? AND recipe_id=? AND id=? AND ${receiptGuard}`)
        .bind(input.note, input.photoDataUrl === undefined ? 0 : 1, input.photoDataUrl ?? null, now,
          userId, recipeId, cookingId, requestId, userId, operation.requestHash)
      : db.prepare(`UPDATE nutrition_recipe_cookings SET photo_data_url=NULL,archived_at=?,updated_at=?,revision=revision+1
        WHERE user_id=? AND recipe_id=? AND id=? AND ${receiptGuard}`)
        .bind(now, now, userId, recipeId, cookingId, requestId, userId, operation.requestHash),
    updateAfterCooking(db, userId, recipeId, now, operation),
  ]);
  const saved = await readOperation(db, userId, requestId);
  if (saved) return operationResult(db, userId, saved, operation, result[0].meta.changes === 0);
  if (storageDelta > 0 && previous.revision === expectedRevision && await usedPhotoStorage(db, userId) + storageDelta > MAX_RECIPE_PHOTO_STORAGE_CHARS) {
    throw notEnoughStorage();
  }
  throw new RecipeConflictError('制作记录已更新，请重新读取后核对填写。');
}
