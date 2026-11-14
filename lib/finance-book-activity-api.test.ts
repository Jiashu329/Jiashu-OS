import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

function fixture(){
 let user:{userId:string}|null={userId:'alice'};const calls:unknown[][]=[];
 const source=stripTypeScriptTypes(readFileSync(new URL('../app/api/finance/books/[bookId]/activity/route.ts',import.meta.url),'utf8'),{mode:'strip'}).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
 const bindings={env:{DB:{}},apiUser:async()=>user,json:(value:unknown,status=200)=>Response.json(value,{status}),financeUnauthenticated:()=>Response.json({}, {status:401}),financeError:()=>Response.json({}, {status:503}),listFinanceBookActivity:async(...args:unknown[])=>{calls.push(args);return{items:[],offset:0,limit:30,hasMore:false};}};
 const get=new Function(...Object.keys(bindings),source+'\nreturn GET;')(...Object.values(bindings)) as (request:Request,context:{params:Promise<{bookId:string}>})=>Promise<Response>;
 return{calls,signOut(){user=null;},get(query='',headers:Record<string,string>={}){return get(new Request('https://synthetic.example/api/finance/books/own/activity'+query,{headers}),{params:Promise.resolve({bookId:'own'})});}};
}

test('activity API binds actor and exact paging parameters without accepting alternate owner identities',async()=>{
 const f=fixture();assert.equal((await f.get('?offset=30&limit=10&bookRevision=3',{'X-Page-Owner':'alice'})).status,200);
 assert.deepEqual(f.calls[0].slice(1),[{userId:'alice'},'own',{offset:30,limit:10,accessRevision:3}]);
 for(const query of ['?offset=-1','?offset=1.5','?offset=9007199254740992','?offset=0&offset=1','?limit=1&limit=2','?bookRevision=x','?ownerUserId=bob','?ledger=personal'])assert.equal((await f.get(query)).status,400,query);
 assert.equal((await f.get('',{'X-Page-Owner':'bob'})).status,401);assert.equal(f.calls.length,1);
 f.signOut();assert.equal((await f.get()).status,401);assert.equal(f.calls.length,1);
});
