import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import * as rules from '../../../../lib/health-assistant-context.ts';
import * as provider from '../../../../lib/ai-provider.ts';
import type { HealthMeasurement } from '../../../../lib/health.ts';
import { shanghaiDay } from '../../../../lib/health.ts';

const ORIGIN = 'https://synthetic-assistant.example';
type Handler = (request: Request) => Promise<Response>;
function load(path: URL, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(bindings), source + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings)) as Record<string, Handler>;
}
function fixture() {
  let userId: string | null = 'alice';
  const env = { DB: {} as D1Database, MINIMAX_API_KEY: 'synthetic-test-only-key' };
  const reads: Array<{ user: string; from: string; to: string; kind: string }> = [];
  const outgoing: Array<{ question: string; context: rules.HealthAssistantContext }> = [];
  const quotaUsers: string[] = [];
  let allowed = true, empty = false, fail = false;
  const today = shanghaiDay(new Date().toISOString());
  const shared = load(new URL('../../_shared.ts', import.meta.url), {
    getChatGPTUser: async () => userId ? { userId, email: 'synthetic-private@example.test' } : null,
  }, ['apiUser', 'json', 'unauthenticated', 'invalidOrigin', 'isSameOrigin']);
  const handlers = load(new URL('./route.ts', import.meta.url), {
    ...shared, env, ...rules, ...provider,
    readHealthRange: async (user: string, from: string, to: string) => {
      reads.push({ user, from, to, kind: 'health' });
      if (fail) throw new Error('synthetic-private-storage-exception');
      return { measurements: empty ? [] : [{ id: 'private-record-id', metric: 'steps', value: user === 'alice' ? 100 : 200,
        unit: 'count', aggregation: 'daily', source: 'private-source-label',
        startDate: today + 'T00:00:00+08:00', endDate: new Date().toISOString(),
      } satisfies HealthMeasurement] };
    },
    listNutritionEntries: async (_db: unknown, user: string, selection: { from: string; to: string }) => {
      reads.push({ user, ...selection, kind: 'nutrition' }); return [];
    },
    consumeAIQuota: async (_db: unknown, user: string) => { quotaUsers.push(user); return { allowed, retryAfter: 23, remainingToday: 10 }; },
    callHealthAssistant: async (_config: unknown, input: { question: string; context: rules.HealthAssistantContext }) => {
      outgoing.push(input); return { answer: '合成测试回答 [H3]', provider: 'MiniMax', model: 'MiniMax-M3' };
    },
  }, ['GET', 'POST']);
  const request = (body: unknown = { question: '总结这段时间', days: 7, shareHealthData: true }, options: { origin?: string | null; type?: string; raw?: boolean; length?: string } = {}) => {
    const headers = new Headers({ 'Content-Type': options.type ?? 'application/json' });
    if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
    if (options.length) headers.set('Content-Length', options.length);
    return new Request(ORIGIN + '/api/health/assistant', { method: 'POST', headers, body: options.raw ? String(body) : JSON.stringify(body) });
  };
  return { env, reads, outgoing, quotaUsers, handlers, request,
    signIn(value: string | null) { userId = value; }, setAllowed(value: boolean) { allowed = value; },
    setEmpty(value: boolean) { empty = value; }, setFailure(value: boolean) { fail = value; },
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
  assert.equal(f.reads.length, 0); assert.equal(f.outgoing.length, 0); assert.equal(f.quotaUsers.length, 0);
});

void test('GET is a local preview only, uses the authenticated owner, and never exposes credentials', async () => {
  const f = fixture();
  const response = await f.get('?days=30'); assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const data = await response.json() as { configuration: { ready: boolean }; context: { range: { days: number } } };
  assert.equal(data.configuration.ready, true); assert.equal(data.context.range.days, 30);
  const encoded = JSON.stringify(data); assert.ok(!encoded.includes(f.env.MINIMAX_API_KEY));
  assert.equal(f.outgoing.length, 0); assert.equal(f.quotaUsers.length, 0);
  assert.ok(f.reads.every((entry) => entry.user === 'alice'));
  for (const query of ['?days=90', '?days=7&days=30', '?userId=bob', '?days=7e0']) assert.equal((await f.get(query)).status, 400);
  f.signIn('bob'); const other = await f.get(); assert.equal(other.status, 200);
  assert.equal(f.reads.at(-1)?.user, 'bob');
});

void test('explicit sharing, a supported range and a bounded question are required before any provider request', async () => {
  const f = fixture();
  for (const body of [null, [], {}, { question: 'x', days: 7 }, { question: 'x', days: 7, shareHealthData: 'true' },
    { question: 'x', days: 30, shareHealthData: true, userId: 'bob' },
    { question: 'x', days: 7, shareHealthData: true, context: {} },
    { question: ' ', days: 7, shareHealthData: true }, { question: 'x'.repeat(1001), days: 7, shareHealthData: true },
    { question: 'x\u0000', days: 7, shareHealthData: true }, { question: 'x', days: 90, shareHealthData: true }]) {
    assert.equal((await f.post(body)).status, 400);
  }
  assert.equal((await f.post('{', { raw: true })).status, 400);
  assert.equal((await f.post('x'.repeat(8193), { raw: true })).status, 413);
  assert.equal((await f.post(undefined, { length: '8193' })).status, 413);
  assert.equal(f.reads.length, 0); assert.equal(f.outgoing.length, 0);
});

void test('missing configuration, empty records, and exhausted quota never send health data to a model', async () => {
  const f = fixture(); f.env.MINIMAX_API_KEY = '';
  assert.equal((await f.post()).status, 503); assert.equal(f.reads.length, 0);
  f.env.MINIMAX_API_KEY = 'synthetic-test-only-key'; f.setEmpty(true);
  assert.equal((await f.post()).status, 400); assert.equal(f.quotaUsers.length, 0);
  f.setEmpty(false); f.setAllowed(false);
  const limited = await f.post(); assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '23');
  assert.equal(f.outgoing.length, 0); assert.deepEqual(f.quotaUsers, ['alice']);
});

void test('POST sends only the server-selected owner context and returns data references with a plain answer', async () => {
  const f = fixture();
  const response = await f.post({ question: '  总结这段时间  ', days: 7, shareHealthData: true }); assert.equal(response.status, 200);
  const result = await response.json() as { answer: string; sources: unknown[]; generatedAt: string; range: { days: number } };
  assert.equal(result.answer, '合成测试回答 [H3]'); assert.equal(result.range.days, 7);
  assert.ok(result.sources.length); assert.ok(Number.isFinite(Date.parse(result.generatedAt)));
  assert.equal(f.outgoing[0].question, '总结这段时间');
  const sent = JSON.stringify(f.outgoing[0]);
  for (const value of ['alice', 'bob', 'synthetic-private@example.test', 'private-record-id', 'private-source-label', f.env.MINIMAX_API_KEY]) assert.ok(!sent.includes(value));
  assert.ok(f.reads.every((entry) => entry.user === 'alice')); assert.deepEqual(f.quotaUsers, ['alice']);
});

void test('storage failures fail closed without exposing private exceptions or sending a request', async () => {
  const f = fixture(); f.setFailure(true);
  const response = await f.post(); assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('synthetic-private-storage-exception'));
  assert.equal(f.outgoing.length, 0); assert.equal(f.quotaUsers.length, 0);
});
