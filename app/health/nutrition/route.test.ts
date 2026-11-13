import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { normalizeTimestamp, shanghaiDay } from '../../../lib/health.ts';

function fixture() {
  let returnTo = '';
  const code = stripTypeScriptTypes(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), { mode:'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const bindings = { normalizeTimestamp, shanghaiDay,
    async requireChatGPTUser(path: string) { returnTo = path; return { userId: 'alice' }; },
    renderNutritionPage(id: string) { return '<html><head></head><body>' + id + '</body></html>'; },
    withPageAccount(html: string, id: string) { assert.equal(id,'alice');return html; } };
  const get = new Function(...Object.keys(bindings), code + '\nreturn GET;')(...Object.values(bindings)) as (request: Request) => Promise<Response>;
  return { get: (query: string) => get(new Request('https://app.test/health/nutrition' + query)), get returnTo() { return returnTo; } };
}

test('the authenticated nutrition route keeps a valid food-library handoff through sign-in',async()=>{
  const app=fixture(),response=await app.get('?date=2026-01-01&food=mcd-cn%3A49%3A28&unknown=discard');
  const query=new URL('https://app.test'+app.returnTo).searchParams;
  assert.equal(query.get('food'),'mcd-cn:49:28');assert.equal(query.get('date'),'2026-01-01');assert.equal(query.has('unknown'),false);
  assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.status,200);
});

test('duplicate, oversized, or malformed handoff IDs are excluded from the sign-in return URL',async()=>{
  for(const query of ['?food=one&food=two','?food='+('x'.repeat(121)),'?food=%3Cscript%3E','?food=one%0Atwo','?food=']) {
    const app=fixture();await app.get(query);assert.equal(new URL('https://app.test'+app.returnTo).searchParams.has('food'),false);
  }
});
