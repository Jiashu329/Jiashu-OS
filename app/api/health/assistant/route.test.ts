import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import * as rules from '../../../../lib/health-assistant-context.ts';
import * as provider from '../../../../lib/ai-provider.ts';
import * as chat from '../../../../lib/health-assistant-chat.ts';
import * as scopeRules from '../../../../lib/health-assistant-scope.ts';
import { renderAssistantMarkdown } from '../../../../lib/assistant-markdown.ts';
import { AISettingsCryptoError } from '../../../../lib/ai-settings-crypto.ts';
import { AISettingsConflictError } from '../../../../db/ai-settings-store.ts';
import type { HealthMeasurement } from '../../../../lib/health.ts';
import { shanghaiDay } from '../../../../lib/health.ts';
import type { NutritionDayStatus } from '../../../../lib/nutrition.ts';

const ORIGIN = 'https://synthetic-assistant.example';
type Handler = (request: Request) => Promise<Response>;
function load(path: URL, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(bindings), source + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings)) as Record<string, Handler>;
}
function fixture() {
  let userId: string | null = 'alice';
  const env = { DB: {} as D1Database, AI_SETTINGS_ENCRYPTION_KEY: 'synthetic-test-only-encryption-master' };
  const keys: Record<string, string> = { alice: 'synthetic-alice-test-only-key', bob: 'synthetic-bob-test-only-key' };
  const revisions: Record<string, number> = { alice: 1, bob: 2 };
  const settingsReads: Array<{ db: unknown; user: string }> = [];
  const configReads: Array<{ db: unknown; user: string; master: unknown; expectedRevision?: number }> = [];
  const configurations: provider.AIConfiguration[] = [];
  const reads: Array<{ user: string; from: string; to: string; kind: string; metrics?: readonly string[] }> = [];
  const outgoing: Array<{ question: string; context: rules.HealthAssistantContext; history?: readonly chat.AssistantHistoryMessage[] }> = [];
  const quotaUsers: string[] = [];
  const statusRows: Record<string, NutritionDayStatus[]> = {};
  let allowed = true, empty = false, fail = false;
  let contextHook: (() => Promise<void>) | null = null, quotaHook: (() => Promise<void>) | null = null;
  // Keep fixture observations before the request's captured `now`, including
  // when hooks delay context collection across a millisecond boundary.
  const measuredAt = new Date(Date.now() - 1000).toISOString();
  const today = shanghaiDay(measuredAt);
  const shared = load(new URL('../../_shared.ts', import.meta.url), {
    getChatGPTUser: async () => userId ? { userId, email: 'synthetic-private@example.test' } : null,
  }, ['apiUser', 'json', 'unauthenticated', 'invalidOrigin', 'isSameOrigin']);
  const handlers = load(new URL('./route.ts', import.meta.url), {
    ...shared, env, ...rules, ...provider, ...chat, ...scopeRules, renderAssistantMarkdown, AISettingsCryptoError, AISettingsConflictError,
    readAISettings: async (db: unknown, user: string) => { settingsReads.push({ db, user }); return { revision: revisions[user] ?? 0 }; },
    resolveUserAIConfiguration: async (db: unknown, user: string, master: unknown, expectedRevision?: number) => {
      configReads.push({ db, user, master, expectedRevision });
      if (expectedRevision !== undefined && expectedRevision !== (revisions[user] ?? 0)) throw new AISettingsConflictError();
      return provider.readAIConfiguration({ AI_PROVIDER: 'minimax', MINIMAX_API_KEY: keys[user],
        MINIMAX_MODEL: user === 'bob' ? 'MiniMax-M2.7' : 'MiniMax-M3', MINIMAX_REGION: user === 'bob' ? 'global' : 'cn' });
    },
    readHealthRange: async (user: string, from: string, to: string, metrics?: readonly string[]) => {
      reads.push({ user, from, to, kind: 'health', metrics });
      const hook = contextHook; contextHook = null; await hook?.();
      if (fail) throw new Error('synthetic-private-storage-exception');
      return { measurements: empty ? [] : [{ id: 'private-record-id', metric: 'steps', value: user === 'alice' ? 100 : 200,
        unit: 'count', aggregation: 'daily', source: 'private-source-label',
        startDate: today + 'T00:00:00+08:00', endDate: measuredAt,
      } satisfies HealthMeasurement] };
    },
    readNutritionRangeSnapshot: async (_db: unknown, user: string, selection: { from: string; to: string }) => {
      reads.push({ user, ...selection, kind: 'nutrition-snapshot' });
      if (fail) throw new Error('synthetic-private-status-storage-exception');
      return { entries: [], statuses: statusRows[user] ?? [] };
    },
    readAIQuota: async () => ({allowed:true,retryAfter:0,remainingToday:20}),
    readGoalSettings: async (_db:unknown,user:string) => { reads.push({user,from:today,to:today,kind:'goals'});return {targets:{steps:8000,sleep:8,active_energy:null},effectiveFrom:today}; },
    readNutritionGoals:async(_db:unknown,user:string)=>{reads.push({user,from:today,to:today,kind:'nutrition-goals'});return {calories:'1800.0',carbs:'200.0',protein:'80.0',fat:'60.0',revision:1};},
    readWeightPlanSettings: async (_db:unknown,user:string) => { reads.push({user,from:today,to:today,kind:'plan'});return {enabled:true,baselineWeight:75,targetWeight:70,startDate:today,deadline:'2027-01-01'}; },
    consumeAIQuota: async (_db: unknown, user: string) => {
      quotaUsers.push(user); const hook = quotaHook; quotaHook = null; await hook?.();
      return { allowed, retryAfter: 23, remainingToday: 10 };
    },
    callHealthAssistant: async (config: provider.AIConfiguration, input: { question: string; context: rules.HealthAssistantContext; history?: readonly chat.AssistantHistoryMessage[] }) => {
      configurations.push(config);
      outgoing.push(input); return { answer: '合成测试回答 [H3]', provider: 'MiniMax', model: config.model };
    },
  }, ['GET', 'POST']);
  const request = (body: unknown = { question: '总结这段时间', days: 7, shareHealthData: true }, options: { origin?: string | null; type?: string; raw?: boolean; length?: string } = {}) => {
    const headers = new Headers({ 'Content-Type': options.type ?? 'application/json' });
    if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
    if (options.length) headers.set('Content-Length', options.length);
    return new Request(ORIGIN + '/api/health/assistant', { method: 'POST', headers, body: options.raw ? String(body) : JSON.stringify(body) });
  };
  return { env, keys, revisions, settingsReads, configReads, configurations, reads, outgoing, quotaUsers, handlers, request, today,
    setNutritionStatus(user: string, statuses: NutritionDayStatus[]) { statusRows[user] = statuses; },
    signIn(value: string | null) { userId = value; }, setAllowed(value: boolean) { allowed = value; },
    setEmpty(value: boolean) { empty = value; }, setFailure(value: boolean) { fail = value; },
    setConfigured(value: boolean, user = userId ?? 'alice') { keys[user] = value ? 'synthetic-' + user + '-test-only-key' : ''; revisions[user] = (revisions[user] ?? 0) + 1; },
    changeKey(key: string, user = userId ?? 'alice') { keys[user] = key; revisions[user] = (revisions[user] ?? 0) + 1; },
    beforeContext(action: () => Promise<void>) { contextHook = action; }, beforeQuota(action: () => Promise<void>) { quotaHook = action; },
    get(query = '') { return handlers.GET(new Request(ORIGIN + '/api/health/assistant' + query)); },
    post(body?: unknown, options?: Parameters<typeof request>[1]) { return handlers.POST(request(body, options)); },
  };
}

