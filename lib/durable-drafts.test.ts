import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { DURABLE_DRAFTS_SCRIPT } from './durable-drafts.ts';
import { DRAFT_GUARD_SCRIPT } from './draft-guard.ts';

function storage(values = new Map<string,string>()) {
  return { values, getItem(key:string){return values.get(key)??null;},setItem(key:string,value:string){values.set(key,String(value));},removeItem(key:string){values.delete(key);} };
}
type Item = {id:string;label:string;url:string;kind:string;updatedAt:string;data:unknown};
type Manager = {owner:string;problem:string;setOwner(owner:string):boolean;ready():Promise<string|null>;save(id:string,label:string,data:unknown,options?:{url?:string;kind?:string}):boolean;get(id:string):Item|null;list():Omit<Item,'data'>[];remove(id:string):boolean;clearConfirmed(id:string):boolean;storage(owner:string):Storage};
async function settle(check:()=>boolean){for(let i=0;i<40;i++){if(check())return;await new Promise<void>(resolve=>setImmediate(resolve));}assert.ok(check());}
function fixture(options:{local?:ReturnType<typeof storage>;session?:ReturnType<typeof storage>;owner?:string;now?:number;contextId?:string;fields?:string}={}){
  const {window,document}=parseHTML('<html><head></head><body><dialog id="editor"><form id="edit-form"><label for="name">名称</label><input id="name" value=""><label for="secret">密钥</label><input type="password" id="secret" value="">'+(options.fields??'')+'<button type="submit">保存</button></form></dialog></body></html>');
  const local=options.local??storage(),session=options.session??storage();Object.defineProperty(window,'localStorage',{value:local,configurable:true});Object.defineProperty(window,'sessionStorage',{value:session,configurable:true});
  const dialog=document.getElementById('editor')!;Object.defineProperty(dialog,'open',{get(){return dialog.hasAttribute('open');}});Object.assign(dialog,{showModal(){dialog.setAttribute('open','');dialog.dispatchEvent(new window.Event('toggle'));},close(){dialog.removeAttribute('open');dialog.dispatchEvent(new window.Event('close'));},getBoundingClientRect(){return {left:0,top:0,right:400,bottom:400};}});
  const requests:Array<{url:string;options?:RequestInit}>=[];const now=options.now??Date.parse('2026-11-12T04:00:00Z');class FixedDate extends Date{constructor(value?:string|number){super(value===undefined?now:value);}static now(){return now;}}
  const location=new URL('https://synthetic-drafts.example/health/weight-plan');const context={window,document,location,history:{state:null},URL,URLSearchParams,Date:FixedDate,Event:window.Event,queueMicrotask,fetch:async(url:string,init?:RequestInit)=>{requests.push({url,options:init});return Response.json({userId:options.owner??'alice'});}};
  runInNewContext(DURABLE_DRAFTS_SCRIPT,context);const manager=(window as unknown as {JiashuDrafts:Manager}).JiashuDrafts;
  if(options.owner)manager.setOwner(options.owner);
  const form=document.getElementById('edit-form')! as unknown as HTMLFormElement;const name=document.getElementById('name')! as unknown as HTMLInputElement;
  const input=(id:string,value:string)=>{const field=document.getElementById(id)! as unknown as HTMLInputElement;field.value=value;field.dispatchEvent(new window.Event('input',{bubbles:true}));};
  const click=(selector:string)=>document.querySelector(selector)!.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));
  function guard(){runInNewContext(DRAFT_GUARD_SCRIPT,context);return runInNewContext('window.JiashuDraftGuards.register({form:document.getElementById("edit-form"),dialog:document.getElementById("editor"),label:"合成编辑",durableContext:()=>'+JSON.stringify(options.contextId??'record-a')+'})',context) as {reset():void;saved():void;dirty:boolean};}
  return {window,document,manager,local,session,requests,dialog:dialog as unknown as HTMLDialogElement,form,name,input,click,guard};
}

test('recovery starts without network and explicit owner bootstrap only sends a read-only identity request',async()=>{
  const f=fixture();assert.equal(f.requests.length,0);assert.deepEqual(Array.from(f.manager.list()),[]);
  assert.deepEqual(await Promise.all([f.manager.ready(),f.manager.ready()]),['alice','alice']);assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url,'/api/session');assert.equal(f.requests[0].options?.body,undefined);
  assert.equal(f.manager.save('meal','饮食草稿',{name:'合成午餐'},{url:'/health/nutrition'}),true);
  assert.equal(f.requests.length,1);const listed=f.manager.list()[0];assert.equal(Object.hasOwn(listed,'data'),false);assert.match(listed.url,/resumeDraft=meal/);
});

test('drafts survive reopening but are only listed and read for their signed-in owner',()=>{
  const local=storage();const first=fixture({local,owner:'alice'});first.manager.save('meal','饮食草稿',{name:'alice-only'});
  const second=fixture({local,owner:'bob'});assert.equal(second.manager.get('meal'),null);assert.equal(second.manager.list().length,0);
  second.manager.setOwner('alice');assert.equal((second.manager.get('meal')?.data as {name:string}).name,'alice-only');
  assert.equal(second.manager.get('meal')?.kind,'draft');
});

