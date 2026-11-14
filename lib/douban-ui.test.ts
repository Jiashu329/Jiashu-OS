import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderDoubanPage } from '../douban-page.ts';
import { renderDoubanScript } from './douban-ui.ts';

const RUN_ID='11111111-1111-4111-8111-111111111111';
const STAMP='2026-11-14T08:00:00Z';
const record={profileId:'mine',domain:'screen',subjectId:'12345',title:'一条合成电影记录',url:'https://movie.douban.com/subject/12345/',kind:'movie',coverUrl:null,rating:4,markedDate:'2026-11-10',comment:'合成个人短评',publishedAt:null,source:'collection',observedAt:STAMP,createdAt:STAMP,updatedAt:STAMP};
const initialConnection={profileId:'mine' as string|null,profileUrl:'https://www.douban.com/people/mine/' as string|null,revision:1,updatedAt:STAMP as string|null};
function run(status='running',revision=0){return{id:RUN_ID,profileId:'mine',connectionRevision:1,revision,status,sources:{screen:{status:'complete',pages:1,received:1,total:1},book:{status:'blocked',pages:0,received:0,total:null},music:{status:'complete',pages:1,received:0,total:0}},rss:{status:'complete',received:1},classification:{checked:0,unclassified:1,blocked:true},added:1,updated:0,unchanged:0,message:'公开书籍受限，近期 RSS 仅作补充。',createdAt:STAMP,updatedAt:STAMP,finishedAt:status==='running'?null:STAMP};}
async function settle(check:()=>boolean){for(let count=0;count<200;count++){if(check())return;await new Promise<void>(resolve=>setTimeout(resolve,1));}assert.ok(check());}
function fixture(options:{connected?:boolean;items?:Array<Record<string,unknown>>;lastRun?:Record<string,unknown>|null}={}){
 const {window,document}=parseHTML(renderDoubanPage());
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.getAttribute('value')??this.querySelector('option')?.getAttribute('value')??'';},set(value:string){for(const option of this.querySelectorAll('option'))if(option.getAttribute('value')===String(value))option.setAttribute('selected','');else option.removeAttribute('selected');}});
 const dialog=document.getElementById('douban-detail-dialog')!;Object.assign(dialog,{showModal(){dialog.setAttribute('open','');},close(){dialog.removeAttribute('open');dialog.dispatchEvent(new window.Event('close'));}});
 let url=new URL('https://synthetic-douban.example/life/douban'),connection=options.connected===false?{profileId:null,profileUrl:null,revision:0,updatedAt:null}:structuredClone(initialConnection);
 let items=options.items??[structuredClone(record)],lastRun=options.lastRun??null,failRead=false,conflict=false,verify:()=>Promise<unknown>=async()=>{};
 let syncHandler:((body:Record<string,unknown>,index:number)=>Promise<Response>)|null=null,posts=0;
 let importHandler:((body:Record<string,unknown>)=>Promise<Response>)|null=null;
 let selectedFiles:Array<{name:string;size:number;lastModified:number;text:()=>Promise<string>;arrayBuffer:()=>Promise<ArrayBuffer>}>=[];
 let selectedValue='';
 const fileInput=document.getElementById('douban-import-files')!;
 Object.defineProperties(fileInput,{files:{configurable:true,get(){return selectedFiles;}},value:{configurable:true,get(){return selectedValue;},set(value:string){selectedValue=String(value);if(!value)selectedFiles=[];}}});
 const imported=Object.fromEntries(['domain','subjectId','title','url','kind','coverUrl','rating','markedDate','comment','publishedAt'].map(key=>[key,(record as Record<string,unknown>)[key]]));
 imported.source='import';
 const requests:Array<{path:string;method:string;body:Record<string,unknown>|null}>=[],registrations:Record<string,unknown>[]=[],confirmations:Array<()=>void>=[];
 const session={changed:false,verify:()=>verify(),request:async(input:string,init:RequestInit={})=>{
  const parsed=new URL(input,url),method=init.method??'GET',body=init.body?JSON.parse(String(init.body)):null;requests.push({path:parsed.pathname+parsed.search,method,body});
  if(parsed.pathname==='/api/life/douban'){if(failRead)throw new Error('Synthetic read failed');let found=items;if(parsed.searchParams.get('profile')==='current')found=found.filter(item=>connection.profileId&&item.profileId===connection.profileId);if(parsed.searchParams.get('kind'))found=found.filter(item=>item.kind===parsed.searchParams.get('kind'));if(parsed.searchParams.get('q'))found=found.filter(item=>String(item.title).includes(parsed.searchParams.get('q')!));const offset=Number(parsed.searchParams.get('offset')||0),limit=Number(parsed.searchParams.get('limit')||24);return Response.json({connection,items:found.slice(offset,offset+limit),total:found.length,counts:{all:items.length,movie:items.filter(item=>item.kind==='movie').length,series:0,book:0,music:0,screen:0},offset,limit,hasMore:offset+limit<found.length,lastRun});}
  if(parsed.pathname==='/api/life/douban/connection'){
   if(conflict||body.expectedRevision!==connection.revision)return Response.json({error:'连接已在其他页面更新。',code:'DOUBAN_CONNECTION_CONFLICT'},{status:409});
   const id=body.profile===null?null:String(body.profile).replace(/^https:\/\/(?:www\.)?douban\.com\/people\//,'').replace(/\/$/,'');connection={profileId:id,profileUrl:id?'https://www.douban.com/people/'+id+'/':null,revision:connection.revision+1,updatedAt:STAMP};lastRun=null;return Response.json({connection});
  }
  if(parsed.pathname==='/api/life/douban/sync'){
   const index=posts++;if(syncHandler)return syncHandler(body,index);lastRun=run(index===0?'running':'partial',index);return Response.json({run:lastRun,connection,more:index===0});
  }
  if(parsed.pathname==='/api/life/douban/import'){
   if(importHandler)return importHandler(body);
   const entries=body.items as Array<Record<string,unknown>>;
   if(body.action==='preview')return Response.json({preview:{profileId:body.profile,profileUrl:'https://www.douban.com/people/'+body.profile+'/',snapshotHash:'a'.repeat(64),total:entries.length,added:entries.length,updated:0,unchanged:0}});
   items=entries.map(item=>({...record,...item,profileId:body.profile}));
   return Response.json({receipt:{profileId:body.profile,requestId:body.requestId,total:entries.length,added:entries.length,updated:0,unchanged:0}});
  }
  throw new Error('Unexpected request '+input);
 }};
 const localParserCalls:unknown[]=[];
 Object.assign(window,{JiashuAccountSession:session,JiashuDoubanImport:{parse(files:unknown,settings:unknown){localParserCalls.push({files,settings});return{items:[structuredClone(imported)],warnings:[],skipped:0,duplicates:0,sourceFiles:1};}},JiashuDraftGuards:{register(value:Record<string,unknown>){registrations.push(value);return{reset(){},saved(){},failed(){},confirm(action:()=>void){if((value.isDirty as ()=>boolean)())confirmations.push(()=>{(value.onDiscard as ()=>void)();action();});else action();}};}}});
 const location={get origin(){return url.origin;},get pathname(){return url.pathname;},get search(){return url.search;},get href(){return url.href;}},history={replaceState(_a:unknown,_b:string,path:string){url=new URL(path,url);},pushState(_a:unknown,_b:string,path:string){url=new URL(path,url);}};
 const source=renderDoubanScript().replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'');
 runInNewContext(source,{window,document,location,history,URL,URLSearchParams,Intl,Date,Headers,AbortController,TextEncoder,TextDecoder,crypto:webcrypto,Event:window.Event,queueMicrotask,setTimeout:(callback:()=>void,delay:number)=>setTimeout(callback,delay===1500?0:delay),clearTimeout,fetch:()=>{throw new Error('All requests must use the pinned session transport');}});
 const el=(id:string)=>document.getElementById('douban-'+id)! as HTMLElement&{value:string;disabled:boolean;hidden:boolean};
 return{window,document,el,requests,registrations,confirmations,session,localParserCalls,connection:()=>connection,setConnection(value:typeof connection){connection=value;},setRun(value:Record<string,unknown>|null){lastRun=value;},setReadFailure(value:boolean){failRead=value;},setConflict(value:boolean){conflict=value;},setSyncHandler(value:typeof syncHandler){syncHandler=value;},setImportHandler(value:typeof importHandler){importHandler=value;},setInvalidFiles(){selectedFiles=[{name:'bad.csv',size:2,lastModified:0,text:async()=>'\ufffd(',arrayBuffer:async()=>new Uint8Array([0xc3,0x28]).buffer}];selectedValue='fakepath';fileInput.dispatchEvent(new window.Event('change',{bubbles:true}));},setFiles(){selectedFiles=[{name:'private-export.json',size:100,lastModified:0,text:async()=>'PRIVATE-RAW-FILE-CONTENT',arrayBuffer:async()=>new TextEncoder().encode('PRIVATE-RAW-FILE-CONTENT').buffer as ArrayBuffer}];selectedValue='fakepath';fileInput.dispatchEvent(new window.Event('change',{bubbles:true}));},completeImport(){el('import-profile').value='private_owner';selectedFiles=[{name:'private-export.json',size:100,lastModified:0,text:async()=>'PRIVATE-RAW-FILE-CONTENT',arrayBuffer:async()=>new TextEncoder().encode('PRIVATE-RAW-FILE-CONTENT').buffer as ArrayBuffer}];selectedValue='fakepath';(el('import-completed') as unknown as HTMLInputElement).checked=true;fileInput.dispatchEvent(new window.Event('change',{bubbles:true}));},setVerify(value:typeof verify){verify=value;},input(id:string,value:string){el(id).value=value;el(id).dispatchEvent(new window.Event('input',{bubbles:true}));},change(id:string,value:string){el(id).value=value;el(id).dispatchEvent(new window.Event('change',{bubbles:true}));},click(id:string){el(id).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));},submit(id:string){el(id).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));},finishRun(value:Record<string,unknown>){lastRun=value;return Response.json({run:value,connection,more:value.status==='running'});}};
}

