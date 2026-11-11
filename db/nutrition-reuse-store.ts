import { creationFingerprint, listNutritionEntries, NutritionConflictError, readNutritionEntry, type NutritionDatabase } from './nutrition-store.ts';
import { presentNutritionEntry, type NutritionEntry, type NutritionInput } from '../lib/nutrition.ts';
import type { NutritionCopySelection } from '../lib/nutrition-reuse.ts';

export interface NutritionFavorite { id: string; name: string; portion: string; note: string; caloriesTenth: number | null; revision: number; createdAt: string; updatedAt: string; deletedAt: string | null }
interface RecentRow extends NutritionEntry { duplicate: number }
interface FavoriteRow extends NutritionFavorite { userId: string; creationHash: string }
const favoriteColumns = `id,user_id AS userId,name,portion,note,calories_tenth AS caloriesTenth,creation_hash AS creationHash,revision,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt`;
function favorite(row: FavoriteRow) { const { userId: _user, creationHash: _hash, ...value } = row; return { ...value, calories: value.caloriesTenth === null ? null : (value.caloriesTenth / 10).toFixed(1) }; }
async function hash(value: unknown) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map((v) => v.toString(16).padStart(2,'0')).join(''); }
export async function nutritionReuseOptions(db: NutritionDatabase, userId: string) {
  const [saved,recent] = await Promise.all([
    db.prepare(`SELECT ${favoriteColumns} FROM nutrition_favorites WHERE user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT 100`).bind(userId).all<FavoriteRow>(),
    db.prepare(`SELECT * FROM (SELECT id,date,meal,name,portion,note,calories_tenth AS caloriesTenth,revision,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt,
      ROW_NUMBER() OVER (PARTITION BY name,portion,note,calories_tenth ORDER BY date DESC,updated_at DESC,id DESC) AS duplicate
      FROM nutrition_entries WHERE user_id=? AND deleted_at IS NULL) WHERE duplicate=1 ORDER BY date DESC,updatedAt DESC,id DESC LIMIT 12`).bind(userId).all<RecentRow>(),
  ]);
  return { favorites:saved.results.map(favorite), recent:recent.results.map(({duplicate:_duplicate,...entry})=>presentNutritionEntry(entry)) };
}
export async function saveNutritionFavorite(db: NutritionDatabase, userId: string, input: {entryId:string;expectedRevision:number}, id: string, now = new Date().toISOString()) {
  const fingerprint = await hash(input);
  const prior = await db.prepare(`SELECT ${favoriteColumns} FROM nutrition_favorites WHERE id=?`).bind(id).first<FavoriteRow>();
  if (prior) { if (prior.userId !== userId || prior.creationHash !== fingerprint) throw new NutritionConflictError('同一提交标识已用于另一项常用食物。'); return { favorite:favorite(prior),replayed:true }; }
  const result = await db.batch<FavoriteRow>([
    db.prepare(`INSERT INTO nutrition_favorites (id,user_id,name,portion,note,calories_tenth,creation_hash,revision,created_at,updated_at,deleted_at)
      SELECT ?,user_id,name,portion,note,calories_tenth,?,1,?,?,NULL FROM nutrition_entries WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL
      AND (SELECT COUNT(*) FROM nutrition_favorites WHERE user_id=? AND deleted_at IS NULL)<100 ON CONFLICT(id) DO NOTHING`)
      .bind(id,fingerprint,now,now,userId,input.entryId,input.expectedRevision,userId),
    db.prepare(`SELECT ${favoriteColumns} FROM nutrition_favorites WHERE id=?`).bind(id),
  ]);
  const row=result[1].results[0];
  if (!row || row.userId!==userId || row.creationHash!==fingerprint) throw new NutritionConflictError('来源记录已变化，或常用食物已达100项。请刷新后核对。');
  return {favorite:favorite(row),replayed:result[0].meta.changes!==1};
}
export async function removeNutritionFavorite(db: NutritionDatabase,userId:string,id:string,revision:number,now=new Date().toISOString()) {
  const row=await db.prepare(`UPDATE nutrition_favorites SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=? AND user_id=? AND revision=? AND deleted_at IS NULL RETURNING ${favoriteColumns}`).bind(now,now,id,userId,revision).first<FavoriteRow>();
  if (!row) throw new NutritionConflictError('这项常用食物已变化，请重新读取。');
  return favorite(row);
}
async function copySources(db:NutritionDatabase,userId:string,selection:NutritionCopySelection) {
  const all=await listNutritionEntries(db,userId,{from:selection.fromDate,to:selection.fromDate});
  const entries=all.filter((e)=>e.meal===selection.fromMeal);
  if (!entries.length) throw new NutritionConflictError('来源餐次没有可复制的食物，请选择其他日期或餐次。');
  if (entries.length>30) throw new NutritionConflictError('单次最多复制30项食物，请分餐次整理后再复制。');
  return entries;
}
export async function previewNutritionCopy(db:NutritionDatabase,userId:string,selection:NutritionCopySelection) {
  const entries=await copySources(db,userId,selection);
  return { ...selection,previewToken:await hash([userId,selection,entries]),count:entries.length,unknownCount:entries.filter((e)=>e.caloriesTenth===null).length,entries:entries.map(presentNutritionEntry) };
}
interface CopyReceipt { userId:string;requestHash:string;entryIdsJson:string }
async function receipt(db:NutritionDatabase,id:string) { return db.prepare('SELECT user_id AS userId,request_hash AS requestHash,entry_ids_json AS entryIdsJson FROM nutrition_copy_operations WHERE id=?').bind(id).first<CopyReceipt>(); }
async function receiptResult(db:NutritionDatabase,userId:string,row:CopyReceipt,replayed:boolean) {
  const ids=JSON.parse(row.entryIdsJson) as string[];
  const entries=await Promise.all(ids.map((id)=>readNutritionEntry(db,userId,id)));
  return {entries:entries.filter((e):e is NutritionEntry=>e!==null).map(presentNutritionEntry),entryIds:ids,replayed};
}
export async function copyNutritionMeal(db:NutritionDatabase,userId:string,selection:NutritionCopySelection,previewToken:string,id:string,now=new Date().toISOString()) {
  const requestHash=await hash([selection,previewToken]);
  const replay=async()=>{const row=await receipt(db,id);if(!row)return null;if(row.userId!==userId||row.requestHash!==requestHash)throw new NutritionConflictError('复制标识已用于另一餐次。');return receiptResult(db,userId,row,true);};
  const prior=await replay();if(prior)return prior;
  let sources:NutritionEntry[];
  try {sources=await copySources(db,userId,selection);if(await hash([userId,selection,sources])!==previewToken)throw new NutritionConflictError('来源餐次已变化，请重新预览后复制。');}
  catch(error){const completed=await replay();if(completed)return completed;throw error;}
  const rows=await Promise.all(sources.map(async(source,index)=>{
    const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id+':'+index)));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=[...bytes.slice(0,16)].map((b)=>b.toString(16).padStart(2,'0')).join('');const entryId=hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
    const input:NutritionInput={date:selection.toDate,meal:selection.toMeal,name:source.name,portion:source.portion,note:source.note,caloriesTenth:source.caloriesTenth};
    return {id:entryId,...input,creationHash:await creationFingerprint(input)};
  }));
  const ids=rows.map((row)=>row.id);const snapshot=sources.map((e)=>({id:e.id,revision:e.revision}));
  const result=await db.batch([
    db.prepare(`INSERT INTO nutrition_copy_operations (id,user_id,request_hash,entry_ids_json,created_at) SELECT ?,?,?,?,?
      WHERE (SELECT COUNT(*) FROM nutrition_entries WHERE user_id=? AND date=? AND meal=? AND deleted_at IS NULL)=?
      AND NOT EXISTS (SELECT 1 FROM json_each(?) s WHERE NOT EXISTS (SELECT 1 FROM nutrition_entries n WHERE n.user_id=? AND n.id=json_extract(s.value,'$.id') AND n.revision=json_extract(s.value,'$.revision') AND n.deleted_at IS NULL)) ON CONFLICT(id) DO NOTHING`)
      .bind(id,userId,requestHash,JSON.stringify(ids),now,userId,selection.fromDate,selection.fromMeal,sources.length,JSON.stringify(snapshot),userId),
    db.prepare(`INSERT INTO nutrition_entries (id,user_id,date,meal,name,portion,note,calories_tenth,creation_hash,revision,created_at,updated_at,deleted_at)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.date'),json_extract(value,'$.meal'),json_extract(value,'$.name'),json_extract(value,'$.portion'),json_extract(value,'$.note'),json_extract(value,'$.caloriesTenth'),json_extract(value,'$.creationHash'),1,?,?,NULL FROM json_each(?)
      WHERE changes()=1 AND EXISTS (SELECT 1 FROM nutrition_copy_operations WHERE id=? AND user_id=? AND request_hash=?)`)
      .bind(userId,now,now,JSON.stringify(rows),id,userId,requestHash),
  ]);
  const saved=await receipt(db,id);if(!saved||saved.userId!==userId||saved.requestHash!==requestHash)throw new NutritionConflictError('来源餐次已变化，未复制任何食物，请重新预览。');
  return receiptResult(db,userId,saved,result[0].meta.changes!==1);
}
