import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import * as parser from '../../../../../lib/nutrition-parser.ts';
import * as provider from '../../../../../lib/ai-provider.ts';
import { AISettingsConflictError } from '../../../../../db/ai-settings-store.ts';
import { AISettingsCryptoError } from '../../../../../lib/ai-settings-crypto.ts';
import { shanghaiDay } from '../../../../../lib/health.ts';

const ORIGIN = 'https://synthetic-nutrition-parser.example';
type Handler = (request: Request) => Promise<Response>;
function load(path: URL, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(bindings), source + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings)) as Record<string, Handler>;
}
function fixture() {
  let user: string | null = 'alice', configured = true, allowed = true, revision = 1;
  let failure: unknown, beforeQuota: (() => void) | undefined;
  let answer = JSON.stringify({ items: [{ name: '熟米饭', amount: 150, unit: '克', meal: 'lunch', dateText: null, sourceText: '150克熟米饭' }] });
  const today = shanghaiDay(new Date().toISOString());
  const defaultBody = { text: '午餐吃了150克熟米饭', date: today };
  const env = { DB: {} as D1Database, AI_SETTINGS_ENCRYPTION_KEY: 'PRIVATE-MASTER' };
  const configReads: Array<{ user: string; revision?: number }> = [], quotaUsers: string[] = [];
  const outgoing: Array<{ user: string | null; input: parser.NutritionParserRequest }> = [];
  const shared = load(new URL('../../../_shared.ts', import.meta.url), { getChatGPTUser: async () => user ? { userId: user } : null },
    ['apiUser', 'json', 'unauthenticated', 'invalidOrigin', 'isSameOrigin']);
  const nutrition = load(new URL('../_shared.ts', import.meta.url), { ...shared }, ['nutritionGuard', 'nutritionBody']);
  const handlers = load(new URL('./route.ts', import.meta.url), { env, ...shared, ...nutrition, ...parser, ...provider,
    AISettingsConflictError, AISettingsCryptoError,
    readAISettings: async (_db: unknown, id: string) => { if (failure) throw failure; return { revision, user: id }; },
    resolveUserAIConfiguration: async (_db: unknown, id: string, _master: unknown, expectedRevision?: number) => {
      configReads.push({ user: id, revision: expectedRevision });
      if (expectedRevision !== revision) throw new AISettingsConflictError();
      return provider.readAIConfiguration({ MINIMAX_API_KEY: configured ? 'PRIVATE-KEY-' + id : '' });
    },
    consumeAIQuota: async (_db: unknown, id: string) => { quotaUsers.push(id); beforeQuota?.(); return { allowed, retryAfter: 37 }; },
    callNutritionParser: async (_config: provider.AIConfiguration, input: parser.NutritionParserRequest) => {
      outgoing.push({ user, input });
      if (failure) throw failure;
      return { answer, provider: 'MiniMax', model: 'MiniMax-M3' };
    },
  }, ['POST']);
  return { today, configReads, quotaUsers, outgoing,
    signIn(value: string | null) { user = value; },
    setConfigured(value: boolean) { configured = value; },
    setAllowed(value: boolean) { allowed = value; },
    setFailure(value: unknown) { failure = value; },
    setAnswer(value: string) { answer = value; },
    changeDuringQuota() { beforeQuota = () => { revision++; }; },
    post(body: unknown = defaultBody, options: { origin?: string | null; type?: string; raw?: boolean; length?: string } = {}) {
      const headers = new Headers({ 'Content-Type': options.type ?? 'application/json' });
      if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
      if (options.length) headers.set('Content-Length', options.length);
      return handlers.POST(new Request(ORIGIN + '/api/health/nutrition/parse', { method: 'POST', headers,
        body: options.raw ? String(body) : JSON.stringify(body) }));
    },
  };
}