test('opening the personal library only reads local records and exposes unique, accessible controls',async()=>{
 const f=fixture({connected:false,items:[]});await settle(()=>f.el('page').getAttribute('aria-busy')==='false');assert.ok(f.requests.every(request=>request.method==='GET'));assert.equal(f.el('sync').disabled,true);assert.equal(f.el('profile-settings').hasAttribute('open'),true);assert.equal(f.registrations[0].durable,false);
 const ids=[...f.document.querySelectorAll('[id]')].map(node=>node.id);assert.equal(new Set(ids).size,ids.length);assert.equal(f.document.querySelectorAll('[data-navigation-page]').length,5);assert.ok(f.document.querySelector('a[href="/life/douban"].sidebar-life'));assert.match(f.document.body.textContent??'',/不接收豆瓣密码或 Cookie/);
});

test('saving a profile and disconnecting are explicit configuration writes and never start synchronization',async()=>{
 const f=fixture({connected:false,items:[record]});await settle(()=>!f.el('save').disabled);f.input('profile','mine');assert.equal(f.el('sync').disabled,true);f.submit('profile-form');await settle(()=>f.el('profile-status').textContent?.includes('连接已保存')===true&&f.requests.filter(request=>request.method==='PUT').length===1);
 assert.equal(f.requests.some(request=>request.path==='/api/life/douban/sync'),false);assert.deepEqual(f.requests.find(request=>request.method==='PUT')?.body,{profile:'mine',expectedRevision:0});assert.equal(f.el('profile').value,'https://www.douban.com/people/mine/');
 f.click('disconnect');await settle(()=>f.connection().profileId===null&&!f.el('disconnect').disabled===false);assert.equal(f.requests.filter(request=>request.method==='PUT').length,2);assert.equal(f.el('list').children.length,1,'disconnect retains previously saved source records');assert.equal(f.requests.some(request=>request.path==='/api/life/douban/sync'),false);
});

