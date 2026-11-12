import { NutritionConflictError, type NutritionDatabase } from './nutrition-store.ts';
import { previewNutritionTemplate, type NutritionTemplate, type NutritionTemplateDefinition, type NutritionTemplatePreviewInput } from '../lib/nutrition-templates.ts';

interface TemplateRow { id: string; templateJson: string; revision: number; createdAt: string; updatedAt: string; archivedAt: string | null }
interface OperationRow { userId: string; templateId: string; action: string; requestHash: string; resultJson: string }
const columns = 'id,template_json AS templateJson,revision,created_at AS createdAt,updated_at AS updatedAt,archived_at AS archivedAt';
const operationColumns = 'user_id AS userId,template_id AS templateId,action,request_hash AS requestHash,result_json AS resultJson';
function present(row: TemplateRow): NutritionTemplate { return { ...JSON.parse(row.templateJson), id: row.id, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt, archivedAt: row.archivedAt }; }
async function hash(value: unknown) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map((v) => v.toString(16).padStart(2, '0')).join(''); }
export async function listNutritionTemplates(db: NutritionDatabase, userId: string, includeArchived = false): Promise<NutritionTemplate[]> {
  const rows = await db.prepare(`SELECT ${columns} FROM nutrition_templates WHERE user_id=? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY updated_at DESC,id ASC LIMIT 200`).bind(userId).all<TemplateRow>();
  return rows.results.map(present);
}
export async function readNutritionTemplate(db: NutritionDatabase, userId: string, id: string): Promise<NutritionTemplate | null> {
  const row = await db.prepare(`SELECT ${columns} FROM nutrition_templates WHERE user_id=? AND id=?`).bind(userId, id.toLowerCase()).first<TemplateRow>();
  return row ? present(row) : null;
}
async function receipt(db: NutritionDatabase, id: string) { return db.prepare(`SELECT ${operationColumns} FROM nutrition_template_operations WHERE id=?`).bind(id).first<OperationRow>(); }
function checkReceipt(row: OperationRow, userId: string, templateId: string, action: string, requestHash: string, replayed: boolean) {
  if (row.userId !== userId || row.templateId !== templateId || row.action !== action || row.requestHash !== requestHash) throw new NutritionConflictError('同一模板提交标识已用于其他内容，请保留原操作并核对。');
  return { template: JSON.parse(row.resultJson) as NutritionTemplate, replayed };
}
/** One immutable receipt per mutation makes retry safe after edits or archiving. */
export async function createNutritionTemplate(db: NutritionDatabase, userId: string, definition: NutritionTemplateDefinition, operationId: string, now = new Date().toISOString()) {
  const id = operationId.toLowerCase(), requestHash = await hash(['create', definition]);
  const existing = await receipt(db, id);
  if (existing) return checkReceipt(existing, userId, id, 'create', requestHash, true);
  const template: NutritionTemplate = { ...definition, id, revision: 1, createdAt: now, updatedAt: now, archivedAt: null };
  const result = await db.batch([
    db.prepare(`INSERT INTO nutrition_template_operations(id,user_id,template_id,action,request_hash,result_json,created_at)
      SELECT ?,?,?,'create',?,?,? WHERE NOT EXISTS(SELECT 1 FROM nutrition_templates WHERE id=?)
      AND (SELECT COUNT(*) FROM nutrition_templates WHERE user_id=? AND archived_at IS NULL)<200 ON CONFLICT(id) DO NOTHING`)
      .bind(id, userId, id, requestHash, JSON.stringify(template), now, id, userId),
    db.prepare(`INSERT INTO nutrition_templates(id,user_id,kind,name,template_json,creation_hash,revision,created_at,updated_at,archived_at)
      SELECT ?,?,?,?,?,?,1,?,?,NULL WHERE changes()=1 AND EXISTS(SELECT 1 FROM nutrition_template_operations WHERE id=? AND user_id=? AND request_hash=?)`)
      .bind(id, userId, definition.kind, definition.name, JSON.stringify(definition), requestHash, now, now, id, userId, requestHash),
  ]);
  const saved = await receipt(db, id);
  if (!saved) throw new NutritionConflictError('模板未保存，名称库可能已达200项或提交标识已占用，请核对后重试。');
  return checkReceipt(saved, userId, id, 'create', requestHash, result[0].meta.changes !== 1);
}
export async function replaceNutritionTemplate(db: NutritionDatabase, userId: string, id: string, definition: NutritionTemplateDefinition, expectedRevision: number, operationId: string, now = new Date().toISOString()) {
  return mutate(db, userId, id.toLowerCase(), definition, expectedRevision, operationId.toLowerCase(), 'edit', now);
}
export async function archiveNutritionTemplate(db: NutritionDatabase, userId: string, id: string, expectedRevision: number, operationId: string, now = new Date().toISOString()) {
  return mutate(db, userId, id.toLowerCase(), null, expectedRevision, operationId.toLowerCase(), 'archive', now);
}
async function mutate(db: NutritionDatabase, userId: string, id: string, definition: NutritionTemplateDefinition | null, expectedRevision: number, operationId: string, action: 'edit' | 'archive', now: string) {
  const requestHash = await hash([action, id, expectedRevision, definition]);
  const existing = await receipt(db, operationId);
  if (existing) return checkReceipt(existing, userId, id, action, requestHash, true);
  const previous = await readNutritionTemplate(db, userId, id);
  if (!previous) return null;
  if (previous.archivedAt || previous.revision !== expectedRevision) throw new NutritionConflictError('此模板已更新或归档，填写内容已保留，请读取最新版本后核对。');
  const { id: _, revision: _r, createdAt: _c, updatedAt: _u, archivedAt: _a, ...oldDefinition } = previous;
  const nextDefinition = definition ?? oldDefinition;
  const template: NutritionTemplate = { ...nextDefinition, id, revision: previous.revision + 1, createdAt: previous.createdAt, updatedAt: now, archivedAt: action === 'archive' ? now : null };
  const result = await db.batch([
    db.prepare(`INSERT INTO nutrition_template_operations(id,user_id,template_id,action,request_hash,result_json,created_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM nutrition_templates WHERE user_id=? AND id=? AND revision=? AND archived_at IS NULL) ON CONFLICT(id) DO NOTHING`)
      .bind(operationId, userId, id, action, requestHash, JSON.stringify(template), now, userId, id, expectedRevision),
    db.prepare(`UPDATE nutrition_templates SET kind=?,name=?,template_json=?,revision=revision+1,updated_at=?,archived_at=?
      WHERE changes()=1 AND user_id=? AND id=? AND revision=? AND archived_at IS NULL
      AND EXISTS(SELECT 1 FROM nutrition_template_operations WHERE id=? AND user_id=? AND request_hash=?)`)
      .bind(nextDefinition.kind, nextDefinition.name, JSON.stringify(nextDefinition), now, template.archivedAt, userId, id, expectedRevision, operationId, userId, requestHash),
  ]);
  const saved = await receipt(db, operationId);
  if (!saved) throw new NutritionConflictError('此模板已在另一页面更新，未覆盖任何内容，请读取最新版本后核对。');
  return checkReceipt(saved, userId, id, action, requestHash, result[0].meta.changes !== 1);
}
export async function previewStoredNutritionTemplate(db: NutritionDatabase, userId: string, id: string, input: NutritionTemplatePreviewInput) {
  const template = await readNutritionTemplate(db, userId, id);
  if (!template) return null;
  if (template.revision !== input.expectedRevision || template.archivedAt) throw new NutritionConflictError('此模板已更新或归档，请读取最新内容后重新预览。');
  return previewNutritionTemplate(template, input);
}
