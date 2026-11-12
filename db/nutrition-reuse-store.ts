import { shanghaiDay } from '../lib/health.ts';
import { listNutritionFavorites, recentNutritionFoods, creationFingerprint, listNutritionEntries, NutritionConflictError, readNutritionEntry, nutritionFavoriteTemplate, type NutritionDatabase } from './nutrition-store.ts';
import { presentNutritionEntry, type NutritionEntry, type NutritionInput } from '../lib/nutrition.ts';
import type { NutritionCopySelection } from '../lib/nutrition-reuse.ts';

interface FavoriteRow { id:string;userId:string;templateHash:string;templateJson:string;createdAt:string }
const favoriteColumns='id,user_id AS userId,template_hash AS templateHash,template_json AS templateJson,created_at AS createdAt';
function favorite(row:FavoriteRow){const template=JSON.parse(row.templateJson);return{id:row.id,...template,carbs:template.carbs??null,protein:template.protein??null,fat:template.fat??null};}
async function hash(value:unknown){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map((v)=>v.toString(16).padStart(2,'0')).join('');}
export async function nutritionReuseOptions(db:NutritionDatabase,userId:string){return{favorites:await listNutritionFavorites(db,userId),recent:await recentNutritionFoods(db,userId,shanghaiDay(new Date().toISOString()))};}
export async function saveNutritionFavorite(db:NutritionDatabase,userId:string,input:{entryId:string;expectedRevision:number},id:string,now=new Date().toISOString()){
 const existing=await db.prepare('SELECT '+favoriteColumns+' FROM nutrition_favorites WHERE id=?').bind(id).first<FavoriteRow>();
 if(existing){if(existing.userId!==userId)throw new NutritionConflictError('常用保存标识已被占用，请重新核对。');return{operationId:id,favorite:favorite(existing),replayed:true};}
 const source=await readNutritionEntry(db,userId,input.entryId);
 if(!source||source.deletedAt!==null||source.revision!==input.expectedRevision)throw new NutritionConflictError('来源记录已变化，请重新读取后保存为常用。');
 const template=nutritionFavoriteTemplate(source);
 const templateJson=JSON.stringify(template),templateHash=await hash(nutritionFavoriteTemplate(source,true));
 const result=await db.batch<FavoriteRow>([
  db.prepare(`INSERT INTO nutrition_favorites(id,user_id,template_hash,template_json,created_at)
   SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM nutrition_entries WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL)
   AND (SELECT COUNT(*) FROM nutrition_favorites WHERE user_id=?)<100 ON CONFLICT(user_id,template_hash) DO NOTHING RETURNING id`).bind(id,userId,templateHash,templateJson,now,userId,input.entryId,input.expectedRevision,userId),
  db.prepare('SELECT '+favoriteColumns+' FROM nutrition_favorites WHERE user_id=? AND template_hash=?').bind(userId,templateHash),
 ]);
 const saved=result[1].results[0];if(!saved)throw new NutritionConflictError('来源已变化或常用已达100项，请重新核对。');
 return{operationId:id,favorite:favorite(saved),replayed:result[0].results.length===0};
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
    const input:NutritionInput={date:selection.toDate,meal:selection.toMeal,name:source.name,portion:source.portion,note:source.note,caloriesTenth:source.caloriesTenth,carbsTenth:source.carbsTenth??null,proteinTenth:source.proteinTenth??null,fatTenth:source.fatTenth??null,...(source.food?{food:source.food}:{})};
    return {id:entryId,...input,foodJson:source.food?JSON.stringify(source.food):null,creationHash:await creationFingerprint(input)};
  }));
  const ids=rows.map((row)=>row.id);const snapshot=sources.map((e)=>({id:e.id,revision:e.revision}));
  const result=await db.batch([
    db.prepare(`INSERT INTO nutrition_copy_operations (id,user_id,request_hash,entry_ids_json,created_at) SELECT ?,?,?,?,?
      WHERE (SELECT COUNT(*) FROM nutrition_entries WHERE user_id=? AND date=? AND meal=? AND deleted_at IS NULL)=?
      AND NOT EXISTS (SELECT 1 FROM json_each(?) s WHERE NOT EXISTS (SELECT 1 FROM nutrition_entries n WHERE n.user_id=? AND n.id=json_extract(s.value,'$.id') AND n.revision=json_extract(s.value,'$.revision') AND n.deleted_at IS NULL)) ON CONFLICT(id) DO NOTHING`)
      .bind(id,userId,requestHash,JSON.stringify(ids),now,userId,selection.fromDate,selection.fromMeal,sources.length,JSON.stringify(snapshot),userId),
    db.prepare(`INSERT INTO nutrition_entries (id,user_id,date,meal,name,portion,note,calories_tenth,creation_hash,revision,created_at,updated_at,deleted_at,food_json,carbs_tenth,protein_tenth,fat_tenth)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.date'),json_extract(value,'$.meal'),json_extract(value,'$.name'),json_extract(value,'$.portion'),json_extract(value,'$.note'),json_extract(value,'$.caloriesTenth'),json_extract(value,'$.creationHash'),1,?,?,NULL,json_extract(value,'$.foodJson'),json_extract(value,'$.carbsTenth'),json_extract(value,'$.proteinTenth'),json_extract(value,'$.fatTenth') FROM json_each(?)
      WHERE changes()=1 AND EXISTS (SELECT 1 FROM nutrition_copy_operations WHERE id=? AND user_id=? AND request_hash=?)`)
      .bind(userId,now,now,JSON.stringify(rows),id,userId,requestHash),
  ]);
  const saved=await receipt(db,id);if(!saved||saved.userId!==userId||saved.requestHash!==requestHash)throw new NutritionConflictError('来源餐次已变化，未复制任何食物，请重新预览。');
  return receiptResult(db,userId,saved,result[0].meta.changes!==1);
}