void test('health assistant requires login and same-origin JSON before reading health or calling the provider', async () => {
  const f = fixture(); f.signIn(null);
  assert.equal((await f.get()).status, 401); assert.equal((await f.post()).status, 401);
  assert.equal(f.reads.length, 0); f.signIn('alice');
  assert.equal((await f.post(undefined, { origin: 'https://foreign.example' })).status, 403);
  assert.equal((await f.post(undefined, { origin: null })).status, 403);
  assert.equal((await f.post(undefined, { type: 'text/plain' })).status, 415);
  assert.equal(f.reads.length, 0); assert.equal(f.outgoing.length, 0); assert.equal(f.quotaUsers.length, 0); assert.equal(f.configReads.length, 0); assert.equal(f.settingsReads.length, 0);
});

void test('custom assistant dates read exact inclusive owner ranges and bind history to both dates',async()=>{
  const f=fixture();const from=new Date(Date.parse(f.today+'T12:00:00Z')-2*86400000).toISOString().slice(0,10),to=f.today;
  const preview=await f.get('?from='+from+'&to='+to+'&metrics=steps&nutrition=0');assert.equal(preview.status,200);
  assert.ok(f.reads.every((read)=>read.from===from&&read.to===to&&read.user==='alice'));assert.equal(f.outgoing.length,0);
  const scope=scopeRules.parseAssistantScope({metrics:['steps'],includeNutrition:false,includeGoals:false});
  const key=scopeRules.assistantScopeKey(3,scope,{from,to});
  assert.equal((await f.post({question:'解释这三天',from,to,scope,shareHealthData:true,historyScope:key})).status,200);
  assert.equal(f.outgoing[0].context.range.days,3);assert.equal(f.outgoing[0].context.range.from,from);assert.equal(f.outgoing[0].context.range.to,to);
  const stale=fixture();assert.equal((await stale.post({question:'x',from,to,scope,shareHealthData:true,historyScope:scopeRules.assistantScopeKey(3,scope,{from:'2024-02-28',to:'2024-03-01'})})).status,400);
  assert.equal(stale.reads.length,0);assert.equal(stale.outgoing.length,0);
  const invalid=fixture();assert.equal((await invalid.get('?from=2024-02-30&to=2024-03-01')).status,400);assert.equal(invalid.reads.length,0);
});