test('a delayed identity response cannot replace an owner explicitly initialized by the current signed-in page',async()=>{
  const f=fixture();const loading=f.manager.ready();f.manager.setOwner('bob');assert.equal(await loading,'bob');assert.equal(f.manager.owner,'bob');
});

test('expired ordinary drafts disappear while unresolved submissions never silently expire',()=>{
  const local=storage();const first=fixture({local,owner:'alice'});first.manager.save('draft','草稿',{value:'one'});first.manager.save('pending','原提交',{key:'original'},{kind:'pending'});
  const later=fixture({local,owner:'alice',now:Date.parse('2027-01-12T04:00:00Z')});assert.equal(later.manager.get('draft'),null);assert.equal(later.manager.get('pending')?.kind,'pending');assert.equal(later.manager.remove('pending'),false);
});

test('secret-shaped fields, invalid destinations and oversized payloads are never persisted',()=>{
  const f=fixture({owner:'alice'});
  for(const data of [{apiKey:'do-not-store'},{nested:{password:'do-not-store'}},{credentials:'do-not-store'}])assert.equal(f.manager.save('bad','草稿',data),false);
  assert.equal(f.manager.save('bad','草稿',{text:'ok'},{url:'https://elsewhere.example/'}),false);
  assert.equal(f.manager.save('big','草稿',{text:'x'.repeat(65000)}),false);assert.equal(f.local.values.size,0);
  assert.equal(f.manager.save('url','普通草稿',{name:'one'},{url:'/health?metric=weight&access_token=DO_NOT_SAVE#token=DO_NOT_SAVE'}),true);
  assert.equal(f.manager.get('url')?.url,'/health?metric=weight');assert.ok(![...f.local.values.values()].join('').includes('DO_NOT_SAVE'));
});

test('pending storage preserves exact original bytes across browser sessions, rejects replacements and requires confirmation to remove',()=>{
  const local=storage(),session=storage();const first=fixture({local,session,owner:'alice'}),key='jiashu-nutrition-batch:alice';
  const raw=JSON.stringify({key:'11111111-1111-4111-8111-111111111111',body:{entries:[{name:'合成午餐',calories:null}]}});
  first.manager.storage('alice').setItem(key,raw);assert.equal(first.manager.remove('pending:'+key),false);
  const reopened=fixture({local,owner:'alice'});assert.equal(reopened.manager.storage('alice').getItem(key),raw);assert.equal(reopened.requests.length,0);
  assert.throws(()=>reopened.manager.storage('alice').setItem(key,JSON.stringify({key:'other',body:{}})),/待确认/);
  reopened.manager.setOwner('bob');assert.equal(reopened.manager.storage('bob').getItem('jiashu-nutrition-batch:bob'),null);
  reopened.manager.storage('alice').removeItem(key);assert.equal(reopened.manager.get('pending:'+key),null);
});

test('an old owner-scoped session submission migrates without regenerating identifiers or fields',()=>{
  const session=storage(),local=storage(),key='jiashu-finance-pending:v1:alice',raw=JSON.stringify({version:1,ownerId:'alice',key:'legacy-original',body:{amount:'0.00'}});session.setItem(key,raw);
  const f=fixture({local,session,owner:'alice'});assert.equal(f.manager.storage('alice').getItem(key),raw);
  assert.equal(fixture({local,owner:'alice'}).manager.storage('alice').getItem(key),raw);
});

test('nutrition history recovery keeps its original revision and operation key in the pending inbox',()=>{
  const local=storage(),f=fixture({local,owner:'alice'}),key='jiashu-nutrition-history:alice';
  const raw=JSON.stringify({key:'11111111-1111-4111-8111-111111111111',entryId:'22222222-2222-4222-8222-222222222222',body:{revision:1,expectedRevision:4}});
  f.manager.storage('alice').setItem(key,raw);const reopened=fixture({local,owner:'alice'});
  assert.equal(reopened.manager.storage('alice').getItem(key),raw);assert.match(reopened.manager.list()[0].label,/版本恢复/);
});

test('goal and balance pending inbox links return to the matching ledger workflow rather than an unrelated page',()=>{
  const f=fixture({owner:'alice'});
  f.manager.storage('alice').setItem('jiashu-finance-goal-create:alice',JSON.stringify({key:'original',body:{ledger:'family',currency:'USD',name:'合成目标'}}));
  assert.equal(f.manager.list()[0].url,'/finance/goals?ledger=family&currency=USD');
});