test('only explicit sync clicks start and advance a bounded run, and partial RSS results stay honestly labelled',async()=>{
 const f=fixture();await settle(()=>!f.el('sync').disabled);f.click('sync');await settle(()=>f.requests.filter(request=>request.path==='/api/life/douban/sync').length===2&&!f.el('sync').disabled);
 const writes=f.requests.filter(request=>request.path==='/api/life/douban/sync');assert.deepEqual(writes[0].body,{expectedConnectionRevision:1});assert.deepEqual(writes[1].body,{expectedConnectionRevision:1,runId:RUN_ID,expectedRunRevision:0});assert.equal(f.el('sync-status').textContent,'部分同步完成');assert.match(f.el('sources').textContent??'',/访问受限/);assert.match(f.el('sources').textContent??'',/不代表历史全量/);assert.match(f.el('sources').textContent??'',/1 条暂无法核实/);
});

test('pause waits for the active step and a later page read never resumes outside an explicit click',async()=>{
 const f=fixture({lastRun:run()});await settle(()=>!f.el('sync').disabled);let finish!:(value:Response)=>void;f.setSyncHandler(()=>new Promise(resolve=>{finish=resolve;}));f.click('sync');await settle(()=>Boolean(finish));f.click('stop');assert.equal(f.el('stop').disabled,true);finish(f.finishRun(run('running',1)));await settle(()=>!f.el('sync').disabled);assert.equal(f.requests.filter(request=>request.path==='/api/life/douban/sync').length,1);assert.match(f.el('sync-status').textContent??'',/已暂停/);f.click('search');await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.requests.filter(request=>request.path==='/api/life/douban/sync').length,1);
});

