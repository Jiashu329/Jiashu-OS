import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderManagedFoodPage } from '../managed-food-page.ts';
import { MANAGED_FOOD_SCRIPT } from './managed-food-ui.ts';
import mcd from '../data/food-catalog-releases/mcd-cn-2025-04-v1.json' with {type:'json'};
import type { ManagedFoodAdminItem, ManagedFoodDefinition } from './managed-food-catalog.ts';

const definition:ManagedFoodDefinition={name:'参考食品',aliases:['参考别名'],brandId:'mcd-cn',brandName:'麦当劳',category:'小食',description:'官方文字说明',sourceName:'包装营养标签',sourceUrl:'https://example.com/food',portionLabel:'每包30g',calories:'0.0',carbs:null,protein:'1.2',fat:null,imageUrl:''};
const item=(revision=1):ManagedFoodAdminItem=>({id:'11111111-1111-4111-8111-111111111111',revision,status:'draft',replacesId:null,draft:{...definition},published:null,publishedRevision:null,hasDraftChanges:true,createdAt:'2026-11-14T01:00:00Z',updatedAt:'2026-11-14T01:00:00Z'});
const settle=async(check:()=>boolean)=>{for(let n=0;n<80;n++){if(check())return;await new Promise<void>(resolve=>setImmediate(resolve));}assert.ok(check(),'Managed-food UI did not settle');};
function storage(seed:Record<string,string>={}){const values=new Map(Object.entries(seed));return {getItem(key:string){return values.get(key)??null;},setItem(key:string,value:string){values.set(key,String(value));},removeItem(key:string){values.delete(key);},snapshot(){return Object.fromEntries(values);}};}
function fixture(options:{items?:ManagedFoodAdminItem[];write?:(body:Record<string,unknown>,key:string)=>Response|Promise<Response>;seed?:Record<string,string>}={}){
  const {window,document}=parseHTML(renderManagedFoodPage());
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.getAttribute('value')??this.querySelector('option')?.getAttribute('value')??'';},set(value:string){for(const option of this.querySelectorAll('option')){if(option.getAttribute('value')===String(value))option.setAttribute('selected','');else option.removeAttribute('selected');}}});
  Object.defineProperty(window.HTMLElement.prototype,'focus',{configurable:true,value(){}});
  document.querySelectorAll('dialog').forEach(dialog=>{Object.defineProperty(dialog,'open',{configurable:true,get(){return dialog.hasAttribute('open');}});Object.assign(dialog,{showModal(){dialog.setAttribute('open','');},close(){dialog.removeAttribute('open');}});});
  const requests:Array<{method:string;body?:Record<string,unknown>;key?:string}>=[];
  const sessionStorage=storage(options.seed);
  const session={document,changed:false,async request(path:string,init:RequestInit){assert.equal(path,'/api/health/foods/manage');const method=init.method??'GET';assert.equal((init.headers as Record<string,string>)['X-Page-Owner'],'owner');if(method==='GET'){requests.push({method});return Response.json({canManage:true,items:options.items??[],builtin:[mcd.foods[0]],images:{[mcd.foods[0].id]:{src:'/food-images/mcd-cn/49.png',alt:'巨无霸'}}});}const body=JSON.parse(String(init.body)) as Record<string,unknown>,key=(init.headers as Record<string,string>)['Idempotency-Key'];requests.push({method,body,key});return options.write?options.write(body,key):Response.json({item:{...item(),...(body.definition?{draft:body.definition}:{})},replayed:false});}};
  Object.assign(window,{__JIASHU_PAGE_OWNER__:'owner',JiashuAccountSession:session});
  runInNewContext(MANAGED_FOOD_SCRIPT,{window,document,sessionStorage,crypto:webcrypto,URL,Map,AbortController,setTimeout,clearTimeout,Number,JSON});
  const el=(id:string)=>document.getElementById('mf-'+id)! as unknown as HTMLElement&{value:string;disabled:boolean;open:boolean;readOnly:boolean};
  const event=(name:string)=>new window.Event(name,{bubbles:true,cancelable:true});
  const click=(id:string|Element)=>(typeof id==='string'?el(id):id).dispatchEvent(event('click'));
  return {window,document,sessionStorage,session,requests,el,click,async ready(){await settle(()=>el('content').hidden===false);},submit(){el('form').dispatchEvent(event('submit'));},input(id:string,value:string){el(id).value=value;el(id).dispatchEvent(event('input'));},fill(){for(const [id,value]of Object.entries({name:'参考食品',category:'小食',portion:'每包30g','source-name':'包装营养标签','source-url':'https://example.com/food',calories:'0',protein:'1.2'}))el(id).value=value;}};
}

test('opening management, new editor and preview remain read-only; zeros and unknown values are distinct',async()=>{
  const f=fixture();await f.ready();assert.deepEqual(f.requests.map(row=>row.method),['GET']);
  f.click('new');f.fill();f.click('preview');
  assert.equal(f.el('review').open,true);assert.equal(f.el('confirm').hidden,true);
  assert.match(f.el('review-content').textContent??'',/0 kcal/);assert.match(f.el('review-content').textContent??'',/未知/);
  assert.equal(f.requests.length,1);
});

