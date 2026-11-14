import { ManagedFoodError, managedFoodId, managedLibraryFood, parseManagedFoodCommand } from '../lib/managed-food-catalog.ts';
import type { ManagedFoodAdminItem, ManagedFoodCommand, ManagedFoodDefinition, ManagedLibraryFood } from '../lib/managed-food-catalog.ts';
export type ManagedFoodDatabase = Pick<D1Database, 'prepare' | 'batch'>;
interface Row { id: string; replacesId: string | null; draftJson: string; revision: number; publishedRevision: number | null; status: ManagedFoodAdminItem['status']; createdAt: string; updatedAt: string; publishedJson: string | null }
interface Receipt { actorUserId: string; requestHash: string; resultJson: string }
const columns = 'f.id,f.replaces_id AS replacesId,f.draft_json AS draftJson,f.revision,f.published_revision AS publishedRevision,f.status,f.created_at AS createdAt,f.updated_at AS updatedAt,v.definition_json AS publishedJson';
const join = 'FROM managed_foods f LEFT JOIN managed_food_versions v ON v.item_id=f.id AND v.revision=f.published_revision';
function present(row: Row): ManagedFoodAdminItem {
  return { id: row.id, replacesId: row.replacesId, revision: row.revision, publishedRevision: row.publishedRevision, status: row.status,
    draft: JSON.parse(row.draftJson), published: row.publishedJson ? JSON.parse(row.publishedJson) : null,
    hasDraftChanges: row.draftJson !== row.publishedJson, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
export async function listManagedFoodAdmin(db: ManagedFoodDatabase): Promise<ManagedFoodAdminItem[]> {
  const rows = await db.prepare(`SELECT ${columns} ${join} ORDER BY f.updated_at DESC,f.id LIMIT 500`).all<Row>();
  return rows.results.map(present);
}
export async function readManagedFoodAdmin(db: ManagedFoodDatabase, id: string): Promise<ManagedFoodAdminItem | null> {
  const row = await db.prepare(`SELECT ${columns} ${join} WHERE f.id=?`).bind(id).first<Row>();
  return row ? present(row) : null;
}
export async function listManagedFoodLibrary(db: ManagedFoodDatabase): Promise<{ foods: ManagedLibraryFood[]; overrides: string[]; brands: Array<{ id: string; name: string }> }> {
  const rows = await db.prepare(`SELECT ${columns} ${join} WHERE f.published_revision IS NOT NULL OR (f.replaces_id IS NOT NULL AND f.status='archived') ORDER BY f.created_at,f.id LIMIT 500`).all<Row>();
  const foods = rows.results.filter((row) => row.status === 'published' && row.publishedJson)
    .map((row) => managedLibraryFood(row.id, row.publishedRevision!, JSON.parse(row.publishedJson!) as ManagedFoodDefinition));
  return { foods, overrides: rows.results.flatMap((row) => row.replacesId ? [row.replacesId] : []),
    brands: [...new Map(foods.map((food) => [food.brand.id, food.brand])).values()] };
}
async function hash(value: unknown): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map((n) => n.toString(16).padStart(2,'0')).join(''); }
function conflict(message = '食品资料已在其他页面更新，填写内容已保留，请读取最新版本后核对。'): never { throw new ManagedFoodError('MANAGED_FOOD_CONFLICT', message, 409); }
function ownerGuard(db: ManagedFoodDatabase, actorId: string, configuredOwnerId?: string) {
  if (configuredOwnerId) return db.prepare('SELECT CASE WHEN ?=? THEN 1 ELSE abs(-9223372036854775808) END AS managed_food_explicit_owner_guard').bind(actorId,configuredOwnerId);
  return db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM app_owner_identity WHERE id='owner' AND user_id=?) THEN 1 ELSE abs(-9223372036854775808) END AS managed_food_owner_guard").bind(actorId);
}
/** Each receipt and immutable publication are committed with the guarded CAS. */
export async function mutateManagedFood(db: ManagedFoodDatabase, actorId: string, input: unknown, operation: string, now = new Date().toISOString(), configuredOwnerId?: string) {
  const command = parseManagedFoodCommand(input), operationId = managedFoodId(operation), requestHash = await hash(command);
  const owner = configuredOwnerId ? { userId: configuredOwnerId } : await db.prepare("SELECT user_id AS userId FROM app_owner_identity WHERE id='owner'").first<{ userId: string }>();
  if (owner?.userId !== actorId) throw new ManagedFoodError('MANAGED_FOOD_OWNER_REQUIRED','只有网站管理员可以维护公共食物库。',403);
  const prior = await db.prepare('SELECT actor_user_id AS actorUserId,request_hash AS requestHash,result_json AS resultJson FROM managed_food_operations WHERE operation_id=?').bind(operationId).first<Receipt>();
  if (prior) {
    if (prior.actorUserId !== actorId || prior.requestHash !== requestHash) return conflict('同一提交标识已用于其他食品操作，请保留原请求。');
    return { item: JSON.parse(prior.resultJson) as ManagedFoodAdminItem, replayed: true };
  }
  const readReplay = async () => {
    const row = await db.prepare('SELECT actor_user_id AS actorUserId,request_hash AS requestHash,result_json AS resultJson FROM managed_food_operations WHERE operation_id=?').bind(operationId).first<Receipt>();
    if (row && row.actorUserId === actorId && row.requestHash === requestHash) return { item: JSON.parse(row.resultJson) as ManagedFoodAdminItem, replayed: true };
    if (row) return conflict('同一提交标识已用于其他食品操作，请保留原请求。');
    return null;
  };
  const replayOrConflict = async (message?: string) => await readReplay() ?? conflict(message);
  const id = command.action === 'save' ? command.id ?? operationId : command.id;
  const current = await readManagedFoodAdmin(db, id);
  if (command.action === 'save' && !command.id && current || command.action !== 'save' && !current || command.action === 'save' && command.id && !current) return replayOrConflict('食品不存在或创建标识已被占用，请重新读取列表。');
  if (current && current.revision !== command.expectedRevision) return replayOrConflict();
  if (current && command.action === 'save' && current.replacesId !== command.replacesId) return replayOrConflict('维护副本关联的原始食品不能更改。');
  const definition = command.action === 'save' ? command.definition : current!.draft;
  const revision = (current?.revision ?? 0) + 1;
  const status = command.action === 'publish' ? 'published' : command.action === 'archive' ? 'archived'
    : command.action === 'restore' ? current!.publishedRevision === null ? 'draft' : 'published' : current?.status ?? 'draft';
  const publishedRevision = command.action === 'publish' ? revision : current?.publishedRevision ?? null;
  const published = command.action === 'publish' ? definition : current?.published ?? null;
  const item: ManagedFoodAdminItem = { id, revision, status, replacesId: current?.replacesId ?? (command.action === 'save' ? command.replacesId : null),
    draft: definition, published, publishedRevision, hasDraftChanges: JSON.stringify(definition) !== JSON.stringify(published), createdAt: current?.createdAt ?? now, updatedAt: now };
  const statements: D1PreparedStatement[] = [ownerGuard(db, actorId, configuredOwnerId)];
  if (current) statements.push(db.prepare('SELECT CASE WHEN EXISTS(SELECT 1 FROM managed_foods WHERE id=? AND revision=?) THEN 1 ELSE abs(-9223372036854775808) END AS managed_food_revision_guard').bind(id,current.revision));
  else statements.push(db.prepare('SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM managed_foods WHERE id=?) AND (SELECT COUNT(*) FROM managed_foods)<500 THEN 1 ELSE abs(-9223372036854775808) END AS managed_food_capacity_guard').bind(id));
  if (current) statements.push(db.prepare('UPDATE managed_foods SET draft_json=?,revision=?,published_revision=?,status=?,updated_at=? WHERE id=? AND revision=?').bind(JSON.stringify(definition),revision,publishedRevision,status,now,id,current.revision));
  else statements.push(db.prepare('INSERT INTO managed_foods(id,replaces_id,draft_json,revision,published_revision,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id,item.replacesId,JSON.stringify(definition),revision,publishedRevision,status,actorId,now,now));
  if (command.action === 'publish') statements.push(db.prepare('INSERT INTO managed_food_versions(item_id,revision,definition_json,created_by,created_at) VALUES (?,?,?,?,?)').bind(id,revision,JSON.stringify(definition),actorId,now));
  statements.push(db.prepare('INSERT INTO managed_food_operations(operation_id,actor_user_id,item_id,action,request_hash,result_json,created_at) VALUES (?,?,?,?,?,?,?)').bind(operationId,actorId,id,command.action,requestHash,JSON.stringify(item),now));
  try { await db.batch(statements); }
  catch {
    const replayed = await readReplay(); if (replayed) return replayed;
    const latest = await readManagedFoodAdmin(db,id);
    if (current ? latest?.revision !== current.revision : latest !== null) return conflict();
    if (!current && command.action === 'save' && command.replacesId
      && await db.prepare('SELECT id FROM managed_foods WHERE replaces_id=?').bind(command.replacesId).first()) return conflict('此内置食品已有维护副本，请打开已有条目。');
    if (!current && Number((await db.prepare('SELECT COUNT(*) AS n FROM managed_foods').first<{n:number}>())?.n) >= 500) return conflict('公共维护食品已达500项，请先整理现有条目。');
    if (!configuredOwnerId && (await db.prepare("SELECT user_id AS userId FROM app_owner_identity WHERE id='owner'").first<{userId:string}>())?.userId !== actorId) throw new ManagedFoodError('MANAGED_FOOD_OWNER_REQUIRED','管理员身份已变化，请刷新后继续。',403);
    throw new ManagedFoodError('MANAGED_FOOD_UNCERTAIN','保存结果暂未确认，请保留原内容和提交标识，再次确认原操作。',503);
  }
  return { item, replayed: false };
}
