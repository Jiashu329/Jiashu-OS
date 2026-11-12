import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { readWithDeadline } from '../../../lib/read-deadline.ts';

function load(path: URL, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(bindings), source + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings));
}
function fixture(options: { signedIn?: boolean; health?: 'pending' | 'failed'; personal?: 'failed'; nutrition?: 'pending'|'failed' } = {}) {
  const logs: string[] = []; const owners: string[] = [];
  const shared = load(new URL('../_shared.ts', import.meta.url), {
    getChatGPTUser: async () => options.signedIn === false ? null : { userId: 'synthetic-owner' },
    console: { error: (value: string) => logs.push(value) },
  }, ['apiUser', 'json', 'storageDiagnostic', 'unavailable']);
  const { GET } = load(new URL('./route.ts', import.meta.url), {
    ...shared, env:{DB:{}},shanghaiDay:()=> '2026-11-11',readWithDeadline: <T>(operation: Promise<T>) => readWithDeadline(operation, 10),
    readNutritionRangeSnapshot:async(_db:unknown,owner:string)=>{owners.push(owner);if(options.nutrition==='pending')return new Promise(()=>{});if(options.nutrition==='failed')throw new Error('synthetic-private-food');return {entries:[],statuses:[]};},
    readNutritionGoals:async(_db:unknown,owner:string)=>{owners.push(owner);return {calories:null,carbs:null,protein:null,fat:null,revision:0};},
    readHealth: async (owner: string) => { owners.push(owner); if (options.health === 'pending') return new Promise(() => {}); if (options.health === 'failed') throw new Error('synthetic-private-record-and-key'); return {}; },
    financeOverview: async (owner: string, ledger: string) => { owners.push(owner); if (ledger === 'personal' && options.personal === 'failed') throw new Error('synthetic-private-account'); return {}; },
    buildHomeOverview: (sources: Record<string, unknown>) => ({ asOf: '2026-11-11T00:00:00Z',
      health: { status: sources.health ? 'ready' : 'unavailable' },
      finance: Object.fromEntries(['personal', 'family'].map((key) => [key, { status: sources[key] ? 'ready' : 'unavailable' }])),
      nutrition:{status:sources.nutrition?'ready':'unavailable'},
    }),
  }, ['GET']);
  return { GET: GET as () => Promise<Response>, logs, owners, unavailable: shared.unavailable as () => Response };
}

test('overview authenticates before reading any module', async () => {
  const f = fixture({ signedIn: false }); assert.equal((await f.GET()).status, 401); assert.equal(f.owners.length, 0);
});

test('one stalled module yields a bounded partial overview with safe diagnostics', async () => {
  const f = fixture({ health: 'pending' }); const response = await f.GET();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const data = await response.json() as { health: { status: string }; finance: { family: { status: string } }; modules: Record<string, { status: string; diagnosticId?: string }> };
  assert.equal(data.health.status, 'unavailable'); assert.equal(data.finance.family.status, 'ready');
  assert.match(data.modules.health.diagnosticId!, /^[a-f0-9]{32}$/); assert.equal(data.modules.family.diagnosticId, undefined);
  assert.equal(f.logs.length, 1); assert.deepEqual(Object.keys(JSON.parse(f.logs[0])).sort(), ['diagnosticId', 'event', 'module', 'reason']);
  assert.equal(JSON.parse(f.logs[0]).reason, 'read_timeout');
  assert.ok(f.owners.every((owner) => owner === 'synthetic-owner'));
});

test('module failures and health 503 responses never expose raw errors in diagnostics', async () => {
  const f = fixture({ health: 'failed', personal: 'failed' }); const response = await f.GET();
  const text = await response.text(); assert.ok(!text.includes('synthetic-private'));
  assert.equal(f.logs.length, 2); assert.ok(!f.logs.join('').includes('synthetic-private'));
  const unavailable = f.unavailable(); assert.equal(unavailable.status, 503);
  const data = await unavailable.json() as { code: string; diagnosticId: string };
  assert.equal(data.code, 'HEALTH_STORAGE_UNAVAILABLE'); assert.equal(unavailable.headers.get('X-Diagnostic-ID'), data.diagnosticId);
});

test('nutrition failure stays separate from ready health and finance and never appears as an empty diet',async()=>{
  const f=fixture({nutrition:'failed'});const response=await f.GET();assert.equal(response.status,200);
  const data=await response.json() as {health:{status:string};nutrition:{status:string};modules:Record<string,{status:string;diagnosticId?:string}>};
  assert.equal(data.health.status,'ready');assert.equal(data.nutrition.status,'unavailable');assert.equal(data.modules.nutrition.status,'unavailable');
  assert.match(data.modules.nutrition.diagnosticId!,/^[a-f0-9]{32}$/);assert.equal(f.logs.length,1);assert.ok(!JSON.stringify(data).includes('synthetic-private'));
  assert.ok(f.owners.every((owner)=>owner==='synthetic-owner'));
});
