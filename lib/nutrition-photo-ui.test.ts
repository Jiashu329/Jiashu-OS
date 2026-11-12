import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { installNutritionPhoto,renderNutritionPhotoPanel,type PreparedNutritionPhoto } from './nutrition-photo-ui.ts';
import type { NutritionDraft } from './nutrition-parser.ts';

const DATA='data:image/jpeg;base64,/9j/2Q==';
const prepared=(name='image'):PreparedNutritionPhoto=>({dataUrl:DATA,blob:new Blob([name],{type:'image/jpeg'}),width:800,height:600});
const draft=(date:string,meal:NutritionDraft['meal']):NutritionDraft=>({date,meal,name:'图片鸡胸饭',amount:null,unit:null,portion:'约1份',calories:'450.0',calorieSource:'ai',carbs:'50.0',protein:'0.0',fat:null,macroSources:{carbs:'ai',protein:'ai',fat:null},provenance:{calories:{source:'ai',basis:'图片份量参考',portion:'约1份',originalValue:'450.0'}},note:'AI 图片估算，需核对份量',food:null,candidates:[],warnings:['实际食用量需核对']});
async function settle(check:()=>boolean){for(let count=0;count<70;count++){if(check())return;await new Promise<void>((done)=>setImmediate(done));}assert.ok(check(),'Photo UI did not settle');}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((ok,fail)=>{resolve=ok;reject=fail;});return{promise,resolve,reject};}
function fixture(){
  const{window,document}=parseHTML(renderNutritionPhotoPanel());
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.getAttribute('value')??'';},set(value:string){for(const option of this.querySelectorAll('option'))option.toggleAttribute('selected',option.getAttribute('value')===value);}});
  let now=1000,busy=false,date='2026-11-12',blocked:string|null=null;
  const calls:Array<{body:any;signal:AbortSignal}>=[],accepted:NutritionDraft[][]=[],created:Blob[]=[],revoked:string[]=[],guardOptions:Array<Record<string,unknown>>=[],timers=new Map<number,()=>void>();let timerId=0;
  let prepare:(file:File)=>Promise<PreparedNutritionPhoto>=async()=>prepared();
  let request:(input:any,signal:AbortSignal)=>Promise<unknown>=async(input)=>({drafts:[draft(input.date,input.meal)],warnings:[]});
  const hooks={selection:()=>({date}),blocked:()=>busy?'当前操作进行中':blocked,busy:()=>busy,setBusy(value:boolean){busy=value;},request(input:unknown,signal:AbortSignal){calls.push({body:structuredClone(input),signal});return request(input,signal);},accept(rows:NutritionDraft[]){accepted.push(structuredClone(rows));blocked='已有待保存食物草稿';return true;}};
  Object.assign(window,{JiashuDraftGuards:{register(options:Record<string,unknown>){guardOptions.push(options);return{saved(){},failed(){}};}}});
  Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new Error('Images must never enter localStorage');}});
  Object.defineProperty(window,'sessionStorage',{configurable:true,get(){throw new Error('Images must never enter sessionStorage');}});
  class FixedDate extends Date{static now(){return now;}}
  const controller=runInNewContext('('+installNutritionPhoto.toString()+')(hooks,prepare)',{window,document,hooks,prepare:(file:File)=>prepare(file),URL:{createObjectURL(blob:Blob){created.push(blob);return'blob:synthetic-'+created.length;},revokeObjectURL(url:string){revoked.push(url);}},Date:FixedDate,AbortController,setTimeout(callback:()=>void){timers.set(++timerId,callback);return timerId;},clearTimeout(id:number){timers.delete(id);}}) as ReturnType<typeof installNutritionPhoto>;
  const el=(id:string)=>document.getElementById('nutrition-photo-'+id)! as unknown as HTMLInputElement;
  const event=(id:string,kind='click')=>el(id).dispatchEvent(new window.Event(kind,{bubbles:true,cancelable:true}));
  const input=(id:string,value:string,kind='input')=>{el(id).value=value;event(id,kind);};
  const file=(name='food.jpg')=>{const value={name,type:'image/jpeg',size:100} as File;Object.defineProperty(el('file'),'files',{configurable:true,value:[value]});event('file','change');return value;};
  return{window,document,el,event,input,file,controller,calls,accepted,created,revoked,guardOptions,setPrepare(fn:typeof prepare){prepare=fn;},setRequest(fn:typeof request){request=fn;},block(reason:string|null){blocked=reason;controller.refresh();},date(value:string){date=value;controller.refresh();},advance(ms:number){now+=ms;for(const callback of [...timers.values()])callback();},isBusy:()=>busy};
}