void test('selected scope controls database reads and provider projection, including explicit opt-in targets',async()=>{
  const f=fixture();const scope={metrics:['steps'],includeNutrition:false,includeGoals:false};
  f.setNutritionStatus('alice',[{date:f.today,complete:true,revision:1,meals:{breakfast:'skipped',lunch:'skipped',dinner:'skipped',snack:'unrecorded'}}]);
  const response=await f.post({question:'只看步数',days:90,scope,historyScope:scopeRules.assistantScopeKey(90,scopeRules.parseAssistantScope(scope)),shareHealthData:true});
  assert.equal(response.status,200);assert.deepEqual(f.reads.map((r)=>r.kind),['health']);assert.deepEqual(f.reads[0].metrics,['steps']);
  assert.deepEqual(f.outgoing[0].context.health.map((m)=>m.metric),['steps']);assert.equal(f.outgoing[0].context.goals,undefined);assert.equal(f.outgoing[0].context.nutrition.recordedDays,0);assert.equal(f.outgoing[0].context.nutrition.completeDays,undefined);
  const answer=await response.json() as {usage:{remainingToday:number}};assert.equal(answer.usage.remainingToday,10);
  const g=fixture();assert.equal((await g.post({question:'对照我的目标',days:7,scope:{...scope,includeGoals:true},shareHealthData:true})).status,200);
  assert.deepEqual(g.reads.map((r)=>r.kind).sort(),['goals','health']);
  assert.equal(g.outgoing[0].context.goals?.targets[0].value,8000);
  const nutrition=fixture();const preview=await nutrition.get('?days=7&metrics=steps&nutrition=1&goals=1');
  assert.equal(preview.status,200);assert.ok(nutrition.reads.some((read)=>read.kind==='nutrition-goals'&&read.user==='alice'));
  const selected=await preview.json() as {context:rules.HealthAssistantContext};
  assert.deepEqual(selected.context.goals?.nutritionTargets?.find((target)=>target.nutrient==='protein'),{nutrient:'protein',value:'80.0',unit:'g'});
  assert.equal(nutrition.quotaUsers.length,0);assert.equal(nutrition.outgoing.length,0);
});

void test('invalid scopes and changed history scopes fail before database or quota and GET supports exact long ranges',async()=>{
  for(const scope of [{metrics:[],includeNutrition:false,includeGoals:false},{metrics:['sleep','sleep'],includeNutrition:false,includeGoals:false},{metrics:['private'],includeNutrition:false,includeGoals:false},{metrics:['steps'],includeNutrition:'false',includeGoals:false}]){
    const f=fixture();assert.equal((await f.post({question:'x',days:7,scope,shareHealthData:true})).status,400);assert.equal(f.settingsReads.length,0);assert.equal(f.reads.length,0);assert.equal(f.quotaUsers.length,0);
  }
  const f=fixture();assert.equal((await f.post({question:'x',days:30,shareHealthData:true,historyScope:'old-7-days',history:[{role:'user',content:'old'},{role:'assistant',content:'old'}]})).status,400);assert.equal(f.settingsReads.length,0);
  const response=await f.get('?days=360&metrics=steps&nutrition=0&goals=0');assert.equal(response.status,200);
  const data=await response.json() as {context:{range:{days:number};scope:{metrics:string[]}};usage:{remainingToday:number}};
  assert.equal(data.context.range.days,360);assert.deepEqual(data.context.scope.metrics,['steps']);assert.equal(data.usage.remainingToday,20);assert.equal(f.quotaUsers.length,0);
});

