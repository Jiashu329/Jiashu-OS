import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderFinanceActivityPage } from '../finance-activity-page.ts';
import { FINANCE_ACTIVITY_CONTENT, renderFinanceActivityScript } from './finance-activity-ui.ts';

const book='11111111-1111-4111-8111-111111111111';
async function settle(check:()=>boolean){for(let n=0;n<40;n++){if(check())return;await new Promise<void>(resolve=>setImmediate(resolve));}assert.ok(check());}
function fixture(options:{blocked?:boolean;response?:(url:URL)=>Promise<Response>}={}){
 const {window,document}=parseHTML('<html><body><button id="finance-activity-refresh">刷新</button>'+FINANCE_ACTIVITY_CONTENT+'</body></html>');
 let current=new URL('/finance/activity?ledger=family&book='+book+'&bookRevision=3','https://synthetic.example');
 const location={get href(){return current.href;},get search(){return current.search;}};
 const history={replaceState(_value:unknown,_unused:string,value:string){current=new URL(value,current);}};
 const requests:Array<{url:URL;method:string}>=[];
 const session={document,changed:false,async request(path:string,init:RequestInit){const url=new URL(path,current);requests.push({url,method:init.method??'GET'});return options.response?options.response(url):Response.json({items:[{id:'finance:one',actorName:'<img onerror="bad()">',summary:'更新了账户资料',targetName:'共同账户',createdAt:'2026-11-13T00:00:00Z'}],hasMore:requests.length===1});}};
 Object.assign(window,{JiashuAccountSession:session,JiashuFinanceBooks:{document,ready:async()=>{},blocked:options.blocked??false,current:{id:book,accessRevision:3,role:'viewer',canWrite:false}}});
 const source=renderFinanceActivityScript().replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'');
 runInNewContext(source,{window,document,location,history,URL,URLSearchParams,Date,Intl});
 const el=(id:string)=>document.getElementById('finance-activity-'+id)! as HTMLElement&{disabled:boolean};
 return{window,document,requests,session,el,ready:()=>settle(()=>el('list').getAttribute('aria-busy')==='false'),click(id:string){el(id).dispatchEvent(new window.Event('click',{bubbles:true}));}};
}

test('activity renders actor, resource and Shanghai time as escaped read-only content and pages with the selected access revision',async()=>{
 const f=fixture();await f.ready();
 assert.equal(f.requests[0].url.pathname,'/api/finance/books/'+book+'/activity');assert.equal(f.requests[0].url.searchParams.get('bookRevision'),'3');
 assert.ok(f.el('list').textContent?.includes('<img onerror="bad()">'));assert.equal(f.el('list').querySelector('img'),null);
 assert.match(f.el('list').textContent??'',/08:00/);assert.equal(f.el('next').disabled,false);
 f.click('next');await f.ready();assert.equal(f.requests.at(-1)?.url.searchParams.get('offset'),'30');assert.equal(f.el('previous').disabled,false);assert.equal(f.el('next').disabled,true);
 f.click('previous');await f.ready();assert.equal(f.requests.at(-1)?.url.searchParams.get('offset'),'0');assert.ok(f.requests.every(row=>row.method==='GET'));
});

test('blocked or changed account cannot display activity or launch automatic mutations',async()=>{
 const blocked=fixture({blocked:true});await blocked.ready();assert.equal(blocked.requests.length,0);assert.match(blocked.el('status').textContent??'',/访问已变化/);
 let finish!:(response:Response)=>void;const f=fixture({response:()=>new Promise(resolve=>{finish=resolve;})});await settle(()=>f.requests.length===1);
 f.session.changed=true;f.document.dispatchEvent(new f.window.Event('jiashu-account-changed'));
 finish(Response.json({items:[{actorName:'PRIVATE_LATE_RESPONSE',summary:'not visible'}],hasMore:false}));await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(f.el('list').children.length,0);assert.ok(!f.document.body.textContent?.includes('PRIVATE_LATE_RESPONSE'));
});


test('the complete activity page keeps its main region and pagination identifiers distinct',()=>{
 const {document}=parseHTML(renderFinanceActivityPage('synthetic-owner'));
 const ids=[...document.querySelectorAll('[id]')].map(element=>element.id);
 assert.equal(new Set(ids).size,ids.length);
 assert.equal(document.getElementById('finance-activity-page')?.tagName,'MAIN');
 assert.equal(document.getElementById('finance-activity-page-number')?.tagName,'SPAN');
 assert.ok(document.getElementById('finance-activity-list'));
});
