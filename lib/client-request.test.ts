import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { CLIENT_REQUEST_SCRIPT } from './client-request.ts';

type BrowserRequest = (url: string, options?: RequestInit & { timeoutMs?: number }) => Promise<Record<string, unknown>>;
function fixture(fetch: (url: string, options: RequestInit) => Promise<unknown>) {
  return runInNewContext(CLIENT_REQUEST_SCRIPT + '\nrequestJSON;', { fetch, AbortController, setTimeout, clearTimeout }) as BrowserRequest;
}

test('a hanging fetch exits on its deadline, aborts it, and a user retry can succeed', async () => {
  let calls = 0; let signal: AbortSignal | null | undefined;
  const request = fixture(async (_url, options) => {
    signal = options.signal;
    if (++calls === 1) return new Promise(() => {});
    return Response.json({ ok: true });
  });
  await assert.rejects(request('/api/health', { timeoutMs: 10 }), (error: unknown) => (error as { code: string }).code === 'REQUEST_TIMEOUT');
  assert.equal(signal?.aborted, true);
  assert.equal((await request('/api/health', { timeoutMs: 100 })).ok, true);
  assert.equal(calls, 2, 'there is no automatic retry');
});

test('the deadline also bounds a response whose body never finishes', async () => {
  let signal: AbortSignal | null | undefined; let cancelled = false;
  const request = fixture(async (_url, options) => {
    signal = options.signal;
    return { ok: true, status: 200, text: () => new Promise(() => {}), body: { cancel: async () => { cancelled = true; } } };
  });
  await assert.rejects(request('/api/finance', { timeoutMs: 10 }), (error: unknown) => (error as { code: string }).code === 'REQUEST_TIMEOUT');
  assert.equal(signal?.aborted, true); assert.equal(cancelled, true);
});

test('external cancellation exits even when a transport ignores the abort signal', async () => {
  const controller = new AbortController(); let signal: AbortSignal | null | undefined;
  const request = fixture(async (_url, options) => { signal = options.signal; return new Promise(() => {}); });
  const pending = request('/api/overview', { signal: controller.signal, timeoutMs: 100 });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError');
  assert.equal(signal?.aborted, true);
});

test('a 503 preserves status and safe diagnostics for the retry UI', async () => {
  const diagnosticId = 'a'.repeat(32);
  const request = fixture(async () => Response.json({ error: '暂时不可用', code: 'HEALTH_STORAGE_UNAVAILABLE', diagnosticId }, { status: 503 }));
  await assert.rejects(request('/api/health'), (error: unknown) => {
    const value = error as Error & { status: number; code: string; diagnosticId: string };
    assert.equal(value.status, 503); assert.equal(value.code, 'HEALTH_STORAGE_UNAVAILABLE');
    assert.equal(value.diagnosticId, diagnosticId); assert.match(value.message, /诊断编号/); return true;
  });
  const untrusted = fixture(async () => Response.json({ diagnosticId: '<unsafe-value>' }, { status: 503 }));
  await assert.rejects(untrusted('/api/health'), (error: unknown) => !(error as Error).message.includes('<unsafe-value>'));
});

test('only a bounded numeric 429 retry interval reaches the explicit retry UI',async()=>{
  for(const [status,header,expected]of [[429,'37',37],[429,'86400',86400],[429,'0',undefined],[429,'86401',undefined],[429,'<unsafe>',undefined],[429,'Thu, 12 Nov 2026 12:00:00 GMT',undefined],[503,'37',undefined]] as const){
    const request=fixture(async()=>Response.json({error:'请稍后重试',code:'RATE_LIMITED'},{status,headers:{'Retry-After':header}}));
    await assert.rejects(request('/api/health/nutrition/photo'),(error:unknown)=>{assert.equal((error as {retryAfter?:number}).retryAfter,expected);return true;});
  }
});

void test('validation issues remain in the composed message without exposing a second appendable copy', async () => {
  const request = fixture(async () => Response.json({ error: '请核对记录。', code: 'INVALID_HEALTH_RECORD',
    issues: [{ path: 'value', message: '数值超出范围' }] }, { status: 422 }));
  await assert.rejects(request('/api/health/records', { method: 'POST' }), (error: unknown) => {
    const value = error as Error & { status: number; code: string };
    assert.equal(value.status, 422); assert.equal(value.code, 'INVALID_HEALTH_RECORD');
    assert.equal(Object.hasOwn(value, 'issues'), false, 'legacy callers must not append issues already included in the message');
    assert.equal(value.message, '请核对记录。 数值超出范围'); return true;
  });
});
