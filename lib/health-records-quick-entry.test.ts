import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderHealthRecordsPage } from '../health-records-page.ts';
import { renderHealthRecordsScript } from './health-records-ui.ts';
import { METRIC_INFO } from './health.ts';

const DAY='2026-11-12', NOW=Date.parse(DAY+'T00:15:20Z');
async function fixture(search:string,pending?:object){
  const {window,document}=parseHTML(renderHealthRecordsPage('test-owner'));
  for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'value',{configurable:true,writable:true,value:select.querySelector('option')?.getAttribute('value')??''});
  for(const form of document.querySelectorAll('form'))Object.assign(form,{reset(){for(const field of form.querySelectorAll('input,select,textarea'))(field as unknown as HTMLInputElement).value=field.tagName==='SELECT'?field.querySelector('option')?.getAttribute('value')??'':'';}});
  for(const dialog of document.querySelectorAll('dialog')){Object.defineProperty(dialog,'open',{get(){return dialog.hasAttribute('open');}});Object.assign(dialog,{showModal(){dialog.setAttribute('open','');},close(){dialog.removeAttribute('open');dialog.dispatchEvent(new window.Event('close'));}});}
  class FixedDate extends Date{constructor(value?:string|number){super(value===undefined?NOW:value);}static now(){return NOW;}}
  const values=new Map<string,string>();if(pending)values.set('jiashu-health-record-operation:test-owner',JSON.stringify(pending));
  const sessionStorage={getItem(key:string){return values.get(key)??null;},setItem(key:string,value:string){values.set(key,value);},removeItem(key:string){values.delete(key);}};
  const location={pathname:'/health/records',search,origin:'https://health-fixture.example'};
  const history={state:null,replaceState(_data:unknown,_unused:string,path:string){const url=new URL(path,location.origin);location.search=url.search;}};
  const requests:Array<{url:string;method:string}>=[];
  const fetch=async(url:string,options?:RequestInit)=>{requests.push({url,method:options?.method??'GET'});return Response.json({records:[],today:DAY,hasMore:false,nextCursor:null});};
  const source=renderHealthRecordsScript('test-owner',METRIC_INFO).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'');
  runInNewContext(source,{window,document,location,history,sessionStorage,fetch,URL,URLSearchParams,Intl,Date:FixedDate,Headers,AbortController,crypto:webcrypto,queueMicrotask,setTimeout,clearTimeout});
  for(let count=0;count<40&&document.getElementById('records-page')?.getAttribute('aria-busy')!=='false';count++)await new Promise<void>((resolve)=>setImmediate(resolve));
  await new Promise<void>((resolve)=>setImmediate(resolve));
  const el=(id:string)=>document.getElementById('records-'+id)! as unknown as HTMLInputElement;
  return{el,requests,values};
}

test('home quick-weight entry opens an unsaved kg record with Shanghai date and time',async()=>{
  const f=await fixture('?metric=weight&compose=1');
  assert.equal(f.el('dialog').hasAttribute('open'),true);
  assert.equal(f.el('form-metric').value,'weight');assert.equal(f.el('day').value,DAY);assert.equal(f.el('date-time').value,'08:15:20');
  assert.match(f.el('unit').textContent??'',/kg/);assert.equal(f.el('value').value,'');
  assert.ok(f.requests.every((request)=>request.method==='GET'));assert.equal(f.values.size,0);
});

test('ordinary record browsing never opens the entry dialog automatically',async()=>{
  const f=await fixture('?metric=weight');assert.equal(f.el('dialog').hasAttribute('open'),false);assert.ok(f.requests.every((request)=>request.method==='GET'));
});

test('quick entry resumes the exact original pending health operation instead of starting another record',async()=>{
  const pending={kind:'create',key:'11111111-1111-4111-8111-111111111111',body:{metric:'weight',value:72.5,date:DAY,time:'07:00:00',capturedAt:new Date(NOW).toISOString(),reason:'测试原请求'}};
  const f=await fixture('?metric=weight&compose=1',pending);
  assert.equal(f.el('dialog').hasAttribute('open'),true);assert.equal(f.el('value').value,'72.5');assert.equal(f.el('date-time').value,'07:00:00');
  assert.equal(f.values.get('jiashu-health-record-operation:test-owner'),JSON.stringify(pending));assert.ok(f.requests.every((request)=>request.method==='GET'));
});