test('selecting and removing a photo stay local and the ephemeral guard never holds image content',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);assert.equal(f.el('camera').getAttribute('capture'),'environment');assert.equal(f.el('file').hasAttribute('capture'),false);
  f.file();await settle(()=>!f.el('preview').hidden);assert.equal(f.calls.length,0);assert.equal(f.el('recognize').disabled,false);assert.match(f.el('status').textContent??'',/尚未发送/);
  assert.equal(f.guardOptions[0].durable,false);assert.ok(!String((f.guardOptions[0].readValue as()=>unknown)()).includes('data:image'));
  f.event('remove');assert.equal(f.el('preview').hidden,true);assert.deepEqual(f.revoked,['blob:synthetic-1']);assert.equal(f.el('image').hasAttribute('src'),false);assert.equal(f.calls.length,0);
});
test('explicit recognition keeps four nullable nutrients and clears only the consumed photo after batch save',async()=>{
  const f=fixture();f.input('text','  米饭只吃了一半  ');f.input('meal','lunch','change');f.file();await settle(()=>!f.el('recognize').disabled);
  f.event('form','submit');await settle(()=>f.accepted.length===1&&!f.isBusy());assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].body,{image:{dataUrl:DATA},text:'米饭只吃了一半',date:'2026-11-12',meal:'lunch'});
  assert.equal(f.accepted[0][0].protein,'0.0');assert.equal(f.accepted[0][0].fat,null);assert.equal(f.accepted[0][0].provenance.calories?.source,'ai');assert.equal(f.el('preview').hidden,false);
  f.block(null);f.controller.batchSaved();assert.equal(f.el('preview').hidden,true);assert.equal(f.el('text').value,'');assert.match(f.el('status').textContent??'',/已保存/);assert.equal(f.calls.length,1);
});
test('a late decoded file cannot replace the latest photo or reintroduce a removed preview',async()=>{
  const f=fixture(),a=deferred<PreparedNutritionPhoto>(),b=deferred<PreparedNutritionPhoto>();
  f.setPrepare((file)=>file.name==='a.jpg'?a.promise:b.promise);f.file('a.jpg');f.file('b.jpg');
  const latest=prepared('latest');b.resolve(latest);await settle(()=>!f.el('preview').hidden);a.resolve(prepared('obsolete'));await new Promise<void>((done)=>setImmediate(done));assert.equal(f.created.length,1);assert.equal(f.created[0],latest.blob);
  f.file('a.jpg');f.event('remove');await new Promise<void>((done)=>setImmediate(done));assert.equal(f.el('preview').hidden,true);assert.equal(f.created.length,1);
});
test('photo edits while a request is pending leave late results outside all drafts',async()=>{
  for(const change of ['context','meal','remove','date'] as const){
    const f=fixture(),response=deferred<unknown>();f.setRequest(()=>response.promise);f.file();await settle(()=>!f.el('recognize').disabled);f.event('form','submit');assert.equal(f.calls.length,1);assert.equal(f.el('remove').disabled,false);
    if(change==='context')f.input('text','换成新的食用量');else if(change==='meal')f.input('meal','dinner','change');else if(change==='remove')f.event('remove');else f.date('2026-11-11');
    assert.equal(f.calls[0].signal.aborted,true);response.resolve({drafts:[draft('2026-11-12',null)]});await settle(()=>!f.isBusy());assert.equal(f.accepted.length,0);assert.equal(f.calls.length,1);
  }
});
test('unsupported, empty and rate-limited recognition preserve the photo and require active retry',async()=>{
  const f=fixture();f.file();f.input('text','保留这份说明');await settle(()=>!f.el('recognize').disabled);
  f.setRequest(async()=>{throw Object.assign(new Error('请选择支持图片的 MiniMax-M3 模型'),{status:400});});f.event('form','submit');await settle(()=>!f.isBusy());assert.equal(f.el('preview').hidden,false);assert.equal(f.el('text').value,'保留这份说明');assert.match(f.el('status').textContent??'',/MiniMax-M3/);
  f.setRequest(async()=>({drafts:[],warnings:[]}));f.event('form','submit');await settle(()=>!f.isBusy());assert.equal(f.accepted.length,0);assert.match(f.el('status').textContent??'',/没有识别到/);
  f.setRequest(async()=>{throw Object.assign(new Error('AI 请求较多，请稍后重试'),{status:429,retryAfter:3});});f.event('form','submit');await settle(()=>!f.isBusy());assert.equal(f.el('recognize').disabled,true);const attempts=f.calls.length;f.event('form','submit');assert.equal(f.calls.length,attempts);
  f.advance(3000);assert.equal(f.el('recognize').disabled,false);assert.equal(f.calls.length,attempts);assert.equal(f.el('preview').hidden,false);
});
test('existing draft and pending locks prevent requests and preserve current photo context',async()=>{
  const f=fixture();f.file();f.input('text','等待先处理原草稿');await settle(()=>!f.el('recognize').disabled);f.block('原批次保存结果待确认');f.event('form','submit');assert.equal(f.calls.length,0);assert.equal(f.el('preview').hidden,false);assert.equal(f.el('text').value,'等待先处理原草稿');assert.equal(f.el('recognize').disabled,true);
});
test('saving an older accepted batch does not clear a newly chosen photo or context',async()=>{
  const f=fixture();f.file();await settle(()=>!f.el('recognize').disabled);f.event('form','submit');await settle(()=>f.accepted.length===1&&!f.isBusy());
  f.file('new-meal.jpg');f.input('text','另一餐的新说明');await settle(()=>f.created.length===2);f.block(null);f.controller.batchSaved();assert.equal(f.el('preview').hidden,false);assert.equal(f.el('text').value,'另一餐的新说明');assert.deepEqual(f.revoked,['blob:synthetic-1']);
});
test('page departure clears photo resources and stops a late recognition from opening a batch',async()=>{
  const f=fixture(),response=deferred<unknown>();f.setRequest(()=>response.promise);f.file();await settle(()=>!f.el('recognize').disabled);f.input('text','本页临时说明');f.event('form','submit');f.window.dispatchEvent(new f.window.Event('pagehide'));assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.el('image').hasAttribute('src'),false);assert.equal(f.el('text').value,'');assert.deepEqual(f.revoked,['blob:synthetic-1']);response.resolve({drafts:[draft('2026-11-12',null)]});await settle(()=>!f.isBusy());assert.equal(f.accepted.length,0);
});