test('parsing requires login and same-origin JSON before reading configuration or consuming quota', async () => {
  const f = fixture(); f.signIn(null);
  assert.equal((await f.post()).status, 401);
  f.signIn('alice');
  assert.equal((await f.post(undefined, { origin: null })).status, 403);
  assert.equal((await f.post(undefined, { origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await f.post(undefined, { type: 'text/plain' })).status, 415);
  assert.equal((await f.post(undefined, { type: 'application/json-extra' })).status, 415);
  assert.equal(f.configReads.length, 0); assert.equal(f.quotaUsers.length, 0); assert.equal(f.outgoing.length, 0);
});

test('invalid input, future dates and oversized bodies fail without a model request or quota use', async () => {
  const f = fixture();
  for (const body of [null, [], {}, { text: '米饭', date: '2100-01-01' }, { text: '', date: f.today },
    { text: '字'.repeat(2001), date: f.today }, { text: '米饭', date: f.today, meal: 'system' },
    { text: '米饭', date: f.today, userId: 'bob' }, { text: '米饭', date: f.today, history: [] }]) {
    assert.equal((await f.post(body)).status, 400);
  }
  assert.equal((await f.post('{broken', { raw: true })).status, 400);
  assert.equal((await f.post(undefined, { length: String(16 * 1024 + 1) })).status, 413);
  assert.equal(f.configReads.length, 0); assert.equal(f.quotaUsers.length, 0); assert.equal(f.outgoing.length, 0);
});

test('a successful parse returns editable drafts with local calories and no persistent writes or private configuration', async () => {
  const f = fixture();
  const response = await f.post(); assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const result = await response.json() as { drafts: parser.NutritionDraft[]; model: string; provider: string };
  assert.equal(result.drafts.length, 1); assert.equal(result.drafts[0].date, f.today);
  assert.equal(result.drafts[0].meal, 'lunch'); assert.ok(result.drafts[0].food);
  assert.ok(Number(result.drafts[0].calories) > 0);
  assert.equal(result.provider, 'MiniMax');
  assert.equal(f.outgoing.length, 1);
  assert.deepEqual(f.outgoing[0].input, { text: '午餐吃了150克熟米饭', date: f.today, today: f.today, meal: null });
  assert.ok(f.configReads.every((read) => read.user === 'alice' && read.revision === 1));
  assert.deepEqual(f.quotaUsers, ['alice']);
  assert.equal(JSON.stringify(result).includes('PRIVATE-'), false);
  f.signIn('bob'); assert.equal((await f.post()).status, 200);
  assert.equal(f.configReads.at(-1)?.user, 'bob'); assert.equal(f.quotaUsers.at(-1), 'bob');
});

test('the reported breakfast sentence accepts a date with a time of day and preserves all three food quantities', async () => {
  const f = fixture();
  const text = '今天早上吃了2个肉包子、1碗豆浆、2个茶叶蛋';
  f.setAnswer(JSON.stringify({ items: [
    { name: '肉包子', amount: 2, unit: '个', meal: null, dateText: '今天早上', sourceText: '2个肉包子' },
    { name: '豆浆', amount: 1, unit: '碗', meal: 'breakfast', dateText: '今天', sourceText: '1碗豆浆' },
    { name: '茶叶蛋', amount: 2, unit: '个', meal: null, dateText: '今天早上', sourceText: '2个茶叶蛋' },
  ] }));
  const response = await f.post({ text, date: f.today });
  assert.equal(response.status, 200);
  const result = await response.json() as { drafts: parser.NutritionDraft[] };
  assert.deepEqual(result.drafts.map(({ name, date, meal, amount, unit }) => ({ name, date, meal, amount, unit })), [
    { name: '肉包子', date: f.today, meal: 'breakfast', amount: 2, unit: '个' },
    { name: '豆浆', date: f.today, meal: 'breakfast', amount: 1, unit: '碗' },
    { name: '茶叶蛋', date: f.today, meal: 'breakfast', amount: 2, unit: '个' },
  ]);
  assert.equal(f.outgoing.length, 1);
  assert.equal(f.outgoing[0].input.text, text);
  assert.equal(JSON.stringify(result).includes('PRIVATE-'), false);
});

test('missing configuration, quota exhaustion and concurrent key changes stop before extraction', async () => {
  const f = fixture(); f.setConfigured(false);
  assert.equal((await f.post()).status, 503); assert.equal(f.quotaUsers.length, 0);
  f.setConfigured(true); f.setAllowed(false);
  const limited = await f.post(); assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '37');
  assert.equal(f.outgoing.length, 0);
  f.setAllowed(true); f.changeDuringQuota();
  assert.equal((await f.post()).status, 409); assert.equal(f.outgoing.length, 0);
});

test('a food absent from the catalog returns an estimated total with its assumptions for confirmation', async () => {
  const f = fixture();
  const text = '午餐吃了1份合成测试复合菜';
  f.setAnswer(JSON.stringify({ items: [{ name: '合成测试复合菜', amount: 1, unit: '份', meal: 'lunch',
    dateText: null, sourceText: '1份合成测试复合菜', estimate: { calories: 360, portion: '1份（按250g估算）',
      basis: '按普通份量、适量烹调油估算，实际配料未知' } }] }));
  const response = await f.post({ text, date: f.today }); assert.equal(response.status, 200);
  const result = await response.json() as { drafts: parser.NutritionDraft[] };
  assert.equal(result.drafts[0].calories, '360.0'); assert.equal(result.drafts[0].calorieSource, 'ai');
  assert.equal(result.drafts[0].food, null); assert.match(result.drafts[0].note, /AI 估算.*250g/);
  assert.equal(f.outgoing.length, 1); assert.deepEqual(f.quotaUsers, ['alice']);
});

test('invalid model output cannot inject fields, food IDs, calorie values or unquoted records', async () => {
  const f = fixture();
  for (const answer of [
    'not json PRIVATE-UPSTREAM', '{"items":[],"system":"PRIVATE-UPSTREAM"}',
    JSON.stringify({ items: [{ name: '熟米饭', amount: 150, unit: '克', meal: 'lunch', dateText: null, sourceText: '150克熟米饭', calories: 1 }] }),
    JSON.stringify({ items: [{ name: '不存在的食物', amount: 150, unit: '克', meal: 'lunch', dateText: null, sourceText: '并未出现的原文' }] }),
  ]) {
    f.setAnswer(answer);
    const result = await f.post(); assert.equal(result.status, 502);
    assert.equal((await result.text()).includes('PRIVATE-UPSTREAM'), false);
  }
});

test('storage, crypto and provider failures return only safe local classifications', async () => {
  const f = fixture(); f.setFailure(new Error('PRIVATE-STORAGE PRIVATE-KEY-alice'));
  const unavailable = await f.post(); assert.equal(unavailable.status, 503); assert.equal((await unavailable.text()).includes('PRIVATE-'), false);
  f.setFailure(new AISettingsCryptoError());
  assert.equal((await f.post()).status, 503);
  f.setFailure(new provider.AIProviderError('MiniMax 暂时不可用。', 'AI_RATE_LIMITED', 429, { upstreamStatus: 429 }));
  const limited = await f.post(); assert.equal(limited.status, 429);
  assert.deepEqual((await limited.json() as { diagnostics: unknown }).diagnostics, { upstreamStatus: 429 });
});