void test('rate-limit response provides usable application remaining and retry countdown without provider calls',async()=>{
  const f=fixture();f.setAllowed(false);const response=await f.post();assert.equal(response.status,429);
  const data=await response.json() as {usage:{remainingToday:number;retryAfter:number}};
  assert.deepEqual(data.usage,{remainingToday:10,retryAfter:23});assert.equal(response.headers.get('Retry-After'),'23');assert.equal(f.outgoing.length,0);
});

void test('GET is a local preview only, uses the authenticated owner, and never exposes credentials', async () => {
  const f = fixture();
  const response = await f.get('?days=30'); assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const data = await response.json() as { configuration: { ready: boolean; model: string }; context: { range: { days: number } } };
  assert.equal(data.configuration.ready, true); assert.equal(data.context.range.days, 30);
  assert.equal(data.configuration.model, 'MiniMax-M3');
  const encoded = JSON.stringify(data); for (const secret of [...Object.values(f.keys), f.env.AI_SETTINGS_ENCRYPTION_KEY]) assert.ok(!encoded.includes(secret));
  assert.deepEqual(f.configReads, [{ db: f.env.DB, user: 'alice', master: f.env.AI_SETTINGS_ENCRYPTION_KEY, expectedRevision: undefined }]);
  assert.equal(f.outgoing.length, 0); assert.equal(f.quotaUsers.length, 0);
  assert.ok(f.reads.every((entry) => entry.user === 'alice'));
  for (const query of ['?days=91', '?days=7&days=30', '?userId=bob', '?days=7e0']) assert.equal((await f.get(query)).status, 400);
  f.signIn('bob'); const other = await f.get(); assert.equal(other.status, 200);
  assert.equal(f.reads.at(-1)?.user, 'bob');
  const otherData = await other.json() as { configuration: { model: string } };
  assert.equal(otherData.configuration.model, 'MiniMax-M2.7');
  assert.deepEqual(f.configReads.at(-1), { db: f.env.DB, user: 'bob', master: f.env.AI_SETTINGS_ENCRYPTION_KEY, expectedRevision: undefined });
});

void test('explicit sharing, a supported range and a bounded question are required before any provider request', async () => {
  const f = fixture();
  for (const body of [null, [], {}, { question: 'x', days: 7 }, { question: 'x', days: 7, shareHealthData: 'true' },
    { question: 'x', days: 30, shareHealthData: true, userId: 'bob' },
    { question: 'x', days: 7, shareHealthData: true, context: {} },
    { question: ' ', days: 7, shareHealthData: true }, { question: 'x'.repeat(1001), days: 7, shareHealthData: true },
    { question: 'x\u0000', days: 7, shareHealthData: true }, { question: 'x', days: 91, shareHealthData: true }]) {
    assert.equal((await f.post(body)).status, 400);
  }
  assert.equal((await f.post('{', { raw: true })).status, 400);
  assert.equal((await f.post('x'.repeat(49153), { raw: true })).status, 413);
  assert.equal((await f.post(undefined, { length: '49153' })).status, 413);
  assert.equal(f.reads.length, 0); assert.equal(f.outgoing.length, 0); assert.equal(f.configReads.length, 0); assert.equal(f.settingsReads.length, 0);
});

void test('missing configuration, empty records, and exhausted quota never send health data to a model', async () => {
  const f = fixture(); f.setConfigured(false);
  assert.equal((await f.post()).status, 503); assert.equal(f.reads.length, 0);
  f.setConfigured(true); f.setEmpty(true);
  assert.equal((await f.post()).status, 400); assert.equal(f.quotaUsers.length, 0);
  f.setEmpty(false); f.setAllowed(false);
  const limited = await f.post(); assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '23');
  assert.equal(f.outgoing.length, 0); assert.deepEqual(f.quotaUsers, ['alice']);
});