test('configuration conflicts keep the original draft revision and require a deliberate re-read',async()=>{
 const f=fixture();await settle(()=>!f.el('sync').disabled);f.input('profile','a-new-profile');f.setConnection({...initialConnection,profileId:'other',profileUrl:'https://www.douban.com/people/other/',revision:2});f.change('kind','book');await settle(()=>f.el('save').disabled);assert.equal(f.el('profile').value,'a-new-profile');assert.match(f.el('profile-status').textContent??'',/填写已保留/);f.submit('profile-form');assert.equal(f.requests.filter(request=>request.method==='PUT').length,0);
 f.click('reload-profile');assert.equal(f.confirmations.length,1);assert.equal(f.el('profile').value,'a-new-profile');f.confirmations[0]();await settle(()=>f.el('profile').value==='https://www.douban.com/people/other/'&&!f.el('save').disabled);assert.equal(f.requests.some(request=>request.path==='/api/life/douban/sync'),false);
});

test('search, category, source scope and pagination remain read-only and reset the page on filter changes',async()=>{
 const f=fixture({items:Array.from({length:25},(_,index)=>({...record,subjectId:String(12345+index),title:'合成电影'+index,profileId:index===24?'older':'mine'}))});await settle(()=>!f.el('next').disabled);f.click('next');await settle(()=>f.el('list').children.length===1);assert.match(f.requests.at(-1)?.path??'',/offset=24/);f.change('scope','current');await settle(()=>f.el('list').children.length===24);assert.match(f.requests.at(-1)?.path??'',/offset=0.*profile=current/);f.input('query','合成电影1');f.submit('search-form');await settle(()=>!f.el('page').getAttribute('aria-busy')||f.el('page').getAttribute('aria-busy')==='false');assert.ok(f.requests.every(request=>request.method==='GET'));
});

