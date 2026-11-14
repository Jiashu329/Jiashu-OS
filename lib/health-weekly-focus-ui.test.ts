import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderHealthWeeklyPage } from '../health-weekly-page.ts';
import { renderHealthWeeklyScript } from './health-weekly-ui.ts';
import { buildHealthWeeklyReview, parseHealthWeekQuery } from './health-weekly.ts';
import { buildHealthWeeklyFocus } from './health-weekly-focus.ts';
import type { HealthMeasurement } from './health.ts';
import type { WeeklyAction } from './health-weekly-actions.ts';

const NOW=new Date('2026-11-14T04:00:00Z');
const currentAction:WeeklyAction={weekStart:'2026-11-09',text:'保持午间散步',status:'planned',feedback:'',revision:1,createdAt:NOW.toISOString(),updatedAt:NOW.toISOString()};
function review(week='2026-11-09',actions:{current:WeeklyAction|null;next:WeeklyAction|null}={current:currentAction,next:null}){
 const measurements:HealthMeasurement[]=[];
 for(let day=9;day<=13;day++)measurements.push({id:'sleep-'+day,metric:'sleep',value:5.5,aggregation:'daily',unit:'hours',source:'synthetic',startDate:'2026-11-'+String(day).padStart(2,'0')+'T00:00:00+08:00',endDate:'2026-11-'+String(day).padStart(2,'0')+'T08:00:00+08:00'});
 const settings={targets:{steps:null,sleep:7,active_energy:null},updatedAt:null,effectiveFrom:'2026-11-01'};
 const base=buildHealthWeeklyReview(measurements,settings,parseHealthWeekQuery(new URLSearchParams({week}),NOW),NOW,{actions:{previous:null,...actions}});
 return{...base,focus:buildHealthWeeklyFocus(base)};
}
async function settle(check:()=>boolean){for(let i=0;i<70;i++){if(check())return;await new Promise<void>(resolve=>setImmediate(resolve));}assert.ok(check());}
function fixture(options:{next?:WeeklyAction|null;current?:WeeklyAction|null;withGuards?:boolean;focus?:Record<string,unknown>;actionsUnavailable?:boolean}={}){
 const {window,document}=parseHTML(renderHealthWeeklyPage());
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.getAttribute('value')??this.querySelector('option')?.getAttribute('value')??'';},set(value:string){for(const option of this.querySelectorAll('option'))if(option.getAttribute('value')===String(value))option.setAttribute('selected','');else option.removeAttribute('selected');}});
 let url=new URL('https://synthetic-weekly.example/health/review?week=2026-11-09'),failSave=false,failRead=false,pendingRead:null|(()=>Promise<Response>)=null,verify:()=>Promise<void>=async()=>{};
 const requests:Array<{url:string;method:string;body:unknown}>=[],registrations:Record<string,unknown>[]=[],confirmations:Array<()=>void>=[];
 let actions={current:options.current===undefined?structuredClone(currentAction):options.current,next:options.next??null};
 const session={changed:false,verify:()=>verify(),request:async(input:string,init:RequestInit={})=>{
  const parsed=new URL(input,url),method=init.method??'GET',body=init.body?JSON.parse(String(init.body)):null;requests.push({url:parsed.pathname+parsed.search,method,body});
  if(parsed.pathname==='/api/health/review'){if(pendingRead)return pendingRead();if(failRead)throw new Error('Synthetic read failed');const data=review(parsed.searchParams.get('week')??'2026-11-09',actions);if(options.focus)data.focus=options.focus as unknown as typeof data.focus;if(options.actionsUnavailable)data.supplementalStatus.actions='unavailable';return Response.json(data);}
  if(parsed.pathname==='/api/health/actions'){
   if(failSave)return Response.json({error:'其他页面已更新行动。',code:'WEEKLY_ACTION_CONFLICT'},{status:409});
   const action={...body,revision:body.expectedRevision+1,createdAt:NOW.toISOString(),updatedAt:NOW.toISOString()};
   if(body.weekStart==='2026-11-09')actions.current=action;else actions.next=action;return Response.json({action});
  }
  throw new Error('Unexpected request '+input);
 }};
 Object.assign(window,{JiashuAccountSession:session,JiashuDraftGuards:undefined});
 if(options.withGuards)Object.assign(window,{JiashuDraftGuards:{register(value:Record<string,unknown>){registrations.push(value);return{reset(){},saved(){},failed(){},confirm(action:()=>void){if((value.isDirty as ()=>boolean)())confirmations.push(()=>{(value.onDiscard as ()=>void)();action();});else action();}};}}});
 const location={get origin(){return url.origin;},get pathname(){return url.pathname;},get search(){return url.search;},get href(){return url.href;}},history={replaceState(_a:unknown,_b:string,path:string){url=new URL(path,url);}};
 class FixedDate extends Date{constructor(value?:string|number){super(value===undefined?NOW.getTime():value);}static now(){return NOW.getTime();}}
 const source=renderHealthWeeklyScript().replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'');
 runInNewContext(source,{window,document,location,history,Intl,Date:FixedDate,URL,URLSearchParams,Headers,AbortController,Event:window.Event,setTimeout,clearTimeout,queueMicrotask,fetch:()=>{throw new Error('Weekly requests must use the pinned account transport');}});
 const el=(id:string)=>document.getElementById('weekly-'+id)! as HTMLElement&{value:string;disabled:boolean;hidden:boolean};
 return{window,document,el,requests,registrations,confirmations,session,location,setFailure(value:boolean){failSave=value;},setReadFailure(value:boolean){failRead=value;},deferRead(value:()=>Promise<Response>){pendingRead=value;},setUrl(value:string){url=new URL(value,url);},setVerify(value:()=>Promise<void>){verify=value;},setActions(value:typeof actions){actions=value;},input(id:string,value:string){el(id).value=value;el(id).dispatchEvent(new window.Event('input',{bubbles:true}));},click(id:string){el(id).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));},submit(id:string){el(id).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));}};
}