void test('history validation rejects malformed or excessive browser turns before database, quota or model access', async () => {
  const f = fixture();
  const pair = (question = 'x', answer = 'y') => [{ role: 'user', content: question }, { role: 'assistant', content: answer }];
  for (const history of [null, {}, [pair()[0]], [...pair(), pair()[0]], [...pair(), ...pair(), ...pair(), ...pair(), ...pair()],
    [{ role: 'system', content: 'PRIVATE' }, pair()[1]], [pair()[0], { role: 'tool', content: 'PRIVATE' }],
    [pair()[1], pair()[0]], [pair()[0], { ...pair()[1], tools: [] }], pair('x'.repeat(1001)), pair('x', 'y'.repeat(10001)),
    pair('x', 'PRIVATE\u0000'), pair('PRIVATE\u0085'), [...pair('x', '字'.repeat(6000)), ...pair('x', '字'.repeat(6000))]]) {
    const response = await f.post({ question: '继续', days: 7, shareHealthData: true, history });
    assert.equal(response.status, 400);
    assert.equal((await response.text()).includes('PRIVATE'), false);
  }
  assert.equal(f.settingsReads.length, 0); assert.equal(f.configReads.length, 0); assert.equal(f.reads.length, 0);
  assert.equal(f.quotaUsers.length, 0); assert.equal(f.outgoing.length, 0);
});

void test('multi-turn requests pass only validated history and newly built owner context without persisting or returning history', async () => {
  const f = fixture();
  const history = [{ role: 'user', content: '  PRIVATE先前问题  ' }, { role: 'assistant', content: 'PRIVATE先前回答 [H999]' }];
  const response = await f.post({ question: '结合现在的记录呢？', days: 30, shareHealthData: true, history });
  assert.equal(response.status, 200);
  assert.deepEqual(f.outgoing[0].history, [{ role: 'user', content: 'PRIVATE先前问题' }, history[1]]);
  assert.equal(f.outgoing[0].context.range.days, 30);
  assert.ok(f.reads.every((entry) => entry.user === 'alice'));
  assert.deepEqual(f.quotaUsers, ['alice']);
  const result = await response.json() as { answer: string; answerHtml: string };
  assert.equal(result.answerHtml, renderAssistantMarkdown(result.answer));
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(f.outgoing[0].context).includes('H999'), false);
  // A subsequent request without browser history starts a fresh single turn.
  assert.equal((await f.post()).status, 200);
  assert.equal(Object.hasOwn(f.outgoing[1], 'history'), false);
  assert.equal((await f.post({ question: '😀'.repeat(1000), days: 7, shareHealthData: true, history: [] })).status, 200);
  assert.equal(Object.hasOwn(f.outgoing[2], 'history'), false);
});

void test('48 KiB request limits count actual bytes even when content-length is absent or misleading', async () => {
  const f = fixture();
  const body = JSON.stringify({ question: 'x', days: 7, shareHealthData: true });
  const exact = body + ' '.repeat(chat.MAX_ASSISTANT_REQUEST_BYTES - new TextEncoder().encode(body).byteLength);
  assert.equal((await f.post(exact, { raw: true, length: '1' })).status, 200);
  const before = f.settingsReads.length;
  assert.equal((await f.post(exact + ' ', { raw: true, length: '1' })).status, 413);
  assert.equal((await f.post(body + '字'.repeat(17000), { raw: true })).status, 413);
  assert.equal(f.settingsReads.length, before);
  assert.equal(f.quotaUsers.length, 1);
});