test('record names and comments render as text, foreign cover links are ignored, and RSS time stays distinct from marking dates',async()=>{
 const f=fixture({items:[{...record,title:'<img src=x onerror=bad()>',comment:'<script>bad()</script>',coverUrl:'https://evil.example/steal.png',url:'https://evil.example/subject/12345/',source:'rss',markedDate:null,publishedAt:STAMP}]});await settle(()=>f.el('list').children.length===1);assert.equal(f.el('list').querySelector('img'),null);assert.match(f.el('list').textContent??'',/<img src=x onerror=bad\(\)>/);assert.equal(f.el('list').querySelector('script'),null);
 f.el('list').querySelector('[data-douban-open]')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));assert.equal(f.el('detail-dialog').hasAttribute('open'),true);assert.match(f.el('detail-body').textContent??'',/豆瓣标记日期未提供/);assert.match(f.el('detail-body').textContent??'',/豆瓣动态时间/);assert.equal(f.el('detail-body').querySelector('a')?.getAttribute('href'),'https://movie.douban.com/subject/12345/');assert.equal(f.el('detail-body').querySelector('script'),null);assert.equal(f.requests.filter(request=>request.method!=='GET').length,0);
});

test('failed reads retain profile drafts and saved cards while exposing a retry, and account changes freeze mutations',async()=>{
 const f=fixture();await settle(()=>!f.el('sync').disabled);f.input('profile','draft-profile');f.setReadFailure(true);f.submit('search-form');await settle(()=>f.el('retry').hidden===false);assert.equal(f.el('profile').value,'draft-profile');assert.equal(f.el('list').children.length,1);assert.equal((f.registrations[0].isDirty as ()=>boolean)(),true);
 f.session.changed=true;f.document.dispatchEvent(new f.window.Event('jiashu-account-changed'));assert.equal(f.el('save').disabled,true);assert.equal(f.el('sync').disabled,true);f.submit('profile-form');f.click('sync');assert.equal(f.requests.filter(request=>request.method!=='GET').length,0);assert.equal(f.el('profile').value,'draft-profile');
});

test('rate limits stop without automatic retries and keep the resumable run visible',async()=>{
 const f=fixture({lastRun:run()});await settle(()=>!f.el('sync').disabled);f.setSyncHandler(async()=>Response.json({error:'同步频率较快。',code:'DOUBAN_SYNC_RATE_LIMITED'},{status:429,headers:{'Retry-After':'2'}}));f.click('sync');await settle(()=>f.el('sync-status').textContent?.includes('2 秒')===true);assert.equal(f.requests.filter(request=>request.path==='/api/life/douban/sync').length,1);assert.equal(f.el('sync').textContent,'继续同步公开记录');assert.equal(f.el('run-summary').hidden,false);
});

test('private files parse locally, preview without writes, and import only after explicit confirmation to the chosen profile',async()=>{
 const f=fixture({connected:false,items:[]});await settle(()=>f.el('page').getAttribute('aria-busy')==='false');f.completeImport();f.submit('import-form');await settle(()=>!f.el('import-confirm').disabled);
 const preview=f.requests.filter(request=>request.path==='/api/life/douban/import');assert.equal(preview.length,1);assert.equal(preview[0].body?.action,'preview');assert.equal(preview[0].body?.profile,'private_owner');assert.equal(f.localParserCalls.length,1);assert.equal(JSON.stringify(preview).includes('PRIVATE-RAW-FILE-CONTENT'),false);assert.equal(JSON.stringify(preview).includes('private-export.json'),false);assert.equal(f.requests.some(request=>request.path==='/api/life/douban/sync'||request.method==='PUT'),false);assert.equal((f.registrations[1].isDirty as ()=>boolean)(),true);
 f.click('import-confirm');await settle(()=>f.el('import-status').textContent?.includes('导入已保存')===true);assert.equal(f.requests.filter(request=>request.body?.action==='commit').length,1);assert.equal(f.connection().profileId,null);assert.equal(f.el('list').children.length,1);assert.equal((f.registrations[1].isDirty as ()=>boolean)(),false);assert.ok(f.registrations.every(value=>value.durable===false));
});

