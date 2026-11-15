import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderHealthRecordsPage } from '../health-records-page.ts';
import { renderHealthRecordsScript } from './health-records-ui.ts';
import { DRAFT_GUARD_SCRIPT } from './draft-guard.ts';
import { METRIC_INFO } from './health.ts';

const DAY = '2026-11-12', NOW = Date.parse(DAY + 'T00:15:20Z');
const pendingKey = 'jiashu-health-record-operation:test-owner';
const originalRecord = { recordKey: 'weight:manual-example', metric: 'weight', day: DAY, revision: 1, deleted: false,
  manual: true, override: null, base: null, effective: { id: 'manual-example', metric: 'weight', value: 72.5, unit: 'kg',
    startDate: DAY + 'T00:00:00Z', aggregation: 'sample', source: 'manual' } };
type Call = { url: string; method: string; body: string | undefined; key: string | null; signal: AbortSignal | null | undefined };
type Transport = (call: Call) => Promise<unknown>;
async function settle(check: () => boolean) {
  for (let count = 0; count < 80 && !check(); count++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(check(), 'the page handler should settle');
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(finish => { resolve = finish; }); return { promise, resolve }; }

function fixture(options: { records?: typeof originalRecord[]; pending?: object; initialRead?: Transport } = {}) {
  const { window, document } = parseHTML(renderHealthRecordsPage('test-owner'));
  for (const select of document.querySelectorAll('select')) Object.defineProperty(select, 'value', { configurable: true, writable: true,
    value: select.querySelector('option')?.getAttribute('value') ?? '' });
  for (const form of document.querySelectorAll('form')) Object.assign(form, { reset() {
    for (const field of form.querySelectorAll('input,select,textarea')) (field as unknown as HTMLInputElement).value = field.tagName === 'SELECT'
      ? field.querySelector('option')?.getAttribute('value') ?? '' : '';
  } });
  for (const dialog of document.querySelectorAll('dialog')) {
    Object.defineProperty(dialog, 'open', { get() { return dialog.hasAttribute('open'); } });
    Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() {
      dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close'));
    } });
  }
  let elapsed = 0, timerId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  function setTimer(callback: () => void, milliseconds = 0) { const id = ++timerId; timers.set(id, { due: elapsed + milliseconds, callback }); return id; }
  function advance(milliseconds: number) {
    const until = elapsed + milliseconds;
    for (;;) {
      const next = [...timers.entries()].filter(([, item]) => item.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      timers.delete(next[0]); elapsed = next[1].due; next[1].callback();
    }
    elapsed = until;
  }
  class FixedDate extends Date { constructor(value?: string | number) { super(value === undefined ? NOW + elapsed : value); } static now() { return NOW + elapsed; } }
  const values = new Map<string, string>(); if (options.pending) values.set(pendingKey, JSON.stringify(options.pending));
  const sessionStorage = { getItem(key: string) { return values.get(key) ?? null; }, setItem(key: string, value: string) { values.set(key, value); }, removeItem(key: string) { values.delete(key); } };
  let url = new URL('https://health-fixture.example/health/records?metric=weight');
  const location = { get pathname() { return url.pathname; }, get search() { return url.search; }, get origin() { return url.origin; }, get href() { return url.href; }, assign(value: string) { url = new URL(value, url); } };
  const history = { state: null, replaceState(_value: unknown, _title: string, path: string) { url = new URL(path, url); } };
  const calls: Call[] = [], records = options.records ?? [];
  const list = () => Response.json({ records, today: DAY, hasMore: false, nextCursor: null });
  let onRead: Transport = options.initialRead ?? (async call => call.url.endsWith('/history') ? Response.json({ history: [] })
    : call.url.includes('/api/health/records/') ? Response.json({ record: records[0] }) : list());
  let onWrite: Transport = async () => Response.json({ record: originalRecord });
  Object.assign(window, { JiashuAccountSession: { request: async (path: string, init: RequestInit = {}) => {
    const call = { url: path, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined,
      key: new Headers(init.headers).get('Idempotency-Key'), signal: init.signal };
    calls.push(call); return call.method === 'GET' ? onRead(call) : onWrite(call);
  } } });
  const source = renderHealthRecordsScript('test-owner', METRIC_INFO).replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  runInNewContext(DRAFT_GUARD_SCRIPT + source, { window, document, location, history, sessionStorage,
    fetch: () => { throw new Error('The records page must use the pinned account transport'); }, URL, URLSearchParams, Intl, Date: FixedDate,
    Headers, AbortController, Event: window.Event, crypto: webcrypto, queueMicrotask, setTimeout: setTimer, clearTimeout: (id: number) => timers.delete(id) });
  const el = (id: string) => document.getElementById('records-' + id)! as unknown as HTMLInputElement;
  const click = (id: string) => el(id).dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  return { el, calls, values, document, advance, list, timers,
    read(handler: Transport) { onRead = handler; }, write(handler: Transport) { onWrite = handler; }, click,
    submit() { el('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); },
    action(name: string) { const button = el('list').querySelector('[data-record-action="' + name + '"]')!; button.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); },
    escape() { const event = new window.Event('cancel', { cancelable: true }); el('dialog').dispatchEvent(event);
      if (!event.defaultPrevented) (el('dialog') as unknown as { close(): void }).close(); return event.defaultPrevented; },
  };
}

for (const bodyHangs of [false, true]) void test(`a hanging ${bodyHangs ? 'response body' : 'fetch'} times out a health save, unlocks closing and retries only its original operation`, async () => {
  const f = fixture(); await settle(() => f.el('page').getAttribute('aria-busy') === 'false');
  const late = deferred<unknown>(); let cancelled = false;
  f.write(async () => bodyHangs ? { ok: true, status: 200, text: () => late.promise, body: { cancel: async () => { cancelled = true; } } } : late.promise);
  f.click('add'); f.el('value').value = '73.2'; f.el('reason').value = '核对体重'; f.submit();
  await settle(() => f.calls.some(call => call.method === 'POST'));
  const first = f.calls.find(call => call.method === 'POST')!, stored = f.values.get(pendingKey)!;
  assert.equal(f.el('dialog-close').disabled, true); assert.equal(f.escape(), true);
  f.advance(29999); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.el('dialog-close').disabled, true);
  f.advance(1); await settle(() => !f.el('dialog-close').disabled);
  assert.equal(first.signal?.aborted, true); if (bodyHangs) assert.equal(cancelled, true);
  assert.match(f.el('form-error').textContent ?? '', /超时.*原操作内容已固定/);
  assert.equal(f.el('value').disabled, true); assert.equal(f.el('save').textContent, '重试原操作'); assert.equal(f.el('save').disabled, false);
  assert.equal(f.values.get(pendingKey), stored); assert.equal(f.escape(), false); assert.equal(f.el('dialog').hasAttribute('open'), false);
  f.click('resume'); assert.equal(f.el('value').value, '73.2'); assert.equal(f.values.get(pendingKey), stored);
  f.write(async () => Response.json({ record: originalRecord })); f.submit();
  await settle(() => !f.values.has(pendingKey) && !f.el('dialog').hasAttribute('open') && f.el('page').getAttribute('aria-busy') === 'false');
  const writes = f.calls.filter(call => call.method === 'POST'); assert.equal(writes.length, 2);
  assert.equal(writes[1].key, first.key); assert.equal(writes[1].body, first.body, 'the original capture time and exact body remain fixed after the deadline');
  f.click('add'); f.el('value').value = '74.4';
  late.resolve(bodyHangs ? JSON.stringify({ record: { recordKey: 'late-old-result' } }) : Response.json({ record: { recordKey: 'late-old-result' } }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.el('dialog').hasAttribute('open'), true); assert.equal(f.el('value').value, '74.4'); assert.equal(f.values.has(pendingKey), false);
});

for (const bodyHangs of [false, true]) void test(`a hanging health list ${bodyHangs ? 'body' : 'fetch'} exits at twenty seconds and cannot replace a later successful read`, async () => {
  const late = deferred<unknown>();
  const f = fixture({ initialRead: async () => bodyHangs ? { ok: true, status: 200, text: () => late.promise } : late.promise });
  await settle(() => f.calls.length === 1); f.advance(20000);
  await settle(() => f.el('page').getAttribute('aria-busy') === 'false');
  assert.match(f.el('status-text').textContent ?? '', /超时/); assert.equal(f.el('retry').hidden, false); assert.equal(f.calls[0].signal?.aborted, true);
  f.read(async () => f.list()); f.click('retry'); await settle(() => f.el('status').hidden && !f.el('list').hidden);
  const content = f.el('list').innerHTML;
  late.resolve(bodyHangs ? JSON.stringify({ records: [originalRecord], today: DAY }) : Response.json({ records: [originalRecord], today: DAY }));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.el('list').innerHTML, content); assert.equal(f.calls.length, 2);
});