test('weekly review leads with a bounded focus and keeps all original data in closed details',async()=>{
 const f=fixture();await settle(()=>f.el('page').getAttribute('aria-busy')==='false');
 assert.match(f.el('focus-headline').textContent??'',/睡眠/);assert.match(f.el('focus-primary').textContent??'',/5.5/);assert.equal(f.el('focus-summary').hidden,true,'the headline evidence should not repeat as a second paragraph');
 assert.equal(f.el('details').hasAttribute('open'),false);for(const id of ['metrics','goals','nutrition','weight-plan','completeness','daily-rows'])assert.ok(f.el('details').contains(f.el(id)),id);
 assert.equal(f.document.querySelectorAll('#weekly-focus-secondary article').length<=2,true);assert.equal(f.requests.every(request=>request.method==='GET'),true);
 const ids=[...f.document.querySelectorAll('[id]')].map(node=>node.id);assert.equal(new Set(ids).size,ids.length);
});

test('using a suggestion only fills the next action draft and its separate submit saves it',async()=>{
 const f=fixture({withGuards:true});await settle(()=>f.el('page').getAttribute('aria-busy')==='false');assert.equal(f.registrations.length,2);assert.ok(f.registrations.every(value=>value.durable===false));
 const suggestion=f.el('focus-action-text').textContent;assert.ok(suggestion);f.click('focus-use-action');await settle(()=>f.el('action-text').value===suggestion);
 assert.equal(f.requests.filter(request=>request.method==='PUT').length,0);assert.equal(f.el('focus-use-action').disabled,true);assert.match(f.el('focus-action-message').textContent??'',/草稿.*保存行动/);
 f.submit('action-form');await settle(()=>f.el('action-message').textContent==='下一周行动已保存。');assert.equal(f.requests.filter(request=>request.method==='PUT').length,1);assert.match(f.el('focus-action-message').textContent??'',/已保存行动/);
});