test('changing private import destination invalidates its preview and does not silently use a changed public connection',async()=>{
 const f=fixture();await settle(()=>f.el('page').getAttribute('aria-busy')==='false');f.completeImport();f.submit('import-form');await settle(()=>!f.el('import-confirm').disabled);f.input('import-profile','another_owner');assert.equal(f.el('import-confirm').disabled,true);assert.equal(f.el('import-result').hidden,true);f.click('import-confirm');assert.equal(f.requests.filter(request=>request.body?.action==='commit').length,0);
 f.completeImport();f.submit('import-form');await settle(()=>!f.el('import-confirm').disabled);f.setConnection({...initialConnection,profileId:'changed_binding',profileUrl:'https://www.douban.com/people/changed_binding/',revision:2});f.submit('search-form');await settle(()=>f.el('profile').value.includes('changed_binding'));assert.equal(f.el('import-profile').value,'private_owner');f.click('import-confirm');await settle(()=>f.el('import-status').textContent?.includes('导入已保存')===true);assert.equal(f.requests.find(request=>request.body?.action==='commit')?.body?.profile,'private_owner');
});

test('an unknown private import result retries the immutable original operation and never uploads raw files',async()=>{
 const f=fixture({connected:false,items:[]});await settle(()=>f.el('page').getAttribute('aria-busy')==='false');f.completeImport();f.submit('import-form');await settle(()=>!f.el('import-confirm').disabled);let attempts=0;f.setImportHandler(async body=>{attempts++;if(attempts===1)throw new Error('Synthetic lost response');return Response.json({receipt:{profileId:body.profile,requestId:body.requestId,total:(body.items as unknown[]).length,added:1,updated:0,unchanged:0}});});f.click('import-confirm');await settle(()=>!f.el('import-retry').hidden&&!f.el('import-retry').disabled);assert.equal(f.el('import-profile').disabled,true);assert.equal(f.el('sync').disabled,true);f.click('import-retry');await settle(()=>f.el('import-status').textContent?.includes('导入已保存')===true);const commits=f.requests.filter(request=>request.body?.action==='commit');assert.equal(commits.length,2);assert.deepEqual(commits[0].body,commits[1].body);assert.equal(JSON.stringify(commits).includes('PRIVATE-RAW-FILE-CONTENT'),false);
});

test('private imported covers do not send image requests and account changes block a pending import confirmation',async()=>{
 const f=fixture({items:[{...record,source:'import',coverUrl:'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p123.jpg'}]});await settle(()=>f.el('list').children.length===1);assert.equal(f.el('list').querySelector('img'),null);f.completeImport();f.submit('import-form');await settle(()=>!f.el('import-confirm').disabled);f.session.changed=true;f.document.dispatchEvent(new f.window.Event('jiashu-account-changed'));f.click('import-confirm');assert.equal(f.requests.filter(request=>request.body?.action==='commit').length,0);assert.equal(f.el('import-profile').disabled,true);
});


test('invalid UTF-8 files are rejected locally before parsing or sending a private preview',async()=>{
 const f=fixture({connected:false,items:[]});await settle(()=>f.el('page').getAttribute('aria-busy')==='false');f.completeImport();f.setInvalidFiles();f.submit('import-form');await settle(()=>f.el('import-status').textContent?.includes('另存为 UTF-8')===true);assert.equal(f.localParserCalls.length,0);assert.equal(f.requests.some(request=>request.path==='/api/life/douban/import'),false);assert.equal(f.el('import-confirm').disabled,true);assert.equal(f.el('import-profile').value,'private_owner');assert.equal((f.registrations[1].isDirty as ()=>boolean)(),true);
});
