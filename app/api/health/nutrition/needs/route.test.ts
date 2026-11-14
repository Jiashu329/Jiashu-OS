import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import * as needs from '../../../../../lib/nutrition-needs.ts';
import * as provider from '../../../../../lib/ai-provider.ts';
import { NutritionValidationError } from '../../../../../lib/nutrition.ts';
import { AISettingsConflictError } from '../../../../../db/ai-settings-store.ts';
import { SiteAISettingsUnavailableError } from '../../../../../db/site-ai-settings-store.ts';
import { AISettingsCryptoError } from '../../../../../lib/ai-settings-crypto.ts';

const ORIGIN = 'https://synthetic-nutrition-needs.example';
const PROFILE: needs.NutritionNeedsInput = { age: 35, heightCm: 175, weightKg: 70, sex: 'male', activity: 'moderate', goal: 'maintain' };
type Handler = (request: Request) => Promise<Response>;
function load(path: URL, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(bindings), source + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings)) as Record<string, Handler>;
}
function fixture() {
  let user: string | null = 'alice', configured = true, allowed = true, revision = 1;
  let configFailure: unknown, providerFailure: unknown, quotaFailure: unknown, beforeQuota: (() => void) | undefined;
  let answer = '活动水平会影响维持体重所需能量，请结合长期记录调整。';
  const env = { DB: {} as D1Database | undefined, APP_OWNER_USER_ID: 'site-owner', AI_SETTINGS_ENCRYPTION_KEY: 'PRIVATE-MASTER' };
  const configReads: Array<{ user: string; revision?: number }> = [], quotaUsers: string[] = [];
  const configurations: provider.AIConfiguration[] = [];
  const outgoing: Array<{ user: string | null; input: needs.NutritionNeedsInput; configuration: provider.AIConfiguration }> = [];
  const shared = load(new URL('../../../_shared.ts', import.meta.url), { getChatGPTUser: async () => user ? { userId: user } : null },
    ['apiUser', 'json', 'unauthenticated', 'invalidOrigin', 'isSameOrigin']);
  const nutrition = load(new URL('../_shared.ts', import.meta.url), { ...shared }, ['nutritionGuard', 'nutritionBody']);
  const handlers = load(new URL('./route.ts', import.meta.url), { env, ...shared, ...nutrition, ...needs, ...provider,
    NutritionValidationError, AISettingsConflictError, AISettingsCryptoError, SiteAISettingsUnavailableError,
    readSiteAISettings: async (_db: unknown, configurationEnv: typeof env) => {
      assert.equal(configurationEnv, env);
      if (configFailure) throw configFailure;
      return { revision };
    },
    resolveSiteAIConfiguration: async (_db: unknown, configurationEnv: typeof env, expectedRevision?: number) => {
      assert.equal(configurationEnv, env);
      configReads.push({ user: env.APP_OWNER_USER_ID, revision: expectedRevision });
      if (expectedRevision !== revision) throw new AISettingsConflictError();
      const configuration = provider.readAIConfiguration({ MINIMAX_API_KEY: configured ? 'PRIVATE-SHARED-KEY' : '' });
      configurations.push(configuration);
      return configuration;
    },
    consumeAIQuota: async (_db: unknown, id: string) => {
      quotaUsers.push(id);
      if (quotaFailure) throw quotaFailure;
      beforeQuota?.();
      return { allowed, retryAfter: 37 };
    },
    callNutritionNeedsAssistant: async (configuration: provider.AIConfiguration, input: needs.NutritionNeedsInput) => {
      outgoing.push({ user, input, configuration });
      if (providerFailure) throw providerFailure;
      return { answer, provider: 'MiniMax', model: 'MiniMax-M3' };
    },
  }, ['POST']);
  return { configReads, quotaUsers, configurations, outgoing,
    signIn(value: string | null) { user = value; },
    setConfigured(value: boolean) { configured = value; },
    setAllowed(value: boolean) { allowed = value; },
    setConfigFailure(value: unknown) { configFailure = value; },
    setProviderFailure(value: unknown) { providerFailure = value; },
    setQuotaFailure(value: unknown) { quotaFailure = value; },
    setAnswer(value: string) { answer = value; },
    removeDatabase() { env.DB = undefined; },
    changeDuringQuota(clear = false, bumpRevision = true) { beforeQuota = () => { if (bumpRevision) revision++; if (clear) configured = false; }; },
    post(body: unknown = PROFILE, options: { origin?: string | null; type?: string; raw?: boolean; length?: string } = {}) {
      const headers = new Headers({ 'Content-Type': options.type ?? 'application/json' });
      if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
      if (options.length) headers.set('Content-Length', options.length);
      return handlers.POST(new Request(ORIGIN + '/api/health/nutrition/needs', { method: 'POST', headers,
        body: options.raw ? String(body) : JSON.stringify(body) }));
    },
  };
}

