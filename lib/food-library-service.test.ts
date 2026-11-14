import assert from 'node:assert/strict';
import test from 'node:test';
import { managedDefinition, managedFoodFixture } from '../tests/fixtures/managed-food.ts';
import { mutateManagedFood } from '../db/managed-food-store.ts';
import { parseNutritionTemplate, type NutritionTemplate } from './nutrition-templates.ts';
import { personalLibraryFood } from './personal-food-library.ts';
import { browseUnifiedFoodLibrary, readFoodLibrarySnapshot, unifiedLibraryFood, currentNutritionFoods } from './food-library-service.ts';
import { calculateFoodSelection, getFood, ACTIVE_FOOD_CATALOG_RELEASE } from './food-catalog.ts';
import { buildNutritionDrafts } from './nutrition-parser.ts';
import { buildNutritionPhotoDrafts, parseNutritionPhotoRequest } from './nutrition-photo.ts';
import { TINY_JPEG_DATA_URL } from '../tests/fixtures/nutrition-photo.ts';

const now = '2026-11-14T01:00:00.000Z';
function template(kind: 'food'|'recipe'|'meal', name: string, values: Array<{calories:string|null;protein?:string|null}>): NutritionTemplate {
  return { ...parseNutritionTemplate({kind,name,note:'个人标签',baseServings:'2',totalWeight:null,components:values.map((value,i)=>({name:'成分'+i,portion:'基础份量',grams:null,calories:value.calories,protein:value.protein??null,carbs:null,fat:null}))}),
    id:crypto.randomUUID(),revision:1,createdAt:now,updatedAt:now,archivedAt:null };
}
function setup() {
  const fixture = managedFoodFixture();
  fixture.sqlite.exec('CREATE TABLE nutrition_templates(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,template_json TEXT NOT NULL,creation_hash TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT)');
  const insert=(userId:string,value:NutritionTemplate)=>fixture.sqlite.prepare('INSERT INTO nutrition_templates VALUES (?,?,?,?,?,?,?,?,?,?)').run(value.id,userId,value.kind,value.name,JSON.stringify(value),'synthetic',value.revision,value.createdAt,value.updatedAt,value.archivedAt);
  return {...fixture,insert};
}

test('personal summaries preserve recipe and meal unknown values, genuine zero and base serving scales',()=>{
  const known=personalLibraryFood(template('food','我的牛奶',[{calories:'120',protein:'0'}]),now);
  assert.equal(known.reference.calories,60);assert.equal(known.reference.protein,0);assert.equal(Object.hasOwn(known.reference,'carbs'),false);
  const mixed=personalLibraryFood(template('meal','我的午饭',[{calories:'120'},{calories:null}]),now);
  assert.equal(mixed.reference.calories,null);assert.equal(mixed.category,'整餐');assert.equal(mixed.brand.id,'mine');
  assert.equal(personalLibraryFood(template('recipe','我的食谱',[{calories:'120'},{calories:null}]),now).reference.calories,null);
});

test('unified reads isolate personal templates and preserve public visibility, brand/category scope and revision identity',async(t)=>{
  const f=setup();t.after(()=>f.close());
  const alice=template('food','Alice专属',[{calories:'120'}]),bob=template('meal','Bob私有',[{calories:'80'}]);
  f.insert('alice',alice);f.insert('bob',bob);
  const a=await readFoodLibrarySnapshot(f.db,'alice',false),b=await readFoodLibrarySnapshot(f.db,'bob',false);
  assert.equal(browseUnifiedFoodLibrary(a).total,166);assert.equal(browseUnifiedFoodLibrary(a,{scope:'public'}).total,165);
  const mine=browseUnifiedFoodLibrary(a,{scope:'mine'});assert.equal(mine.total,1);assert.equal(mine.foods[0].name,'Alice专属');
  assert.deepEqual(mine.brands,[{id:'mine',name:'我的食物',count:1}]);assert.deepEqual(mine.categories,[{name:'自建食物',count:1}]);
  assert.equal(unifiedLibraryFood(b,mine.foods[0].id),null);
  assert.equal(unifiedLibraryFood(a,`template:${alice.id}:2`),null);
  const publicOnly=await readFoodLibrarySnapshot(f.db,'alice',false,false);assert.equal(publicOnly.personalFoods.length,0);
  const normalized=browseUnifiedFoodLibrary(a,{scope:'public',brand:'mine',category:'自建食物',offset:24});assert.equal(normalized.brand,'');assert.equal(normalized.category,'');assert.equal(normalized.offset,0);
});

