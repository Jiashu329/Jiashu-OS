import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInThisContext } from 'node:vm';
import test from 'node:test';

void test('session identifies only the current account, retains the opaque owner contract and never returns tokens',async()=>{
  const source=stripTypeScriptTypes(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{mode:'strip'}).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
  let user:object|null=null;const factory=runInThisContext('(function(apiUser,json,unauthenticated){'+source+';return GET;})') as (...values:unknown[])=>()=>Promise<Response>;const GET=factory(
    async()=>user,(body:unknown)=>Response.json(body,{headers:{'Cache-Control':'no-store'}}),()=>Response.json({code:'SIGN_IN_REQUIRED'},{status:401}),
  ) as ()=>Promise<Response>;
  assert.equal((await GET()).status,401);user={userId:'opaque-owner',email:'private@example.test',displayName:'PRIVATE',isOwner:true,token:'DO_NOT_RETURN'};
  const response=await GET();assert.deepEqual(await response.json(),{userId:'opaque-owner',displayName:'PRIVATE',email:'private@example.test',isOwner:true});assert.equal(response.headers.get('Cache-Control'),'no-store');
  user={userId:'other-owner',displayName:'<img src=x onerror=alert(1)>',email:'other@example.test',fullName:'DO_NOT_RETURN',token:'DO_NOT_RETURN'};
  assert.deepEqual(await (await GET()).json(),{userId:'other-owner',displayName:'<img src=x onerror=alert(1)>',email:'other@example.test',isOwner:false});
  user=null;assert.equal((await GET()).status,401);
});