test('needs estimation requires login and strict same-origin JSON before shared AI access or quota', async () => {
  const f = fixture(); f.signIn(null);
  assert.equal((await f.post()).status, 401);
  f.signIn('alice');
  assert.equal((await f.post(undefined, { origin: null })).status, 403);
  assert.equal((await f.post(undefined, { origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await f.post(undefined, { type: 'text/plain' })).status, 415);
  assert.equal((await f.post(undefined, { type: 'application/json-extra' })).status, 415);
  assert.equal(f.configReads.length, 0); assert.equal(f.quotaUsers.length, 0); assert.equal(f.outgoing.length, 0);
});

test('invalid and oversized needs profiles fail without quota or model use', async () => {
  const f = fixture();
  for (const body of [null, [], {}, { ...PROFILE, age: 17 }, { ...PROFILE, heightCm: '175' },
    { ...PROFILE, weightKg: 0 }, { ...PROFILE, sex: 'unknown' }, { ...PROFILE, activity: 'system' },
    { ...PROFILE, goal: 'fastLose' }, { ...PROFILE, userId: 'bob' }, { ...PROFILE, calories: 50 },
    { ...PROFILE, heightCm: 180, weightKg: 45, goal: 'lose' }]) {
    assert.equal((await f.post(body)).status, 400);
  }
  assert.equal((await f.post('{broken', { raw: true })).status, 400);
  assert.equal((await f.post(undefined, { length: String(4 * 1024 + 1) })).status, 413);
  assert.equal((await f.post(' '.repeat(4 * 1024 + 1), { raw: true })).status, 413);
  assert.equal(f.configReads.length, 0); assert.equal(f.quotaUsers.length, 0); assert.equal(f.outgoing.length, 0);
});

test('needs responses pair local formula targets with real shared AI explanation and never save a profile or goals', async () => {
  const f = fixture();
  const response = await f.post(); assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const result = await response.json() as { estimate: needs.NutritionNeedsEstimate; ai: { status: string; text: string; provider: string; model: string; message: string | null } };
  assert.deepEqual(result.estimate, needs.calculateNutritionNeeds(PROFILE));
  assert.equal(result.ai.status, 'ready'); assert.equal(result.ai.provider, 'MiniMax'); assert.equal(result.ai.model, 'MiniMax-M3');
  assert.match(result.ai.text, /活动水平/); assert.equal(result.ai.message, null);
  assert.equal(f.outgoing.length, 1); assert.deepEqual(f.outgoing[0].input, PROFILE);
  assert.equal(f.outgoing[0].configuration, f.configurations.at(-1));
  assert.ok(f.configReads.every((read) => read.user === 'site-owner' && read.revision === 1));
  assert.deepEqual(f.quotaUsers, ['alice']);
  assert.equal(JSON.stringify(result).includes('PRIVATE-'), false);
  assert.equal('profile' in result, false); assert.equal('userId' in result, false);
  // Another user uses the exact same owner selection while consuming only their
  // own quota. The route has no personal-health/goals write dependencies.
  f.signIn('bob'); assert.equal((await f.post({ ...PROFILE, weightKg: 72 })).status, 200);
  assert.equal(f.configReads.at(-1)?.user, 'site-owner'); assert.equal(f.quotaUsers.at(-1), 'bob');
  assert.equal(f.outgoing.at(-1)?.input.weightKg, 72);
  const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /writeNutritionGoals|writeHealth|writeWeight|localStorage|nutrition-goals-store|health-store/);
});

test('missing or encrypted shared AI config returns honest formula-only results without charging quota', async () => {
  for (const error of [new SiteAISettingsUnavailableError(), new AISettingsCryptoError(), new Error('PRIVATE-STORAGE')]) {
    const f = fixture(); f.setConfigFailure(error);
    const response = await f.post(); assert.equal(response.status, 200);
    const result = await response.json() as { estimate: needs.NutritionNeedsEstimate; ai: { status: string; text: null; message: string } };
    assert.deepEqual(result.estimate, needs.calculateNutritionNeeds(PROFILE));
    assert.equal(result.ai.status, 'unavailable'); assert.equal(result.ai.text, null); assert.match(result.ai.message, /公式估算/);
    assert.equal(JSON.stringify(result).includes('PRIVATE-'), false);
    assert.equal(f.quotaUsers.length, 0); assert.equal(f.outgoing.length, 0);
  }
  for (const mutate of [(f: ReturnType<typeof fixture>) => f.setConfigured(false), (f: ReturnType<typeof fixture>) => f.removeDatabase()]) {
    const f = fixture(); mutate(f);
    const response = await f.post(); assert.equal(response.status, 200);
    assert.equal((await response.json() as { ai: { status: string } }).ai.status, 'unavailable');
    assert.equal(f.quotaUsers.length, 0); assert.equal(f.outgoing.length, 0);
  }
});

test('quota refusal retains formula result with rateLimited status and retry time without calling MiniMax', async () => {
  const f = fixture(); f.setAllowed(false);
  const response = await f.post(); assert.equal(response.status, 200); assert.equal(response.headers.get('Retry-After'), '37');
  const result = await response.json() as { estimate: needs.NutritionNeedsEstimate; ai: { status: string; text: null; message: string } };
  assert.deepEqual(result.estimate, needs.calculateNutritionNeeds(PROFILE));
  assert.equal(result.ai.status, 'rateLimited'); assert.equal(result.ai.text, null); assert.match(result.ai.message, /每分钟最多 3 次/);
  assert.deepEqual(f.quotaUsers, ['alice']); assert.equal(f.outgoing.length, 0);
});

test('a concurrently updated or cleared shared key cannot be reused for needs explanation', async () => {
  for (const clear of [false, true]) {
    const f = fixture(); f.changeDuringQuota(clear);
    const response = await f.post(); assert.equal(response.status, 200);
    const result = await response.json() as { estimate: needs.NutritionNeedsEstimate; ai: { status: string; message: string } };
    assert.deepEqual(result.estimate, needs.calculateNutritionNeeds(PROFILE));
    assert.equal(result.ai.status, 'unavailable'); assert.match(result.ai.message, /配置已更新/);
    assert.equal(f.outgoing.length, 0); assert.equal(f.configReads.length, 2);
  }
  const f = fixture(); f.changeDuringQuota(true, false);
  assert.equal((await f.post()).status, 200); assert.equal(f.outgoing.length, 0);
});

test('provider and quota storage failures never discard formula targets or expose upstream/private error content', async () => {
  for (const error of [new provider.AIProviderError('PRIVATE-UPSTREAM', 'AI_TIMEOUT', 504),
    new provider.AIProviderError('PRIVATE-429', 'AI_RATE_LIMITED', 429), new Error('PRIVATE-NETWORK')]) {
    const f = fixture(); f.setProviderFailure(error);
    const response = await f.post(); assert.equal(response.status, 200);
    const result = await response.json() as { estimate: needs.NutritionNeedsEstimate; ai: { status: string; text: null } };
    assert.deepEqual(result.estimate, needs.calculateNutritionNeeds(PROFILE));
    assert.equal(result.ai.status, error instanceof provider.AIProviderError && error.status === 429 ? 'rateLimited' : 'unavailable');
    assert.equal(result.ai.text, null); assert.equal(JSON.stringify(result).includes('PRIVATE-'), false);
  }
  const f = fixture(); f.setQuotaFailure(new Error('PRIVATE-DB-QUOTA'));
  const response = await f.post(); assert.equal(response.status, 200);
  assert.equal((await response.text()).includes('PRIVATE-'), false); assert.equal(f.outgoing.length, 0);
});

test('empty or oversized explanation is unavailable and model output cannot replace formula targets', async () => {
  const f = fixture();
  for (const answer of ['', ' ', '字'.repeat(6001)]) {
    f.setAnswer(answer);
    const result = await (await f.post()).json() as { estimate: needs.NutritionNeedsEstimate; ai: { status: string; text: null } };
    assert.deepEqual(result.estimate, needs.calculateNutritionNeeds(PROFILE)); assert.equal(result.ai.status, 'unavailable'); assert.equal(result.ai.text, null);
  }
  f.setAnswer('模型内容不能改写上方公式目标');
  const result = await (await f.post()).json() as { estimate: needs.NutritionNeedsEstimate; ai: { status: string } };
  assert.deepEqual(result.estimate, needs.calculateNutritionNeeds(PROFILE)); assert.equal(result.ai.status, 'ready');
});
