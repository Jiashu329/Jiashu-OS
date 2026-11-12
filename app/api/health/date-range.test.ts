import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import test from 'node:test';
import * as dates from '../../../lib/date-range.ts';
type Handler=(request:Request)=>Promise<Response>;
function fixture(){
  let owner:string|null='alice';const reads:Array<{owner:string;from:string;to:string}>=[];
  const bindings={...dates,apiUser:async()=>owner?{userId:owner}:null,
    json:(body:unknown,status=200,headers:Record<string,string>={})=>Response.json(body,{status,headers}),
    unauthenticated:()=>Response.json({error:'login'},{status:401}),unavailable:()=>Response.json({error:'unavailable'},{status:503}),
    readWithDeadline:<T>(value:Promise<T>)=>value,
    readHealthRange:async(user:string,from:string,to:string)=>{reads.push({owner:user,from,to});return{measurements:[],summary:{},lastSync:null};},
    exportHealth:async(user:string,range:dates.DateRange)=>{reads.push({owner:user,from:range.from,to:range.to});return{version:1,measurements:[]};}};
  function load(path:URL){const source=stripTypeScriptTypes(readFileSync(path,'utf8'),{mode:'strip'}).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');return new Function(...Object.keys(bindings),source+'\nreturn GET;')(...Object.values(bindings)) as Handler;}
  const view=load(new URL('./route.ts',import.meta.url)),download=load(new URL('./export/route.ts',import.meta.url));
  return{reads,view,download,logout(){owner=null;}};
}
test('health view and export resolve the same inclusive owner-scoped custom dates and name the downloaded range',async()=>{
  const f=fixture(),url='https://range.example/api/health?from=2024-02-28&to=2024-03-01';
  const view=await f.view(new Request(url)),download=await f.download(new Request(url.replace('/health?','/health/export?')));
  assert.equal(view.status,200);assert.equal(download.status,200);
  assert.deepEqual(f.reads,[{owner:'alice',from:'2024-02-28',to:'2024-03-01'},{owner:'alice',from:'2024-02-28',to:'2024-03-01'}]);
  assert.equal(((await view.json()) as {range:dates.DateRange}).range.days,3);
  assert.equal(download.headers.get('X-Export-Range-Days'),'3');assert.equal(download.headers.get('X-Export-Range-To'),'2024-03-01');
  assert.match(download.headers.get('Content-Disposition')!,/2024-02-28_2024-03-01/);
});
test('invalid ranges and unauthenticated reads never reach health storage or export',async()=>{
  const f=fixture();
  for(const suffix of ['from=2024-02-30&to=2024-03-01','from=2024-02-28','from=2024-01-01&to=2025-01-01','days=7&from=2024-02-28&to=2024-03-01']){
    assert.equal((await f.view(new Request('https://range.example/api/health?'+suffix))).status,400);
    assert.equal((await f.download(new Request('https://range.example/api/health/export?'+suffix))).status,400);
  }
  f.logout();assert.equal((await f.download(new Request('https://range.example/api/health/export?days=30'))).status,401);assert.equal(f.reads.length,0);
});