void test('pending correction details and modification history use the same bounded reads', async () => {
  const pending = { kind: 'correct', key: '11111111-1111-4111-8111-111111111111', recordKey: originalRecord.recordKey,
    body: { action: 'correct', expectedRevision: 1, expectedBaseExportedAt: null, value: 73.2, reason: '原更正' } };
  const f = fixture({ records: [originalRecord], pending }); await settle(() => f.el('page').getAttribute('aria-busy') === 'false');
  f.read(async () => new Promise(() => {})); f.click('resume'); await settle(() => f.calls.length === 2); f.advance(20000);
  await settle(() => !f.el('form-error').hidden); assert.match(f.el('form-error').textContent ?? '', /超时/);
  assert.equal(f.el('dialog-close').disabled, false); assert.equal(f.values.get(pendingKey), JSON.stringify(pending));
  f.click('dialog-close'); assert.equal(f.el('dialog').hasAttribute('open'), false);
  f.action('history'); await settle(() => f.calls.length === 3); f.advance(20000);
  await settle(() => f.el('history-status').textContent?.includes('超时') === true);
  assert.equal(f.el('history-close').disabled, false); f.click('history-close'); assert.equal(f.el('history-dialog').hasAttribute('open'), false);
  assert.ok(f.calls.every(call => call.method === 'GET'), 'viewing or timing out never retries the pending write automatically');
});