test('saving creates only a draft and publishing requires a separate explicit reviewed action',async()=>{
  let saved=item();const f=fixture({write(body){if(body.action==='save'){saved={...saved,draft:body.definition as ManagedFoodDefinition};return Response.json({item:saved,replayed:false});}return Response.json({item:{...saved,revision:2,status:'published',publishedRevision:2,published:saved.draft,hasDraftChanges:false},replayed:false});}});
  await f.ready();f.click('new');f.fill();f.submit();await settle(()=>f.requests.length===2&&!f.el('new').disabled);
  assert.equal(f.requests[1].body?.action,'save');assert.equal((f.requests[1].body?.definition as ManagedFoodDefinition).calories,'0');assert.equal((f.requests[1].body?.definition as ManagedFoodDefinition).fat,null);
  assert.match(f.el('list').textContent??'',/草稿/);assert.equal(f.requests.filter(row=>row.body?.action==='publish').length,0);
  f.click(f.el('list').querySelector('[data-mf-review]')!);assert.equal(f.el('review').open,true);assert.equal(f.requests.length,2);
  f.click('confirm');await settle(()=>f.requests.length===3&&!f.el('new').disabled);
  assert.deepEqual(f.requests[2].body,{action:'publish',id:saved.id,expectedRevision:1});assert.match(f.el('list').textContent??'',/已发布/);
});

test('built-in editing reuses an existing maintenance copy and preserves its source data',async()=>{
  const existing={...item(4),replacesId:mcd.foods[0].id};const f=fixture({items:[existing]});await f.ready();
  f.click(f.document.querySelector('[data-mf-tab="builtin"]')!);f.click(f.el('list').querySelector('[data-mf-copy]')!);
  assert.equal(f.el('name').value,definition.name);assert.equal(f.el('calories').value,'0.0');assert.equal(f.el('fat').value,'');
  f.submit();await settle(()=>f.requests.length===2&&!f.el('new').disabled);
  assert.equal(f.requests[1].body?.id,existing.id);assert.equal(f.requests[1].body?.expectedRevision,4);assert.equal(f.requests[1].body?.replacesId,mcd.foods[0].id);
});

test('a lost response retains the original body and key, blocks other writes, and retries only on user action',async()=>{
  let attempts=0;const f=fixture({write(){attempts++;if(attempts===1)throw new Error('lost response');return Response.json({item:item(),replayed:true});}});await f.ready();f.click('new');f.fill();f.submit();
  await settle(()=>f.requests.length===2&&!f.el('retry').disabled);
  assert.equal(f.el('pending').hidden,false);assert.equal(f.el('new').disabled,true);assert.equal(f.el('save').disabled,true);
  assert.ok(f.sessionStorage.getItem('jiashu-managed-food-pending:owner'));
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.requests.length,2);
  f.click('retry');await settle(()=>f.requests.length===3&&f.el('pending').hidden);
  assert.equal(f.requests[1].key,f.requests[2].key);assert.deepEqual(f.requests[1].body,f.requests[2].body);assert.equal(f.sessionStorage.getItem('jiashu-managed-food-pending:owner'),null);
});

test('a revision conflict keeps unsaved fields visible and does not overwrite or automatically retry',async()=>{
  const f=fixture({items:[item()],write(){return Response.json({error:'食品已更新，请核对最新版本。',code:'MANAGED_FOOD_CONFLICT'},{status:409});}});await f.ready();f.click(f.el('list').querySelector('[data-mf-edit]')!);f.input('name','保留我的修改');f.submit();
  await settle(()=>f.requests.length===2&&!f.el('save').disabled);
  assert.equal(f.el('editor').open,true);assert.equal(f.el('name').value,'保留我的修改');assert.match(f.el('form-error').textContent??'',/当前填写已保留/);assert.equal(f.el('pending').hidden,true);assert.equal(f.requests.length,2);
});

test('new brand IDs are independent and source/image input cannot create executable links',async()=>{
  const f=fixture();await f.ready();f.click('new');f.fill();f.el('brand').value='new';f.el('brand').dispatchEvent(new f.window.Event('change',{bubbles:true}));f.input('brand-name','自有品牌');f.input('image-url','javascript:alert(1)');f.submit();
  assert.equal(f.requests.length,1);assert.equal(f.el('image-preview').hidden,true);assert.match(f.el('form-error').textContent??'',/图片/);
  f.input('image-url','https://images.example.com/food.png');f.submit();await settle(()=>f.requests.length===2&&!f.el('new').disabled);
  const value=f.requests[1].body?.definition as ManagedFoodDefinition;assert.match(value.brandId,/^custom-[0-9a-f-]{36}$/);assert.equal(value.brandName,'自有品牌');
});

test('management page requires the authenticated owner and pins owner identity with no-store HTML',async()=>{
  const source=stripTypeScriptTypes(readFileSync(new URL('../app/health/foods/manage/route.ts',import.meta.url),'utf8'),{mode:'strip'}).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
  let isOwner=false;const get=new Function('requireChatGPTUser','withPageAccount','renderManagedFoodPage',source+'\nreturn GET;')(async(path:string)=>{assert.equal(path,'/health/foods/manage');return {userId:'owner',isOwner};},(html:string,id:string)=>html.replace('<head>','<head><meta name="test-owner" content="'+id+'">'),renderManagedFoodPage) as ()=>Promise<Response>;
  assert.equal((await get()).status,403);isOwner=true;const response=await get();assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.match(await response.text(),/test-owner/);
});