test('saved next actions, unsaved feedback and account changes block adopting suggested text',async()=>{
 const saved=fixture({next:{...currentAction,weekStart:'2026-11-16',text:'原来的下一周行动'}});await settle(()=>saved.el('page').getAttribute('aria-busy')==='false');assert.equal(saved.el('focus-use-action').disabled,true);saved.click('focus-use-action');assert.equal(saved.el('action-text').value,'原来的下一周行动');
 const f=fixture();await settle(()=>f.el('page').getAttribute('aria-busy')==='false');f.input('action-feedback','尚未保存的反馈');assert.equal(f.el('focus-use-action').disabled,true);f.click('focus-use-action');assert.equal(f.el('action-text').value,'');
 f.input('action-feedback','');let finish!:()=>void;f.setVerify(()=>new Promise<void>(resolve=>{finish=resolve;}));f.click('focus-use-action');f.input('action-text','核对账号时新写的行动');finish();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.el('action-text').value,'核对账号时新写的行动');
 f.session.changed=true;f.document.dispatchEvent(new f.window.Event('jiashu-account-changed'));assert.equal(f.el('focus-use-action').disabled,true);assert.match(f.el('status-text').textContent??'',/账号已变化/);
});

test('changing weeks keeps unsaved inputs until the shared guard explicitly discards them',async()=>{
 const f=fixture({withGuards:true});await settle(()=>f.el('page').getAttribute('aria-busy')==='false');f.input('action-text','尚未保存的计划');f.click('previous');assert.equal(f.confirmations.length,1);assert.equal(f.requests.length,1);assert.equal(f.el('action-text').value,'尚未保存的计划');f.confirmations[0]();await settle(()=>f.requests.length===2&&f.el('page').getAttribute('aria-busy')==='false');assert.match(f.requests[1].url,/week=2026-11-02/);
});

test('the guard fallback exposes a concrete discard action instead of silently replacing a draft',async()=>{
 const f=fixture();await settle(()=>f.el('page').getAttribute('aria-busy')==='false');f.input('action-text','保留我');f.click('previous');assert.equal(f.requests.length,1);assert.equal(f.el('discard').hidden,false);assert.equal(f.el('action-text').value,'保留我');f.click('discard');await settle(()=>f.requests.length===2&&f.el('page').getAttribute('aria-busy')==='false');assert.match(f.requests[1].url,/week=2026-11-02/);
});

test('conflicts reload the latest revision while retaining both action and feedback drafts',async()=>{
 const f=fixture();await settle(()=>f.el('page').getAttribute('aria-busy')==='false');f.input('action-text','保留的下周填写');f.input('action-feedback','保留的反馈');f.setFailure(true);f.submit('action-form');await settle(()=>f.el('reload-actions').hidden===false);assert.equal(f.el('focus-use-action').disabled,true);f.click('reload-actions');await settle(()=>f.requests.filter(request=>request.method==='GET').length===2&&f.el('page').getAttribute('aria-busy')==='false');assert.equal(f.el('action-text').value,'保留的下周填写');assert.equal(f.el('action-feedback').value,'保留的反馈');assert.match(f.el('status-text').textContent??'',/原填写已保留/);assert.equal(f.requests.filter(request=>request.method==='PUT').length,1);
});


test('a failed latest-action read leaves visible drafts protected and inputs are frozen while reading',async()=>{
 const f=fixture({withGuards:true});await settle(()=>f.el('page').getAttribute('aria-busy')==='false');f.input('action-text','读取失败也保留');f.input('action-feedback','同样保留反馈');f.setFailure(true);f.submit('action-form');await settle(()=>f.el('reload-actions').hidden===false);
 let reject!:(error:Error)=>void;f.deferRead(()=>new Promise<Response>((_resolve,rejecter)=>{reject=rejecter;}));f.click('reload-actions');
 assert.equal(f.el('content').hidden,false);assert.equal(f.el('action-text').disabled,true);assert.equal((f.registrations[0].canSave as ()=>boolean)(),false);assert.equal(f.el('focus-use-action').disabled,true);
 reject(new Error('Synthetic retry failure'));await settle(()=>f.el('page').getAttribute('aria-busy')==='false');assert.equal(f.el('content').hidden,false);assert.equal(f.el('action-text').value,'读取失败也保留');assert.equal(f.el('action-feedback').value,'同样保留反馈');assert.equal(f.el('action-text').disabled,false);assert.equal((f.registrations[0].isDirty as ()=>boolean)(),true);assert.equal((f.registrations[1].isDirty as ()=>boolean)(),true);
 f.click('previous');assert.equal(f.confirmations.length,1,'the original draft must still participate in leave protection after a read failure');
});

