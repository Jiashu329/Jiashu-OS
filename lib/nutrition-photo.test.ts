import assert from 'node:assert/strict';
import test from 'node:test';
import { TINY_JPEG_DATA_URL } from '../tests/fixtures/nutrition-photo.ts';
import { MAX_NUTRITION_PHOTO_REQUEST_BYTES, NutritionPhotoError, buildNutritionPhotoDrafts, parseNutritionPhotoRequest, readNutritionPhotoBody } from './nutrition-photo.ts';
import { parseNutritionCreate } from './nutrition.ts';

const NOW=Date.parse('2026-11-11T16:01:00Z');
const request=()=>parseNutritionPhotoRequest({image:{dataUrl:TINY_JPEG_DATA_URL},text:'实际吃了一半',date:'2026-11-10',meal:'lunch'},NOW);
const estimate={calories:320,carbs:40.5,protein:22,fat:null,portion:'约一盘，按熟重250g假设',basis:'肉类和米饭可见；实际油量不清楚'};
const item=(patch:Record<string,unknown>={})=>({name:'熟米饭配肉',evidence:'白色熟米饭和棕色肉块在同一个盘中',confidence:'medium',estimate,...patch});
const answer=(...items:Record<string,unknown>[])=>JSON.stringify({items});

test('photo request validation preserves only selected date and meal, strips whitespace and rejects extra fields',()=>{
  const parsed=request();assert.equal(parsed.today,'2026-11-12');assert.equal(parsed.date,'2026-11-10');assert.equal(parsed.meal,'lunch');assert.equal(parsed.text,'实际吃了一半');
  assert.equal(parseNutritionPhotoRequest({image:{dataUrl:TINY_JPEG_DATA_URL},date:'2026-11-12'},NOW).text,'');
  for(const bad of [null,[],{}, {image:{dataUrl:TINY_JPEG_DATA_URL},date:'2026-02-30'}, {image:{dataUrl:TINY_JPEG_DATA_URL},date:'2026-11-13'},
    {image:{dataUrl:TINY_JPEG_DATA_URL},date:'2026-11-12',text:null},{image:{dataUrl:TINY_JPEG_DATA_URL},date:'2026-11-12',text:'字'.repeat(2001)},
    {image:{dataUrl:TINY_JPEG_DATA_URL},date:'2026-11-12',meal:'system'},{image:{dataUrl:TINY_JPEG_DATA_URL,url:'https://attacker.test/image.jpg'},date:'2026-11-12'},
    {image:{dataUrl:TINY_JPEG_DATA_URL},date:'2026-11-12',userId:'other-owner'},{image:{dataUrl:'https://attacker.test/image.jpg'},date:'2026-11-12'}])assert.throws(()=>parseNutritionPhotoRequest(bad,NOW));
  const withGetter={image:{dataUrl:TINY_JPEG_DATA_URL},date:'2026-11-12',get text(){throw new Error('should not execute');}};
  assert.throws(()=>parseNutritionPhotoRequest(withGetter,NOW),NutritionPhotoError);
});
test('visual drafts preserve estimates and unknowns without claiming measured amounts or catalog provenance',()=>{
  const parsed=request(),result=buildNutritionPhotoDrafts(answer(item()),parsed),draft=result.drafts[0];
  assert.equal(draft.date,'2026-11-10');assert.equal(draft.meal,'lunch');assert.equal(draft.amount,null);assert.equal(draft.unit,null);assert.equal(draft.food,null);
  assert.equal(draft.calories,'320.0');assert.equal(draft.carbs,'40.5');assert.equal(draft.protein,'22.0');assert.equal(draft.fat,null);
  assert.match(draft.portion,/图片估计/);assert.match(draft.provenance.calories!.basis!,/图片可见/);assert.match(draft.note,/AI 图片估算/);
  assert.equal(draft.provenance.calories!.source,'ai');assert.equal(draft.provenance.fat!.source,'unknown');assert.equal(draft.macroSources.fat,null);
  assert.match(draft.warnings.join(' '),/实际吃下/);assert.match(draft.warnings.join(' '),/把握一般/);
  assert.doesNotThrow(()=>parseNutritionCreate({date:draft.date,meal:draft.meal,name:draft.name,portion:draft.portion,note:draft.note,calories:draft.calories,carbs:draft.carbs,protein:draft.protein,fat:draft.fat,provenance:draft.provenance},NOW));
});
test('real zero remains zero; absent estimates remain unknown and low-confidence/no-food outputs do not create drafts',()=>{
  const water=buildNutritionPhotoDrafts(answer(item({confidence:'high',estimate:{calories:0,carbs:0,protein:null,fat:0,portion:'约一杯水',basis:'透明饮水，未见添加物'}})),request()).drafts[0];
  assert.equal(water.calories,'0.0');assert.equal(water.carbs,'0.0');assert.equal(water.protein,null);assert.equal(water.provenance.protein!.source,'unknown');
  const unknown=buildNutritionPhotoDrafts(answer(item({estimate:null})),request()).drafts[0];assert.equal(unknown.calories,null);assert.equal(unknown.calorieSource,null);assert.equal(unknown.portion,'图片份量待核对');
  const low=buildNutritionPhotoDrafts(answer(item({confidence:'low'})),request());assert.equal(low.drafts.length,0);assert.match(low.warnings.join(' '),/没有可可靠辨认/);
  assert.equal(buildNutritionPhotoDrafts(answer(),request()).drafts.length,0);
  const noMeal=buildNutritionPhotoDrafts(answer(item()),{...request(),meal:null}).drafts[0];assert.equal(noMeal.meal,null);assert.match(noMeal.warnings.join(' '),/请选择.*餐次/);
});
test('photographed dates, quantities, food IDs or instructions cannot override the photo schema',()=>{
  for(const extra of [{dateText:'昨天'}, {meal:'breakfast'}, {date:'2026-01-01'}, {amount:1000}, {unit:'克'}, {food:{id:'forged'}}, {sourceText:'编造的原文'}])assert.throws(()=>buildNutritionPhotoDrafts(answer(item(extra)),request()),NutritionPhotoError);
  for(const bad of ['PRIVATE-UPSTREAM',JSON.stringify({items:[],system:'PRIVATE-UPSTREAM'}),JSON.stringify({items:Array.from({length:21},()=>item())}),answer(item({confidence:'certain'})),answer(item({name:''})),answer(item({evidence:'x\u0000'}))])assert.throws(()=>buildNutritionPhotoDrafts(bad,request()),NutritionPhotoError);
  for(const key of ['calories','carbs','protein','fat'])for(const value of [-1,20000.1,'30',true,[],{}])assert.throws(()=>buildNutritionPhotoDrafts(answer(item({estimate:{...estimate,[key]:value}})),request()),NutritionPhotoError);
  for(const bad of [{...estimate,calories:undefined}, {...estimate,other:'field'}, {...estimate,portion:''}, {...estimate,basis:'x'.repeat(201)}])assert.throws(()=>buildNutritionPhotoDrafts(answer(item({estimate:bad})),request()),NutritionPhotoError);
});
test('streamed photo bodies count actual bytes and invalid UTF-8 is rejected before parsing',async()=>{
  const body={image:{dataUrl:TINY_JPEG_DATA_URL},date:'2026-11-12'};
  assert.deepEqual(await readNutritionPhotoBody(new Request('https://app.test',{method:'POST',body:JSON.stringify(body)})),body);
  await assert.rejects(readNutritionPhotoBody(new Request('https://app.test',{method:'POST',headers:{'content-length':String(MAX_NUTRITION_PHOTO_REQUEST_BYTES+1)},body:'{}'})),(error:unknown)=>error instanceof NutritionPhotoError&&error.status===413);
  await assert.rejects(readNutritionPhotoBody(new Request('https://app.test',{method:'POST',body:'x'.repeat(MAX_NUTRITION_PHOTO_REQUEST_BYTES+1)})),(error:unknown)=>error instanceof NutritionPhotoError&&error.status===413);
  await assert.rejects(readNutritionPhotoBody(new Request('https://app.test',{method:'POST',body:new Uint8Array([0xff,0xfe])})),(error:unknown)=>error instanceof NutritionPhotoError&&error.status===400);
});
test('a stalled upload returns a safe timeout instead of waiting indefinitely',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const stream=new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});}});
  const pending=readNutritionPhotoBody(new Request('https://app.test',{method:'POST',body:stream,duplex:'half'} as RequestInit));
  const rejected=assert.rejects(pending,(error:unknown)=>error instanceof NutritionPhotoError&&error.status===408&&error.code==='NUTRITION_PHOTO_UPLOAD_TIMEOUT');
  t.mock.timers.tick(20001);await rejected;
});

test('photo drafts no longer offer withdrawn TFDA records while preserving explicit AI estimates',()=>{
  const rice=buildNutritionPhotoDrafts(answer(item({name:'白饭'})),request()).drafts[0];
  assert.deepEqual(rice.candidates,[]);assert.equal(rice.food,null);
  assert.equal(rice.calories,'320.0');assert.equal(rice.provenance.calories!.source,'ai');
  const burger=buildNutritionPhotoDrafts(answer(item({name:'麦当劳巨无霸'})),request()).drafts[0];
  assert.ok(burger.candidates.length>0);assert.ok(burger.candidates.every((food)=>food.id.startsWith('mcd-cn:')));
  assert.equal(burger.food,null);assert.equal(burger.provenance.calories!.source,'ai');
});
