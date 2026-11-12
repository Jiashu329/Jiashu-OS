import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

test('local recovery bootstrap requires login and returns only opaque identity with no-store headers',async()=>{
  const source=stripTypeScriptTypes(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{mode:'strip'}).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
  let user:object|null=null;const GET=new Function('apiUser','json','unauthenticated',source+';return GET;')(
    async()=>user,(body:unknown)=>Response.json(body,{headers:{'Cache-Control':'no-store'}}),()=>Response.json({code:'SIGN_IN_REQUIRED'},{status:401}),
  ) as ()=>Promise<Response>;
  assert.equal((await GET()).status,401);user={userId:'opaque-owner',email:'private@example.test',displayName:'PRIVATE',token:'DO_NOT_RETURN'};
  const response=await GET();assert.deepEqual(await response.json(),{userId:'opaque-owner'});assert.equal(response.headers.get('Cache-Control'),'no-store');
});
