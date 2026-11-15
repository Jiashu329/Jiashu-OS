import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import * as model from '../../../../../lib/douban.ts';
import * as cover from '../../../../../lib/douban-cover-selection.ts';
import * as store from '../../../../../db/douban-store.ts';
import * as sync from '../../../../../lib/douban-sync.ts';
const ORIGIN='https://synthetic-cover.example';
type Handler=(request:Request)=>Promise<Response>;
function load(path:URL,bindings:Record<string,unknown>,names:string[]){const source=stripTypeScriptTypes(readFileSync(path,'utf8'),{mode:'strip'}).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');return compileFunction(source+'\nreturn{'+names.join(',')+'};',Object.keys(bindings))(...Object.values(bindings))as Record<string,Handler>;}
function fixture(){
 let user:string|null='alice',failure:unknown;const calls:Array<{owner:string;body:unknown}>=[];
 const db={}as D1Database,shared=load(new URL('../../../_shared.ts',import.meta.url),{getChatGPTAccess: async () => ({ identity: null, allowed: false, isOwner: false, reason: 'signed_out' }), getChatGPTUser:async()=>user?{userId:user}:null},['apiUser','json','unauthenticated','invalidOrigin','isSameOrigin']);
 const helpers=load(new URL('../_shared.ts',import.meta.url),{env:{DB:db},...shared,...store,...model,...sync},['doubanDatabase','doubanGuard','doubanBody','doubanError']);
 const handler=load(new URL('./route.ts',import.meta.url),{...shared,...helpers,...cover,writeUserCover:async(database:D1Database,owner:string,body:Record<string,unknown>)=>{assert.equal(database,db);calls.push({owner,body});if(failure)throw failure;if(body.mode==='url')cover.normalizeUserCoverUrl(body.url);return{profileId:body.profileId,domain:body.domain,subjectId:body.subjectId,local:{note:'保留备注',tags:[],hidden:false,revision:1},cover:body.mode==='url'?{mode:'url',url:body.url,revision:1}:{mode:'original',revision:1}};}},['PUT']).PUT;
 return{calls,signIn(value:string|null){user=value;},fail(value:unknown){failure=value;},put(body:unknown,options:{origin?:string|null;type?:string;raw?:boolean;length?:string}={}){const headers=new Headers({'Content-Type':options.type??'application/json'});if(options.origin!==null)headers.set('Origin',options.origin??ORIGIN);if(options.length)headers.set('Content-Length',options.length);return handler(new Request(ORIGIN+'/api/life/douban/cover-selection',{method:'PUT',headers,body:options.raw?String(body):JSON.stringify(body)}));}};
}
const body={profileId:'profile',domain:'screen',subjectId:'1',expectedDataEpoch:0,expectedLocalRevision:0,mode:'url',url:'https://images.example.com/poster.jpg'};

test('cover selection needs login, explicit same origin and JSON before any storage write',async()=>{
 const f=fixture();f.signIn(null);assert.equal((await f.put(body)).status,401);f.signIn('alice');
 for(const origin of [null,'null','https://elsewhere.example'])assert.equal((await f.put(body,{origin})).status,403);
 assert.equal((await f.put(body,{type:'text/plain'})).status,415);assert.deepEqual(f.calls,[]);
});
test('URL-only schema rejects uploads, raw image data, arbitrary fields and oversized bodies',async()=>{
 const f=fixture();for(const input of [null,[],{}, {...body,mode:{toString:null,valueOf:null}}, {...body,mode:'upload',dataUrl:'data:image/jpeg;base64,AAAA'}, {...body,dataUrl:'data:image/png,abc'}, {...body,mode:'original'}, {...body,userId:'bob'}, {...body,url:undefined}])assert.equal((await f.put(input)).status,400);
 assert.equal((await f.put('{',{raw:true})).status,400);assert.equal((await f.put(body,{length:String(12*1024+1)})).status,413);assert.deepEqual(f.calls,[]);
});
test('saving a link or restoring original returns owner-scoped local fields and never fetches remote images',async()=>{
 const f=fixture(),saved=await f.put(body);assert.equal(saved.status,200);assert.equal(saved.headers.get('Cache-Control'),'no-store');assert.equal((await saved.json()as{item:{cover:{mode:string}}}).item.cover.mode,'url');
 const {url:_url,...original}=body;original.mode='original';assert.equal((await f.put(original)).status,200);assert.deepEqual(f.calls.map(call=>call.owner),['alice','alice']);
 f.fail(new store.DoubanStoreError('版本已变化','DOUBAN_RECORD_CONFLICT'));const conflict=await f.put(body);assert.equal(conflict.status,409);assert.equal((await conflict.json()as{code:string}).code,'DOUBAN_RECORD_CONFLICT');
 f.fail(new Error('PRIVATE_REMOTE_CONTENT'));const failure=await f.put(body);assert.equal(failure.status,503);assert.equal((await failure.text()).includes('PRIVATE_REMOTE_CONTENT'),false);
});
