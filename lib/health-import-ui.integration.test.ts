import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderApp } from '../ui.ts';

async function settled(check: () => boolean) {
  for (let index = 0; index < 80; index++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.ok(check(), 'Import UI did not settle');
}
function fixture(t: TestContext, options: { automatic?: boolean; stale?: boolean; fragment?: string } = {}) {
  const { window, document } = parseHTML(renderApp());
  let url = new URL('https://synthetic-import.example/sync' + (options.fragment ?? (options.automatic ? '#device=jso_sync_' + 'a'.repeat(43) + '&payload=' + encodeURIComponent(JSON.stringify({ version: 1, measurements: [] })) : '')));
  const location = { get origin() { return url.origin; }, get pathname() { return url.pathname; }, get search() { return url.search; }, get hash() { return url.hash; }, get href() { return url.href; } };
  const history = { state: null, replaceState(_state: unknown, _title: string, path: string) { url = new URL(path, url); }, pushState(_state: unknown, _title: string, path: string) { url = new URL(path, url); } };
  for (const dialog of document.querySelectorAll('dialog')) Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); } });
  for (const form of document.querySelectorAll('form')) Object.assign(form, { reset() { form.querySelectorAll('input,textarea').forEach((node) => { (node as unknown as { value: string }).value = ''; }); } });
  const requests: Array<{ path: string; options: RequestInit }> = [];
  let committed = 0, reverted = false, conflict = options.stale;
  const preview = { token: 'a'.repeat(64), added: 0, updated: 1, skipped: 0, sourceChanges: 1, manualOverrides: 1,
    from: '2026-11-09', to: '2026-11-09', metrics: ['步数'], examples: [{ day: '2026-11-09', metric: '步数', action: '更新', before: 4000, after: 5000, oldSource: 'watch', newSource: '<script>unsafe</script>', reason: '来源变化，需确认' }] };
  const fetch = async (path: string, init: RequestInit = {}) => {
    requests.push({ path, options: init });
    if (path.startsWith('/api/health?')) return Response.json({ measurements: [], lastSync: null });
    if (path === '/api/health/import/preview') return Response.json({ preview });
    if (path === '/api/health/import' && init.method === 'POST') {
      if (init.headers && (init.headers as Record<string, string>)['X-Sync-Device']) return Response.json({ code: 'HEALTH_IMPORT_SOURCE_CONFIRMATION', error: '请确认来源变化' }, { status: 409 });
      if (conflict) { conflict = false; return Response.json({ code: 'HEALTH_IMPORT_STALE', error: '预览过期' }, { status: 409 }); }
      committed++; return Response.json({ imported: 1, skipped: 0 });
    }
    if (path === '/api/health/import') return Response.json({ batches: [{ batchId: 'b'.repeat(64), createdAt: '2026-11-09T10:00:00Z', imported: 1, skipped: 0, summary: { metrics: ['步数'], from: '2026-11-09', to: '2026-11-09' }, canRevert: true, revertedAt: reverted ? '2026-11-09T11:00:00Z' : null, revertReason: reverted ? '选错来源' : null }] });
    if (path.endsWith('/revert')) { reverted = true; return Response.json({ ok: true }); }
    throw new Error('Unexpected import request ' + path);
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  t.after(() => timers.forEach(clearTimeout));
  const script = [...document.querySelectorAll('script')].at(-1)!.textContent!;
  runInNewContext(script, { window, document, location, history, navigator: {}, fetch, URL, URLSearchParams, TextEncoder, AbortController, crypto: webcrypto, Intl, Date, Event: window.Event,
    setTimeout(callback: () => void, ms: number) { const id = setTimeout(callback, ms); timers.add(id); return id; }, clearTimeout, requestAnimationFrame(callback: () => void) { callback(); return 0; } });
  const el = (id: string) => document.getElementById(id)! as HTMLElement & { value: string; checked: boolean; disabled: boolean };
  const click = (selector: string) => document.querySelector(selector)!.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  const submit = (id: string) => el(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return { document, requests, el, click, submit, get committed() { return committed; }, get reverted() { return reverted; } };
}

test('manual import previews first, escapes sources and requires explicit source confirmation', async (t) => {
  const f = fixture(t);
  f.click('[data-open-import]'); f.el('import-json').value = '{"version":1,"measurements":[]}';
  f.submit('import-form'); await settled(() => !f.el('import-submit').disabled);
  assert.equal(f.committed, 0); assert.equal(f.el('import-preview').hidden, false);
  assert.match(f.el('import-preview-summary').textContent ?? '', /保留手工更正／屏蔽 1 条/);
  assert.equal(f.el('import-preview-examples').querySelector('script'), null);
  assert.equal(f.el('import-source-confirm-row').hidden, false);
  f.submit('import-form'); await settled(() => !f.el('import-submit').disabled);
  assert.equal(f.committed, 0); assert.match(f.el('import-error').textContent ?? '', /勾选确认/);
  f.el('import-source-confirm').checked = true; f.submit('import-form');
  await settled(() => f.committed === 1 && !f.el('import-submit').disabled);
  const post = f.requests.find((row) => row.path === '/api/health/import' && row.options.method === 'POST')!;
  assert.equal((post.options.headers as Record<string, string>)['X-Import-Preview'], 'a'.repeat(64));
  assert.equal((post.options.headers as Record<string, string>)['X-Confirm-Source-Changes'], 'true');
});

test('stale confirmation refreshes the preview without automatically resubmitting', async (t) => {
  const f = fixture(t, { stale: true });
  f.click('[data-open-import]'); f.el('import-json').value = '{}';
  f.submit('import-form'); await settled(() => !f.el('import-submit').disabled);
  f.el('import-source-confirm').checked = true; f.submit('import-form');
  await settled(() => !f.el('import-submit').disabled);
  assert.equal(f.committed, 0); assert.equal(f.el('import-source-confirm').checked, false);
  assert.match(f.el('import-error').textContent ?? '', /重新预览/);
  assert.equal(f.requests.filter((row) => row.path === '/api/health/import' && row.options.method === 'POST').length, 1);
});

test('automatic source switch stops for human confirmation and recent imports can be reverted with a reason', async (t) => {
  const f = fixture(t, { automatic: true });
  await settled(() => !f.el('import-submit').disabled && !f.el('import-preview').hidden);
  assert.equal(f.committed, 0); assert.equal(f.el('import-source-confirm').checked, false);
  f.click('#load-import-history'); await settled(() => !!f.document.querySelector('[data-revert-import]'));
  f.click('[data-revert-import]'); f.el('import-revert-reason').value = '选错来源'; f.submit('import-revert-form');
  await settled(() => f.reverted && f.el('import-history').textContent?.includes('已回退') === true);
  assert.equal(f.document.querySelector('[data-revert-import]'), null);
  const post = f.requests.find((row) => row.path.endsWith('/revert'))!;
  assert.deepEqual(JSON.parse(post.options.body as string), { reason: '选错来源' });
});

test('native HealthKit totals use the existing manual preview and source-change confirmation flow', async (t) => {
  const payload = { version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt: '2026-11-16T00:04:40.000Z',
    measurements: [{ id: 'healthkit-merged-steps:2026-11-13', metric: 'steps', value: 8462, unit: 'count', source: 'apple-health-merged', aggregation: 'daily',
      startDate: '2026-11-12T16:00:00.000Z', endDate: '2026-11-13T16:00:00.000Z' }] };
  const params = new URLSearchParams({ payload: JSON.stringify(payload) });
  const f = fixture(t, { fragment: '#' + params });
  await settled(() => f.el('import-dialog').hasAttribute('open'));
  assert.equal(f.requests.some((row) => row.path.startsWith('/api/health/import') && row.options.method === 'POST'), false);
  f.submit('import-form');
  await settled(() => !f.el('import-submit').disabled);
  assert.equal(f.requests.filter((row) => row.path === '/api/health/import/preview').length, 1);
  assert.equal(f.committed, 0);
  f.submit('import-form');
  await settled(() => !f.el('import-submit').disabled);
  assert.equal(f.committed, 0, 'an existing source change still needs explicit confirmation');
  f.el('import-source-confirm').checked = true;
  f.submit('import-form');
  await settled(() => f.committed === 1 && !f.el('import-submit').disabled);
  const request = f.requests.find((row) => row.path === '/api/health/import' && row.options.method === 'POST')!;
  const headers = request.options.headers as Record<string, string>;
  assert.equal(headers['X-Sync-Device'], undefined);
  assert.equal(headers['X-Import-Preview'], 'a'.repeat(64));
  assert.equal(headers['X-Confirm-Source-Changes'], 'true');
  assert.deepEqual(JSON.parse(request.options.body as string), payload);
});
