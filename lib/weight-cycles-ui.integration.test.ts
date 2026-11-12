import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {parseHTML} from 'linkedom';
import {renderWeightPlanPage} from '../weight-plan-page.ts';
import {renderWeightPlanScript} from './weight-plan-ui.ts';
import {buildWeightPlanReview} from './weight-plan.ts';
import {buildWeightCycleSummary} from './weight-cycles.ts';
import type{WeightCyclePageData}from'./weight-cycles-ui.ts';
import type{WeightCycleArchive,WeightCycleCommand}from'./weight-cycles.ts';
const NOW=Date.parse('2026-11-12T04:00:00.000Z');
const settings={baselineWeight:80,targetWeight:70,startDate:'2026-11-01',deadline:'2026-12-01',enabled:true,createdAt:new Date(NOW).toISOString(),updatedAt:new Date(NOW).toISOString(),revision:1};
async function settle(check:()=>boolean){for(let count=0;count<60;count++){if(check())return;await new Promise<void>((done)=>setImmediate(done));}assert.ok(check());}
async function fixture(seed?:Map<string,{data:unknown}>){
  const {window,document}=parseHTML(renderWeightPlanPage());
  const drafts=seed??new Map<string,{data:unknown}>(),writes:Array<{key:string;body:WeightCycleCommand}>=[],receipts=new Map<string,WeightCyclePageData>(),saveAttempts:Array<{key:string;body:WeightCycleCommand}>=[],deadlines=new Map<number,()=>void>();let loseReply=false,storageBlocked=false,cleanupBlocked=false,hangReply=false,timerId=0;
  let data:WeightCyclePageData={...buildWeightPlanReview(settings,[],NOW),cycle:{id:'legacy',archivedAt:null},cycles:[],cycleCount:0};
  const manager={ready:async()=>true,get:(id:string)=>drafts.get(id)??null,save:(id:string,_label:string,value:unknown)=>{saveAttempts.push(structuredClone(value) as {key:string;body:WeightCycleCommand});if(storageBlocked)return false;drafts.set(id,{data:structuredClone(value)});return true;},clearConfirmed:(id:string)=>{if(cleanupBlocked)return false;drafts.delete(id);return true;}};
  Object.assign(window,{JiashuDrafts:manager,JiashuDraftGuards:{register:()=>({reset(){},saved(){},failed(){}})}});
  class FixedDate extends Date{constructor(value?:string|number){super(value===undefined?NOW:value);}static now(){return NOW;}}
  const location={pathname:'/health/weight-plan',search:'',origin:'https://synthetic.example'},history={replaceState(_value:unknown,_unused:string,path:string){location.search=new URL(path,location.origin).search;}};
  const fetch=async(url:string,options?:RequestInit)=>{
    if(!options?.method||options.method==='GET')return Response.json(structuredClone(data));
    const key=new Headers(options.headers).get('Idempotency-Key')!,body=JSON.parse(String(options.body)) as WeightCycleCommand;writes.push({key,body});
    if(receipts.has(key))return Response.json(receipts.get(key));
    if(body.action==='archive'){
      const archive:WeightCycleArchive={id:data.cycle!.id,settings:data.settings!,summary:buildWeightCycleSummary(data.settings!,[],NOW),startedAt:data.settings!.createdAt,archivedAt:new Date(NOW).toISOString()};
      data={...buildWeightPlanReview({...data.settings!,enabled:false,revision:data.settings!.revision!+1},[],NOW),cycle:{id:data.cycle!.id,archivedAt:new Date(NOW).toISOString()},cycles:[archive],cycleCount:1};
    }else data={...buildWeightPlanReview({...body.plan,createdAt:new Date(NOW).toISOString(),updatedAt:new Date(NOW).toISOString(),revision:body.expectedRevision+1},[],NOW),cycle:{id:key,archivedAt:null},cycles:data.cycles,cycleCount:data.cycleCount};
    receipts.set(key,structuredClone(data));if(loseReply){loseReply=false;throw new Error('synthetic lost reply');}if(hangReply){hangReply=false;return new Promise<Response>(()=>{});}return Response.json(data);
  };
  runInNewContext(renderWeightPlanScript().replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''),{window,document,location,history,fetch,crypto:webcrypto,Date:FixedDate,Intl,URL,URLSearchParams,AbortController,Response,Headers,setTimeout:(callback:()=>void)=>{deadlines.set(++timerId,callback);return timerId;},clearTimeout:(id:number)=>{deadlines.delete(id);},queueMicrotask});
  const el=(id:string)=>document.getElementById('weight-plan-'+id)! as unknown as HTMLInputElement;
  await settle(()=>el('page').getAttribute('aria-busy')==='false');
  return{el,drafts,writes,saveAttempts,lose(){loseReply=true;},blockStorage(value:boolean){storageBlocked=value;},blockCleanup(value:boolean){cleanupBlocked=value;},hang(){hangReply=true;},expire(){for(const callback of [...deadlines.values()])callback();},click(id:string){el(id).dispatchEvent(new window.Event('click',{bubbles:true}));},fill(id:string,value:string){el(id).value=value;el(id).dispatchEvent(new window.Event('input',{bubbles:true}));},submit(){el('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));}};
}
test('weight cycle archive waits for confirmation and new cycle requires explicit fresh form submission',async()=>{
  const f=await fixture();assert.equal(f.writes.length,0);f.click('cycle-archive-open');assert.equal(f.el('cycle-confirmation').hidden,false);assert.equal(f.writes.length,0);f.click('cycle-confirm');await settle(()=>f.el('cycle-start-prepare').hidden===false&&f.el('cycle-confirm').disabled===false);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].body.action,'archive');assert.equal(f.el('form').hidden,true);assert.match(f.el('cycle-list').textContent??'',/归档时近7天日均/);
  f.click('cycle-start-prepare');assert.equal(f.el('form').hidden,false);assert.equal(f.el('target').value,'');assert.equal(f.writes.length,1);
  f.fill('baseline','75');f.fill('target','72');f.fill('deadline','2026-12-12');f.submit();await settle(()=>f.writes.length===2&&f.el('cycle-archive-open').hidden===false);
  assert.equal(f.writes[1].body.action,'start');assert.equal(f.drafts.size,0);assert.match(f.el('cycle-list').textContent??'',/80 → 70 kg/);
});
test('lost archive reply locks the original operation and reload offers exact retry without automatic submission',async()=>{
  const f=await fixture();f.lose();f.click('cycle-archive-open');f.click('cycle-confirm');await settle(()=>!f.el('cycle-retry').hidden&&!f.el('cycle-retry').disabled);
  assert.equal(f.writes.length,1);assert.equal(f.el('save').disabled,true);const original=f.writes[0];
  const next=await fixture(f.drafts);assert.equal(next.writes.length,0);await settle(()=>!next.el('cycle-retry').hidden);next.click('cycle-retry');await settle(()=>next.writes.length===1&&next.drafts.size===0);
  assert.deepEqual(next.writes[0],original);
});
test('archiving cannot silently discard newly typed plan fields',async()=>{
  const f=await fixture();f.fill('target','65');f.click('cycle-archive-open');assert.equal(f.el('cycle-confirmation').hidden,true);assert.equal(f.writes.length,0);assert.equal(f.el('target').value,'65');assert.match(f.el('cycle-status').textContent??'',/尚未保存/);
});
test('failed local pending storage prevents POST and retry uses the untouched original operation',async()=>{
  const f=await fixture();f.blockStorage(true);f.click('cycle-archive-open');f.click('cycle-confirm');await settle(()=>!f.el('cycle-retry').hidden&&!f.el('cycle-retry').disabled);
  assert.equal(f.writes.length,0);assert.equal(f.saveAttempts.length,1);const original=f.saveAttempts[0];assert.match(f.el('cycle-status').textContent??'',/未发送到服务器/);assert.equal(f.el('save').disabled,true);
  f.blockStorage(false);f.click('cycle-retry');await settle(()=>f.writes.length===1&&f.drafts.size===0&&!f.el('cycle-confirm').disabled);assert.deepEqual(f.writes[0],original);assert.deepEqual(f.saveAttempts[1],original);
});
test('a stalled cycle response reaches observable pending state at the shared deadline and replays exactly',async()=>{
  const f=await fixture();f.hang();f.click('cycle-archive-open');f.click('cycle-confirm');await settle(()=>f.writes.length===1);const original=f.writes[0];f.expire();await settle(()=>!f.el('cycle-retry').hidden&&!f.el('cycle-retry').disabled);
  assert.match(f.el('cycle-status').textContent??'',/超时/);assert.equal(f.el('save').disabled,true);f.click('cycle-retry');await settle(()=>f.writes.length===2&&f.drafts.size===0);assert.deepEqual(f.writes[1],original);
});
test('confirmed response with failed local cleanup remains locked until original operation is safely cleared',async()=>{
  const f=await fixture();f.blockCleanup(true);f.click('cycle-archive-open');f.click('cycle-confirm');await settle(()=>!f.el('cycle-retry').hidden&&!f.el('cycle-retry').disabled);
  const original=f.writes[0];assert.equal(f.drafts.size,1);assert.match(f.el('cycle-status').textContent??'',/本机待确认标识未能清理/);assert.equal(f.el('save').disabled,true);
  f.blockCleanup(false);f.click('cycle-retry');await settle(()=>f.writes.length===2&&f.drafts.size===0);assert.deepEqual(f.writes[1],original);
});
