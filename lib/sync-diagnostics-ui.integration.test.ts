import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderApp } from '../ui.ts';

async function settle(check: () => boolean) { for (let i=0;i<80;i++) { if(check())return; await new Promise<void>((resolve)=>setImmediate(resolve)); } assert.ok(check(),'Sync diagnostics did not settle'); }
const receipt = { attemptId:'synthetic-attempt',createdAt:'2026-11-10T09:00:00.000Z',channel:'device',deviceLabel:'<img src=x onerror=alert(1)>',status:'success',batchId:'a'.repeat(64),errorCode:null,guidance:null,
  summary:{version:1,known:true,received:1,metrics:[{metric:'steps',from:'2026-11-10',to:'2026-11-10',sources:['<script>watch</script>'],sourceCount:1,received:1,added:1,updated:0,unchanged:0,older:0,manualOverrides:0}]}};
const history={batches:[],attempts:[receipt],metricStatus:[{metric:'steps',lastRecordDate:'2026-11-10',lastReceivedAt:receipt.createdAt,lastAttemptAt:receipt.createdAt,lastAttemptStatus:'success',lastErrorCode:null},{metric:'sleep',lastRecordDate:null,lastReceivedAt:null,lastAttemptAt:null,lastAttemptStatus:null,lastErrorCode:null}]};
function fixture(t: TestContext) {
  const { window,document }=parseHTML(renderApp());let href=new URL('https://synthetic-sync.example/sync');let failed=false;
  const location={get origin(){return href.origin;},get pathname(){return href.pathname;},get search(){return href.search;},get hash(){return href.hash;},get href(){return href.href;}};
  const historyState={state:null,replaceState(_s:unknown,_t:string,path:string){href=new URL(path,href);},pushState(_s:unknown,_t:string,path:string){href=new URL(path,href);}};
  for(const dialog of document.querySelectorAll('dialog'))Object.assign(dialog,{showModal(){dialog.setAttribute('open','');},close(){dialog.removeAttribute('open');dialog.dispatchEvent(new window.Event('close'));}});
  const requests:string[]=[];const fetch=async(path:string)=>{requests.push(path);if(path.startsWith('/api/health?'))return Response.json({measurements:[],lastSync:null});if(path==='/api/health/import')return failed?Response.json({error:'同步结果暂时不可读',code:'HEALTH_STORAGE_UNAVAILABLE'},{status:503}):Response.json(history);throw new Error('Unexpected '+path);};
  const timers=new Set<ReturnType<typeof setTimeout>>();t.after(()=>timers.forEach(clearTimeout));
  const script=[...document.querySelectorAll('script')].at(-1)!.textContent!;
  runInNewContext(script,{window,document,location,history:historyState,navigator:{},fetch,URL,URLSearchParams,TextEncoder,AbortController,crypto:webcrypto,Intl,Date,Event:window.Event,
    setTimeout(callback:()=>void,ms:number){const timer=setTimeout(callback,ms);timers.add(timer);return timer;},clearTimeout,requestAnimationFrame(callback:()=>void){callback();return 0;}});
  return {document,requests,fail(value:boolean){failed=value;},refresh(){document.getElementById('refresh-sync-diagnostics')!.dispatchEvent(new window.Event('click',{bubbles:true}));}};
}

test('sync page automatically reloads durable per-metric receipts without presenting steps as a sleep update',async(t)=>{
  const first=fixture(t);await settle(()=>!!first.document.querySelector('[data-sync-attempt]'));
  assert.ok(first.requests.includes('/api/health/import'));
  assert.match(first.document.querySelector('[data-sync-metric="steps"]')!.textContent,/2026-11-10/);
  const sleep=first.document.querySelector('[data-sync-metric="sleep"]')!.textContent!;assert.match(sleep,/暂无记录/);assert.match(sleep,/没有该指标回执/);assert.doesNotMatch(sleep,/已更新/);
  const panel=first.document.getElementById('sync-attempts')!;assert.equal(panel.querySelector('img'),null);assert.equal(panel.querySelector('script'),null);assert.match(panel.textContent!,/新增 1，更新 0/);assert.match(panel.textContent!,/未列出的其他指标没有更新/);
  const refreshed=fixture(t);await settle(()=>!!refreshed.document.querySelector('[data-sync-attempt]'));
  assert.equal(refreshed.document.querySelector('[data-sync-attempt]')!.getAttribute('data-sync-attempt'),'synthetic-attempt');
});

test('receipt loading failure offers a bounded retry while keeping the last displayed scope distinct',async(t)=>{
  const f=fixture(t);await settle(()=>!!f.document.querySelector('[data-sync-attempt]'));f.fail(true);f.refresh();
  await settle(()=>!f.document.getElementById('sync-diagnostics-error')!.hidden);
  assert.match(f.document.getElementById('sync-diagnostics-error')!.textContent!,/刷新结果重试/);
  assert.equal((f.document.getElementById('refresh-sync-diagnostics') as HTMLButtonElement).disabled,false);
  f.fail(false);f.refresh();await settle(()=>f.document.getElementById('sync-diagnostics-error')!.hidden);
  assert.ok(f.document.querySelector('[data-sync-attempt]'));
});