test('an unchanged generic form restores only on explicit action and never captures a password',async()=>{
  const local=storage(),first=fixture({local,owner:'alice',fields:'<input id="connection-token" type="text">'});const guard=first.guard();first.dialog.showModal();guard.reset();first.input('name','未完成的合成名称');first.input('secret','NEVER_PERSIST_THIS');first.input('connection-token','NEVER_PERSIST_TOKEN');
  await settle(()=>first.manager.list().length===1);assert.ok(![...local.values.values()].join('').includes('NEVER_PERSIST_THIS'));assert.ok(![...local.values.values()].join('').includes('NEVER_PERSIST_TOKEN'));
  const reopened=fixture({local,owner:'alice'}),next=reopened.guard();reopened.dialog.showModal();next.reset();await settle(()=>!!reopened.document.querySelector('[data-durable-recovery]'));
  assert.equal(reopened.name.value,'');reopened.click('[data-durable-choice="restore"]');assert.equal(reopened.name.value,'未完成的合成名称');assert.equal(reopened.requests.length,0);assert.equal(next.dirty,true);
  next.saved();assert.equal(reopened.manager.list().length,0);
});

test('a changed record context blocks applying an old draft instead of editing a different record',async()=>{
  const local=storage(),first=fixture({local,owner:'alice',contextId:'record-a'});const guard=first.guard();first.dialog.showModal();guard.reset();first.input('name','属于 A 的草稿');
  const reopened=fixture({local,owner:'alice',contextId:'record-b'}),next=reopened.guard();reopened.dialog.showModal();next.reset();await settle(()=>!!reopened.document.querySelector('[data-durable-recovery]'));
  reopened.click('[data-durable-choice="restore"]');assert.equal(reopened.name.value,'');assert.match(reopened.document.querySelector('[data-durable-recovery]')?.textContent??'',/已经变化/);
});

test('prefilled passwords and text API keys are excluded from the stored restore baseline as well as field values',()=>{
  const f=fixture({owner:'alice',fields:'<input id="api-key" type="text" value="INITIAL_API_KEY">'});
  (f.document.getElementById('secret') as unknown as HTMLInputElement).value='INITIAL_PASSWORD';
  const guard=f.guard();f.dialog.showModal();guard.reset();f.input('name','仅保存这项普通填写');
  const saved=[...f.local.values.values()].join('');assert.ok(saved.includes('仅保存这项普通填写'));assert.ok(!saved.includes('INITIAL_PASSWORD'));assert.ok(!saved.includes('INITIAL_API_KEY'));
});

test('a stale restore control cannot overwrite fresh unsaved input typed after the offer',async()=>{
  const local=storage(),first=fixture({local,owner:'alice'}),guard=first.guard();first.dialog.showModal();guard.reset();first.input('name','旧草稿');
  const next=fixture({local,owner:'alice'}),registration=next.guard();next.dialog.showModal();registration.reset();await settle(()=>!!next.document.querySelector('[data-durable-recovery]'));
  const oldControl=next.document.querySelector('[data-durable-choice="restore"]')!;next.input('name','新的尚未保存内容');oldControl.dispatchEvent(new next.window.Event('click',{bubbles:true}));
  assert.equal(next.name.value,'新的尚未保存内容');assert.ok(JSON.stringify(next.manager.get('form:/health/weight-plan:edit-form')?.data).includes('新的尚未保存内容'));
});

test('storage failures retain the currently typed input and the original pending submission',()=>{
  const local=storage(),f=fixture({local,owner:'alice'}),key='jiashu-nutrition-create:alice';f.manager.storage('alice').setItem(key,JSON.stringify({key:'original',body:{name:'合成'}}));
  local.setItem=()=>{throw new Error('synthetic storage full');};f.name.value='仍在本页';assert.equal(f.manager.save('new','草稿',{name:f.name.value}),false);assert.equal(f.name.value,'仍在本页');
  assert.throws(()=>f.manager.storage('alice').removeItem(key),/无法清理/);assert.ok(f.manager.storage('alice').getItem(key));
});

test('failed session cleanup retains the durable original instead of erasing a still-unconfirmed request',()=>{
  const local=storage(),session=storage(),f=fixture({local,session,owner:'alice'}),key='jiashu-nutrition-create:alice';
  const raw=JSON.stringify({key:'original',body:{name:'合成'}});f.manager.storage('alice').setItem(key,raw);
  session.removeItem=()=>{throw new Error('synthetic cleanup blocked');};
  assert.throws(()=>f.manager.storage('alice').removeItem(key),/未能清理/);assert.equal(f.manager.storage('alice').getItem(key),raw);
  assert.equal(fixture({local,owner:'alice'}).manager.storage('alice').getItem(key),raw);
});

test('a malformed recovery store is not silently overwritten by a new draft or cleanup operation',()=>{
  const local=storage(),raw='{incomplete-recovery-data';local.setItem('jiashu-work:v1:alice',raw);const f=fixture({local,owner:'alice'});
  assert.equal(f.manager.get('anything'),null);assert.equal(f.manager.save('new','新草稿',{name:'one'}),false);assert.equal(f.manager.clearConfirmed('old'),false);
  assert.equal(local.getItem('jiashu-work:v1:alice'),raw);
});