void test('POST sends only the server-selected owner context and returns data references with a plain answer', async () => {
  const f = fixture();
  const response = await f.post({ question: '  总结这段时间  ', days: 7, shareHealthData: true }); assert.equal(response.status, 200);
  const result = await response.json() as { answer: string; answerHtml: string; sources: unknown[]; generatedAt: string; range: { days: number } };
  assert.equal(result.answer, '合成测试回答 [H3]'); assert.equal(result.range.days, 7);
  assert.equal(result.answerHtml, renderAssistantMarkdown(result.answer));
  assert.ok(result.sources.length); assert.ok(Number.isFinite(Date.parse(result.generatedAt)));
  assert.equal(f.outgoing[0].question, '总结这段时间');
  const sent = JSON.stringify(f.outgoing[0]);
  for (const value of ['alice', 'bob', 'synthetic-private@example.test', 'private-record-id', 'private-source-label', ...Object.values(f.keys), f.env.AI_SETTINGS_ENCRYPTION_KEY]) assert.ok(!sent.includes(value));
  assert.ok(f.reads.every((entry) => entry.user === 'alice')); assert.deepEqual(f.quotaUsers, ['alice']);
  assert.deepEqual(f.settingsReads, [{ db: f.env.DB, user: 'alice' }]);
  assert.deepEqual(f.configReads, Array.from({ length: 2 }, () => ({ db: f.env.DB, user: 'alice', master: f.env.AI_SETTINGS_ENCRYPTION_KEY, expectedRevision: 1 })));
  assert.equal(f.configurations[0].model, 'MiniMax-M3'); assert.equal(f.configurations[0].region, 'cn');
  f.signIn('bob'); assert.equal((await f.post()).status, 200);
  assert.equal(f.configurations[1].model, 'MiniMax-M2.7'); assert.equal(f.configurations[1].region, 'global');
  assert.deepEqual(f.settingsReads.at(-1), { db: f.env.DB, user: 'bob' });
  assert.deepEqual(f.configReads.at(-1), { db: f.env.DB, user: 'bob', master: f.env.AI_SETTINGS_ENCRYPTION_KEY, expectedRevision: 2 });
});

void test('storage failures fail closed without exposing private exceptions or sending a request', async () => {
  const f = fixture(); f.setFailure(true);
  const response = await f.post(); assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('synthetic-private-storage-exception'));
  assert.equal(f.outgoing.length, 0); assert.equal(f.quotaUsers.length, 0);
});

function barrier() {
  let enter!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { enter = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release, async pause() { enter(); await waiting; } };
}

void test('clearing the key while health context is loading prevents the captured configuration from sending data', async () => {
  const f = fixture(); const waiting = barrier(); f.beforeContext(waiting.pause);
  const pending = f.post(); await waiting.reached;
  assert.equal(f.configReads[0].expectedRevision, 1);
  f.setConfigured(false); waiting.release();
  const response = await pending; assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, 'AI_SETTINGS_CONFLICT');
  assert.equal(f.revisions.alice, 2); assert.equal(f.keys.alice, '');
  assert.equal(f.configReads.at(-1)?.expectedRevision, 1);
  assert.equal(f.configurations.length, 0); assert.equal(f.outgoing.length, 0);
});

void test('saving a replacement key while quota is pending requires a fresh question before any provider call', async () => {
  const f = fixture(); const waiting = barrier(); f.beforeQuota(waiting.pause);
  const pending = f.post(); await waiting.reached;
  assert.equal(f.configReads[0].expectedRevision, 1); assert.deepEqual(f.quotaUsers, ['alice']);
  f.changeKey('synthetic-replacement-user-key'); waiting.release();
  const response = await pending; assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, 'AI_SETTINGS_CONFLICT');
  assert.equal(f.revisions.alice, 2); assert.equal(f.configReads.at(-1)?.expectedRevision, 1);
  assert.equal(f.configurations.length, 0); assert.equal(f.outgoing.length, 0);
  assert.equal((await f.post()).status, 200); assert.equal(f.outgoing.length, 1);
  assert.equal(f.configReads.at(-1)?.expectedRevision, 2);
});

void test('completion status is read for the authenticated owner and reaches preview and model context', async () => {
  const f = fixture();
  f.setNutritionStatus('alice', [{ date: f.today, complete: true, revision: 2,
    meals: { breakfast: 'skipped', lunch: 'skipped', dinner: 'skipped', snack: 'unrecorded' } }]);
  const preview = await (await f.get()).json() as { context: rules.HealthAssistantContext };
  assert.equal(preview.context.nutrition.completeDays, 1);
  assert.equal(preview.context.nutrition.recordedDays, 0);
  assert.equal(preview.context.nutrition.days[0].recordedKnownKcal, null);
  assert.equal(preview.context.nutrition.days[0].meals?.lunch, 'skipped');
  assert.equal((await f.post()).status, 200);
  assert.deepEqual(f.outgoing[0].context.nutrition, preview.context.nutrition);
  const snapshots = f.reads.filter((read) => read.kind === 'nutrition-snapshot');
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots.every((read) => read.user === 'alice'));
  f.signIn('bob');
  const other = await (await f.get()).json() as { context: rules.HealthAssistantContext };
  assert.equal(other.context.nutrition.completeDays, 0);
  assert.equal(other.context.nutrition.days.length, 0);
});