test('public edits appear only after publication, archive hides static suggestions and old captured nutrition stays verifiable',async(t)=>{
  const f=setup();t.after(()=>f.close());
  const id=crypto.randomUUID();const saved=await mutateManagedFood(f.db,'admin',{action:'save',expectedRevision:0,replacesId:'mcd-cn:49:28',definition:{...managedDefinition,name:'管理员核对巨无霸',brandId:'mcd-cn',brandName:'麦当劳',calories:'500.0',sourceUrl:'https://source.example/burger'}},id,now);
  let snapshot=await readFoodLibrarySnapshot(f.db,'alice',false);assert.ok(unifiedLibraryFood(snapshot,'mcd-cn:49:28'));assert.equal(snapshot.publicFoods.length,165);
  const published=await mutateManagedFood(f.db,'admin',{action:'publish',id:saved.item.id,expectedRevision:1},crypto.randomUUID(),now);
  snapshot=await readFoodLibrarySnapshot(f.db,'alice',false);
  assert.equal(unifiedLibraryFood(snapshot,'mcd-cn:49:28'),null);const replacement=snapshot.publicFoods.find((food)=>food.basis==='managed');assert.ok(replacement&&replacement.basis==='managed');assert.equal(replacement.reference.calories,500);
  assert.equal(currentNutritionFoods(snapshot.overrides,'巨无霸',50).length,0);
  await mutateManagedFood(f.db,'admin',{action:'archive',id:saved.item.id,expectedRevision:published.item.revision},crypto.randomUUID(),now);
  snapshot=await readFoodLibrarySnapshot(f.db,'alice',false);assert.equal(snapshot.publicFoods.length,164);assert.equal(unifiedLibraryFood(snapshot,replacement.id),null);
  const historical=calculateFoodSelection({id:'mcd-cn:49:28',amount:1,unit:'份',catalogRelease:ACTIVE_FOOD_CATALOG_RELEASE});assert.equal(historical.caloriesTenth,5130);assert.ok(getFood('mcd-cn:49:28'));
});

test('withdrawn public entries cannot be selected automatically by text recognition or returned as photo candidates',()=>{
  const request={date:'2026-11-14',today:'2026-11-14',meal:'lunch' as const,text:'午餐吃了1份麦当劳巨无霸'};
  const answer=JSON.stringify({items:[{name:'麦当劳巨无霸',amount:1,unit:'份',meal:'lunch',dateText:null,sourceText:'1份麦当劳巨无霸'}]});
  const parsed=buildNutritionDrafts(answer,request,{excludedFoodIds:['mcd-cn:49:28']});assert.equal(parsed.drafts[0].food,null);assert.deepEqual(parsed.drafts[0].candidates,[]);
  const photoRequest=parseNutritionPhotoRequest({image:{dataUrl:TINY_JPEG_DATA_URL},date:'2026-11-14',meal:'lunch'},Date.parse(now));
  const photo=buildNutritionPhotoDrafts(JSON.stringify({items:[{name:'麦当劳巨无霸',evidence:'汉堡包装和面包可见',confidence:'high',estimate:{calories:500,carbs:null,protein:null,fat:null,portion:'一份',basis:'图片可见一份汉堡'}}]}),photoRequest,{excludedFoodIds:['mcd-cn:49:28']});
  assert.deepEqual(photo.drafts[0].candidates,[]);assert.equal(photo.drafts[0].calorieSource,'ai');
});