void test('a newer list selection cancels an ignored old transport while retaining the new result', async () => {
  const old = deferred<unknown>(), f = fixture({ initialRead: async () => old.promise }); await settle(() => f.calls.length === 1);
  f.read(async () => f.list()); f.el('metric').value = 'steps'; f.el('metric').dispatchEvent(new f.document.defaultView!.Event('change'));
  await settle(() => f.calls.length === 2 && f.el('page').getAttribute('aria-busy') === 'false');
  assert.equal(f.calls[0].signal?.aborted, true); assert.equal(f.el('metric').value, 'steps');
  old.resolve(Response.json({ records: [originalRecord], today: DAY })); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.el('list').querySelectorAll('[data-health-record]').length, 0); assert.equal(f.el('status').hidden, true);
});

void test('validation issues appear once and a sign-in failure retains the unknown original save', async () => {
  const f = fixture(); await settle(() => f.el('page').getAttribute('aria-busy') === 'false'); f.click('add'); f.el('value').value = '73.2';
  f.write(async () => Response.json({ error: '请核对记录。', code: 'INVALID_HEALTH_RECORD', issues: [{ path: 'value', message: '需要重新核对数值' }] }, { status: 422 }));
  f.submit(); await settle(() => !f.el('form-error').hidden && !f.el('dialog-close').disabled);
  assert.equal((f.el('form-error').textContent?.match(/需要重新核对数值/g) ?? []).length, 1); assert.equal(f.values.has(pendingKey), false); assert.equal(f.el('value').disabled, false);
  f.write(async () => Response.json({ error: '登录已过期。', code: 'SIGN_IN_REQUIRED' }, { status: 401 })); f.submit();
  await settle(() => f.el('form-error').querySelector('a') !== null && !f.el('dialog-close').disabled);
  assert.equal(f.el('value').disabled, true); assert.equal(f.values.has(pendingKey), true); assert.match(f.el('form-error').textContent ?? '', /登录已过期.*原操作/);
});
