import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { parseHTML } from 'linkedom';
import { renderApp } from '../ui.ts';
import { buildSyncDiagnostics } from './sync-diagnostics.ts';
import type { HealthSyncPayload } from './health.ts';

const NOW = '2026-11-12T02:00:00.000Z';
const payload: HealthSyncPayload = { version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt: NOW,
  measurements: [{ id: 'synthetic-step', metric: 'steps', value: 1234, unit: 'count', aggregation: 'daily', startDate: '2026-11-12T01:00:00.000Z' }] };
function diagnostics(empty = false) {
  const coverage = buildSyncDiagnostics([...payload.measurements,
    { id: 'synthetic-weight', metric: 'weight', value: 65, unit: 'kg', startDate: '2026-10-01T01:00:00.000Z' }], [
    { scope: 'batch', receivedAt: NOW, exportedAt: NOW, submittedCount: empty ? 0 : 1, importedCount: empty ? 0 : 1, skippedCount: 0,
      firstDay: empty ? null : '2026-11-12', lastDay: empty ? null : '2026-11-12' },
  ], NOW);
  return { batches: [], attempts: [], lastImport: coverage.lastImport,
    metricStatus: coverage.metrics.map((row) => ({ ...row, lastRecordDate: row.latestDay, lastReceivedAt: null, lastAttemptAt: null })) };
}
async function settled(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.ok(check(), 'Merged synchronization UI did not settle');
}
function fixture(t: TestContext, options: { empty?: boolean; holdInitialStatus?: boolean; handoff?: boolean; failure?: string } = {}) {
  const { window, document } = parseHTML(renderApp());
  let url = new URL('https://synthetic-sync.example/sync' + (options.handoff ? '#device=jso_sync_' + 'a'.repeat(43) + '&payload=' + encodeURIComponent(JSON.stringify(payload)) : ''));
  const location = { get origin() { return url.origin; }, get pathname() { return url.pathname; }, get search() { return url.search; }, get hash() { return url.hash; }, get href() { return url.href; } };
  const history = { state: null, replaceState(_state: unknown, _title: string, path: string) { url = new URL(path, url); }, pushState(_state: unknown, _title: string, path: string) { url = new URL(path, url); } };
  for (const dialog of document.querySelectorAll('dialog')) Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); } });
  const calls: { path: string; method: string; device: string | null; preview: string | null }[] = [];
  const server = { statusCalls: 0, failure: options.failure ?? '', failStatus: false };
  let release: ((response: Response) => void) | undefined;
  const initial = options.holdInitialStatus ? new Promise<Response>((resolve) => { release = resolve; }) : null;
  const fetch = async (path: string, init: RequestInit = {}) => {
    calls.push({ path, method: init.method ?? 'GET', device: new Headers(init.headers).get('X-Sync-Device'), preview: new Headers(init.headers).get('X-Import-Preview') });
    if (path.startsWith('/api/health?')) return Response.json({ measurements: [], lastSync: null });
    if (path === '/api/health/import/preview' && server.failure === 'format') return Response.json({ error: '数据格式不正确。', code: 'INVALID_HEALTH_SYNC' }, { status: 400 });
    if (path === '/api/health/import/preview') return Response.json({ preview: { token: 'a'.repeat(64), added: 1, updated: 0, skipped: 0, sourceChanges: 0, manualOverrides: 0, from: '2026-11-12', to: '2026-11-12', metrics: ['步数'], examples: [] } });
    if (path === '/api/health/import' && init.method === 'POST') {
      const failure = server.failure; server.failure = '';
      if (failure === 'network') throw new Error('synthetic interrupted connection');
      if (failure === '401') return Response.json({ error: '请先登录', code: 'SIGN_IN_REQUIRED' }, { status: 401 });
      if (failure === 'revoked') return Response.json({ error: '同步连接已撤销', code: 'SYNC_DEVICE_INVALID' }, { status: 403 });
      if (failure === 'format') return Response.json({ error: '第 2 段的睡眠状态无法识别。', code: 'INVALID_HEALTH_SYNC',
        issues: [{ path: 'sleepReport.segments[1].state', message: 'Expected a recognized Apple sleep state' },
          { path: 'sleepReport.segments[2].state', message: 'Expected a recognized Apple sleep state' }] }, { status: 400 });
      return Response.json({ ok: true, imported: 1, skipped: 0, lastSync: NOW });
    }
    if (path === '/api/health/import') {
      server.statusCalls++;
      if (server.statusCalls === 1 && initial) return initial;
      if (server.failStatus) { server.failStatus = false; return Response.json({ error: '同步结果暂不可用' }, { status: 503 }); }
      return Response.json(diagnostics(options.empty));
    }
    throw new Error('Unexpected endpoint ' + path);
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  t.after(() => timers.forEach(clearTimeout));
  const script = [...document.querySelectorAll('script')].at(-1)!.textContent!;
  runInNewContext(script, { document, window, location, history, fetch, Date, Intl, URLSearchParams, URL, crypto: webcrypto,
    TextEncoder, AbortController, Event: window.Event, console, navigator: {}, requestAnimationFrame(callback: () => void) { callback(); return 0; },
    setTimeout(callback: () => void, milliseconds: number) { const timer = setTimeout(callback, milliseconds); timers.add(timer); return timer; }, clearTimeout });
  const el = (id: string) => { const node = document.getElementById(id); assert.ok(node, 'Missing rendered element ' + id); return node; };
  const click = (selector: string) => { const node = document.querySelector(selector); assert.ok(node); node.dispatchEvent(new window.Event('click', { bubbles: true })); };
  const submit = async () => { el('import-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settled(() => !(el('import-submit') as HTMLButtonElement).disabled); };
  const draft = async () => { click('[data-open-import]'); (el('import-json') as HTMLTextAreaElement).value = JSON.stringify(payload); await submit(); assert.equal(el('import-preview').hidden, false); };
  return { el, document, click, submit, draft, calls, server,
    releaseInitialStatus() { assert.ok(release); release(Response.json(diagnostics(true))); } };
}

void test('the merged sync script distinguishes five effective metric dates and coverage from an empty latest batch', async (t) => {
  const f = fixture(t, { empty: true }); await settled(() => f.document.querySelectorAll('[data-sync-metric]').length === 5);
  const steps = f.document.querySelector('[data-sync-metric="steps"]')!.textContent!;
  assert.match(steps, /2026-11-12/); assert.match(steps, /近7天 1 \/ 7 天；近30天 1 \/ 30 天/);
  assert.match(f.document.querySelector('[data-sync-metric="weight"]')!.textContent!, /2026-10-01/);
  assert.match(f.document.querySelector('[data-sync-metric="sleep"]')!.textContent!, /暂无记录/);
  assert.match(f.el('sync-batch-summary').textContent!, /本次为空批次，没有更新任何指标/);
  assert.ok(f.document.querySelector('a[href="/backup"]'));
});

void test('an unavailable diagnostics refresh keeps its prior scope explicit and can recover', async (t) => {
  const f = fixture(t); await settled(() => !f.el('sync-batch-summary').hidden);
  f.server.failStatus = true; f.click('#refresh-sync-diagnostics'); await settled(() => !f.el('sync-diagnostics-error').hidden);
  assert.match(f.el('sync-diagnostics-error').textContent!, /刷新结果重试/);
  assert.equal((f.el('refresh-sync-diagnostics') as HTMLButtonElement).disabled, false);
  assert.equal(f.document.querySelectorAll('[data-sync-metric]').length, 5);
  f.click('#refresh-sync-diagnostics'); await settled(() => Boolean(f.el('sync-diagnostics-error').hidden));
});

void test('an uncertain confirmed import preserves JSON and offers verification before retry', async (t) => {
  const f = fixture(t); await f.draft(); f.server.failure = 'network'; await f.submit();
  assert.equal((f.el('import-json') as HTMLTextAreaElement).value, JSON.stringify(payload));
  assert.equal(f.el('import-dialog').hasAttribute('open'), true);
  assert.equal((f.el('import-json') as HTMLTextAreaElement).disabled, false);
  assert.match(f.el('import-error').textContent!, /导入结果暂未确认.*刷新同步结果/);
  assert.equal(f.el('import-recovery').hidden, true);
});

void test('a signed-out import keeps its preview and draft until an explicit successful retry', async (t) => {
  const f = fixture(t); await f.draft(); f.server.failure = '401'; await f.submit();
  assert.equal((f.el('import-json') as HTMLTextAreaElement).value, JSON.stringify(payload));
  assert.equal(f.el('import-recovery').hidden, false);
  assert.match(f.el('import-error').textContent!, /同一个 Safari 重新登录/);
  const before = f.server.statusCalls; await f.submit();
  await settled(() => !f.el('import-dialog').hasAttribute('open') && f.server.statusCalls > before);
  assert.equal((f.el('import-json') as HTMLTextAreaElement).value, '');
});

void test('an older diagnostic GET cannot replace the result refreshed after a confirmed import', async (t) => {
  const f = fixture(t, { holdInitialStatus: true }); await f.draft(); await f.submit();
  await settled(() => f.server.statusCalls >= 2 && !f.el('sync-batch-summary').hidden);
  assert.doesNotMatch(f.el('sync-batch-summary').textContent!, /本次为空批次/);
  f.releaseInitialStatus(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.doesNotMatch(f.el('sync-batch-summary').textContent!, /本次为空批次/);
});

void test('a revoked handoff requires preview and explicit manual confirmation without reusing its key', async (t) => {
  const f = fixture(t, { handoff: true, failure: 'revoked' });
  await settled(() => !f.el('import-error').hidden);
  const imports = () => f.calls.filter((call) => call.path === '/api/health/import' && call.method === 'POST');
  assert.equal(imports().length, 1); assert.ok(imports()[0].device);
  assert.equal((f.el('import-json') as HTMLTextAreaElement).value, JSON.stringify(payload));
  assert.match(f.el('import-error').textContent!, /重新生成同步连接.*手动确认/);
  await f.submit(); assert.equal(imports().length, 1); assert.equal(f.el('import-preview').hidden, false);
  await f.submit(); assert.equal(imports().length, 2); assert.equal(imports()[1].device, null); assert.equal(imports()[1].preview, 'a'.repeat(64));
});

void test('invalid automatic sleep data preserves its draft and asks for corrected input without suggesting confirmation', async (t) => {
  const f = fixture(t, { handoff: true, failure: 'format' });
  await settled(() => !f.el('import-error').hidden);
  const message = f.el('import-error').textContent!;
  assert.match(message, /第 2 段的睡眠状态无法识别/);
  assert.equal(message.match(/Expected a recognized Apple sleep state/g)?.length, 1);
  assert.match(message, /本次未导入。请修正快捷指令或导入文件后重试/);
  assert.doesNotMatch(message, /手动确认|自动同步未确认/);
  assert.equal((f.el('import-json') as HTMLTextAreaElement).value, JSON.stringify(payload));
  assert.equal(f.el('import-preview').hidden, true);
  assert.equal(f.el('import-recovery').hidden, true);
  assert.equal(f.calls.filter(call => call.path === '/api/health/import' && call.method === 'POST').length, 1);
});

void test('invalid manual previews request corrected input and never reach the import endpoint', async (t) => {
  const f = fixture(t, { failure: 'format' });
  f.click('[data-open-import]'); (f.el('import-json') as HTMLTextAreaElement).value = JSON.stringify(payload);
  await f.submit();
  assert.match(f.el('import-error').textContent!, /数据格式不正确.*请修正快捷指令或导入文件后重试/);
  assert.equal(f.el('import-preview').hidden, true);
  assert.equal((f.el('import-json') as HTMLTextAreaElement).value, JSON.stringify(payload));
  assert.equal(f.calls.filter(call => call.path === '/api/health/import' && call.method === 'POST').length, 0);
});
