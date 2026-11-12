import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderDataBackupPage } from '../data-backup-page.ts';
import { renderDataBackupScript } from './data-backup-ui.ts';

async function settled(check:()=>boolean){for(let i=0;i<40;i++){if(check())return;await new Promise<void>((resolve)=>setImmediate(resolve));}assert.ok(check(),'Synthetic backup UI did not settle');}
function fixture(ownerId='',localValues=new Map<string,string>()){const{window,document}=parseHTML(renderDataBackupPage(ownerId));Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:(key:string)=>localValues.get(key)??null,setItem:(key:string,value:string)=>localValues.set(key,value)}});const requests:Array<Record<string,unknown>>=[];let postResponse:()=>Promise<Response>=async()=>Response.json({canRestore:true,previewHash:'a'.repeat(64),total:{incoming:2,added:2,skipped:0,conflicts:0},tables:[{label:'健康记录',incoming:2,added:2,skipped:0,conflicts:0,conflictExamples:[]}]});
  const fetch=async(url:string,options:RequestInit={})=>{requests.push({url,body:options.body?JSON.parse(String(options.body)):null});return postResponse();};
  runInNewContext(renderDataBackupScript(ownerId).replace(/^<script>/,'').replace(/<\/script>$/,''),{window,document,fetch,URL,Blob,TextEncoder,AbortController,setTimeout,clearTimeout});
  const el=(id:string)=>document.getElementById('backup-'+id)! as HTMLElement &{files:unknown[];disabled:boolean;checked:boolean};
  const event=(id:string,name='click')=>el(id).dispatchEvent(new window.Event(name,{bubbles:true}));
  const file=(name:string,text:()=>Promise<string>)=>{Object.defineProperty(el('file'),'files',{value:[{name,size:100,text}],configurable:true});event('file','change');};
  return{el,event,file,requests,localValues,files(values:unknown[]){Object.defineProperty(el('file'),'files',{value:values,configurable:true});event('file','change');},respond(fn:()=>Promise<Response>){postResponse=fn;}};
}
void test('late file reads cannot replace the user latest chosen backup',async()=>{const f=fixture();let release!:(s:string)=>void;f.file('old.json',()=>new Promise<string>((resolve)=>release=resolve));f.file('new.json',async()=>JSON.stringify({file:'latest'}));await settled(()=>!f.el('preview').disabled);release(JSON.stringify({file:'obsolete'}));await new Promise<void>((resolve)=>setImmediate(resolve));f.event('preview');await settled(()=>f.requests.length===1);assert.deepEqual((f.requests[0].body as Record<string,unknown>).backup,{file:'latest'});});
void test('restore requires preview and explicit confirmation, then resets after completion',async()=>{const f=fixture();f.file('backup.json',async()=>JSON.stringify({file:'synthetic'}));await settled(()=>!f.el('preview').disabled);assert.equal(f.el('restore').disabled,true);f.event('preview');await settled(()=>!f.el('summary').hidden);assert.equal(f.el('restore').disabled,true);f.el('confirm').checked=true;f.event('confirm','change');assert.equal(f.el('restore').disabled,false);f.respond(async()=>Response.json({ok:true,added:2,skipped:0}));f.event('restore');await settled(()=>f.el('status').textContent?.includes('恢复完成')===true);assert.equal(f.requests.length,2);assert.equal((f.requests[1].body as Record<string,unknown>).action,'restore');assert.equal(f.el('restore').disabled,true);});
void test('conflicts are text-only and prevent confirmation even with a checked box',async()=>{const f=fixture();f.respond(async()=>Response.json({canRestore:false,previewHash:'a'.repeat(64),total:{incoming:1,added:0,skipped:0,conflicts:1},tables:[{label:'账户',incoming:1,added:0,skipped:0,conflicts:1,conflictExamples:[{record:'<img src=x onerror=alert(1)>',reason:'已有不同内容'}]}]}));f.file('backup.json',async()=>JSON.stringify({file:'synthetic'}));await settled(()=>!f.el('preview').disabled);f.event('preview');await settled(()=>!f.el('summary').hidden);assert.equal(f.el('conflicts').querySelector('img'),null);assert.match(f.el('conflicts').textContent!,/<img/);f.el('confirm').checked=true;f.event('confirm','change');assert.equal(f.el('restore').disabled,true);});
void test('a failed export displays the server error instead of downloading an error JSON',async()=>{const f=fixture();f.respond(async()=>Response.json({error:'超过安全恢复的查询预算',code:'BACKUP_TOO_LARGE'},{status:413}));f.event('export');await settled(()=>f.el('status').textContent?.includes('查询预算')===true);assert.equal(f.el('export').disabled,false);assert.equal(f.requests.length,1);});
void test('a slow file read cannot release a request lock or launch an export',async()=>{
  const f=fixture();let finish!:(text:string)=>void;
  f.file('slow.json',()=>new Promise<string>((resolve)=>finish=resolve));
  assert.equal(f.el('export').disabled,true);f.event('export');assert.equal(f.requests.length,0);
  finish(JSON.stringify({file:'ready'}));await settled(()=>!f.el('preview').disabled);
  let respond!:(value:Response)=>void;f.respond(()=>new Promise<Response>((resolve)=>respond=resolve));f.event('preview');
  f.el('confirm').checked=true;f.event('confirm','change');f.event('export');
  assert.equal(f.el('export').disabled,true);assert.equal(f.requests.length,1);
  respond(Response.json({canRestore:false,total:{incoming:0,added:0,skipped:0,conflicts:0},tables:[]}));await settled(()=>!f.el('export').disabled);
});
void test('recent generation metadata is local and owner-isolated and saving requires a separate confirmation',async()=>{
  const values=new Map<string,string>(),f=fixture('alice',values);
  f.respond(async()=>Response.json({kind:'jiashu-os-backup',version:2,exportedAt:'2026-11-10T04:00:00.000Z',tables:{nutrition_entries:[{name:'PRIVATE_FOOD_NAME'}]}}));
  f.event('export');await settled(()=>f.el('recent').textContent?.includes('1 行')===true);
  assert.match(f.el('recent').textContent!,/无法判断文件是否已保存/);assert.equal(f.el('saved').disabled,false);
  assert.ok(!JSON.stringify([...values.values()]).includes('PRIVATE_FOOD_NAME'));
  f.event('saved');assert.match(f.el('recent').textContent!,/已确认妥善保存/);
  const reopened=fixture('alice',values);assert.match(reopened.el('recent').textContent!,/已确认妥善保存/);assert.equal(reopened.requests.length,0);
  const other=fixture('bob',values);assert.match(other.el('recent').textContent!,/尚无备份生成记录/);assert.equal(other.el('saved').disabled,true);
});
void test('multiple volume files must include one manifest and are sent together for one preview',async()=>{
  const f=fixture();f.files([{size:100,text:async()=>JSON.stringify({kind:'jiashu-os-backup-volume',partIndex:1})},{size:100,text:async()=>JSON.stringify({kind:'jiashu-os-backup-volume',partIndex:2})}]);
  await settled(()=>f.el('status').textContent?.includes('一个清单')===true);assert.equal(f.el('preview').disabled,true);assert.equal(f.requests.length,0);
  f.files([{size:100,text:async()=>JSON.stringify({kind:'jiashu-os-backup-manifest'})},{size:100,text:async()=>JSON.stringify({kind:'jiashu-os-backup-volume',partIndex:1})}]);
  await settled(()=>!f.el('preview').disabled);f.event('preview');await settled(()=>f.requests.length===1);
  const body=f.requests[0].body as {backup:{kind:string;volumes:unknown[]}};assert.equal(body.backup.kind,'jiashu-os-backup-set');assert.equal(body.backup.volumes.length,1);
});