test('Back keeps the original week URL until the user resolves an unsaved action',async()=>{
 const f=fixture({withGuards:true});await settle(()=>f.el('page').getAttribute('aria-busy')==='false');f.input('action-text','还在写');f.setUrl('/health/review?week=2026-11-02');f.window.dispatchEvent(new f.window.Event('popstate'));
 assert.equal(f.location.search,'?week=2026-11-09');assert.match(f.el('range').textContent??'',/2026-11-09/);assert.equal(f.requests.length,1);assert.equal(f.confirmations.length,1);
 f.confirmations[0]();await settle(()=>f.requests.length===2&&f.el('page').getAttribute('aria-busy')==='false');assert.equal(f.location.search,'?week=2026-11-02');assert.match(f.el('range').textContent??'',/2026-11-02/);
});

test('an HTTP 200 with unavailable actions cannot reset preserved action and feedback draft baselines',async()=>{
 const f=fixture({withGuards:true});await settle(()=>f.el('page').getAttribute('aria-busy')==='false');f.input('action-text','补充服务失败也保留行动');f.input('action-feedback','补充服务失败也保留反馈');f.setFailure(true);f.submit('action-form');await settle(()=>f.el('reload-actions').hidden===false);
 f.deferRead(async()=>{const data=review('2026-11-09',{current:null,next:null});data.supplementalStatus.actions='unavailable';return Response.json(data);});f.click('reload-actions');await settle(()=>f.requests.filter(request=>request.method==='GET').length===2&&f.el('page').getAttribute('aria-busy')==='false');
 assert.equal(f.el('content').hidden,false);assert.equal(f.el('action-form').hidden,false);assert.equal(f.el('feedback-form').hidden,false);assert.equal(f.el('action-text').value,'补充服务失败也保留行动');assert.equal(f.el('action-feedback').value,'补充服务失败也保留反馈');assert.equal(f.el('action-text').disabled,false);assert.match(f.el('status-text').textContent??'',/行动暂时无法读取，原填写已保留/);assert.equal(f.el('reload-actions').hidden,false);assert.equal((f.registrations[0].isDirty as ()=>boolean)(),true);assert.equal((f.registrations[1].isDirty as ()=>boolean)(),true);
 f.click('previous');assert.equal(f.confirmations.length,1,'partial supplemental failure must retain the original leave guard');
});


test('focus text is escaped, detail links stay on allowed health routes and unavailable actions remain read-only',async()=>{
 const focus={headline:'<img src=x onerror=bad()>',summary:'<script>bad()</script>',coverageNote:'来源与覆盖',primary:{id:'weight-change',kind:'data',metric:'weight',title:'变化',evidence:'<img src=x>',interpretation:'<b>资料</b>',href:'javascript:alert(1)',linkLabel:'恶意链接'},secondary:[{id:'steady-records',kind:'data',metric:'coverage',title:'保持观察',evidence:'可比较',interpretation:'不构成诊断',href:'//outside.example/health',linkLabel:'外部'}],suggestedAction:{text:'保留行动',label:'采用'}};
 const f=fixture({focus,actionsUnavailable:true});await settle(()=>f.el('page').getAttribute('aria-busy')==='false');assert.match(f.el('focus-headline').textContent??'',/<img/);assert.equal(f.el('focus-primary').querySelector('img'),null);assert.equal(f.el('focus-primary').querySelector('b'),null);assert.equal(f.el('focus-primary').querySelector('a'),null);assert.equal(f.el('focus-secondary').querySelector('a'),null);assert.match(f.el('focus-primary').textContent??'',/记录变化/);assert.match(f.el('focus-secondary').textContent??'',/保持观察/);assert.equal(f.el('focus-use-action').disabled,true);assert.equal(f.el('action-form').hidden,true);assert.equal(f.requests.every(request=>request.method==='GET'),true);
});
