import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import test from 'node:test';
import { renderApp } from '../ui.ts';
import { buildSyncDiagnostics } from './sync-diagnostics.ts';
import type { HealthMeasurement, HealthSyncPayload } from './health.ts';

const NOW = '2026-11-12T02:00:00.000Z';
type UiEvent = { target: FakeElement; preventDefault(): void; persisted?: boolean; key?: string };
type Listener = (event: UiEvent) => unknown;

class FakeElement {
  readonly listeners = new Map<string, Listener[]>();
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    toggle: (name: string, value: boolean) => { if (value) this.classes.add(name); else this.classes.delete(name); },
  };
  textContent = '';
  innerHTML = '';
  value = '';
  href = '';
  hidden = false;
  disabled = false;
  open = false;
  isConnected = true;
  clientWidth = 800;
  dateTime = '';
  parentElement: { hidden: boolean } = { hidden: false };
  dialog: FakeElement | null = null;
  children: FakeElement[] = [];
  readonly id: string;
  constructor(id: string) { this.id = id; }
  addEventListener(name: string, listener: Listener) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  querySelectorAll(selector: string) { return selector === '[data-close-dialog]' ? this.children : []; }
  querySelector(_selector: string) { return null; }
  closest(selector: string) { return selector === 'dialog' ? this.dialog : null; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; void this.emit('close'); }
  dispatchEvent(event: Event) { void this.emit(event.type); return true; }
  async emit(name: string, extra: Partial<UiEvent> = {}) {
    const event = { target: this, preventDefault() {}, ...extra };
    for (const listener of this.listeners.get(name) ?? []) await listener(event);
  }
}

class FixedDate extends Date {
  constructor(input?: string | number | Date) { super(input === undefined ? NOW : input instanceof Date ? input.getTime() : input); }
  static override now() { return Date.parse(NOW); }
}

function payload(): HealthSyncPayload {
  return { version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt: NOW,
    measurements: [{ id: 'synthetic-step', metric: 'steps', value: 1234, unit: 'count', aggregation: 'daily', startDate: '2026-11-12T01:00:00.000Z' }] };
}
function diagnostics(measurements: HealthMeasurement[] = payload().measurements, empty = false) {
  return buildSyncDiagnostics([...measurements, { id: 'synthetic-weight', metric: 'weight', value: 65, unit: 'kg', startDate: '2026-10-01T01:00:00.000Z' }], [
    { scope: 'batch', receivedAt: NOW, exportedAt: NOW, submittedCount: empty ? 0 : measurements.length, importedCount: empty ? 0 : measurements.length, skippedCount: 0,
      firstDay: empty ? null : '2026-11-12', lastDay: empty ? null : '2026-11-12' },
    { scope: 'steps', receivedAt: NOW, exportedAt: NOW, submittedCount: 1, importedCount: null, skippedCount: null, firstDay: '2026-11-12', lastDay: '2026-11-12' },
  ], NOW);
}

async function fixture(options: { empty?: boolean; holdInitialStatus?: boolean; handoff?: boolean; importFailure?: string } = {}) {
  const html = renderApp();
  const script = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].at(-1)?.[1];
  assert.ok(script);
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"([^>]*)>/g)].map((match) => {
    const node = new FakeElement(match[1]);
    node.hidden = /\bhidden(?:\s|$)/.test(match[2]);
    node.href = match[2].match(/href="([^"]+)"/)?.[1] ?? '';
    return [match[1], node] as const;
  }));
  const el = (id: string) => { const node = nodes.get(id); assert.ok(node, 'Missing actual rendered element ' + id); return node; };
  const openImport = new FakeElement('open-import');
  const fileLabel = new FakeElement('file-label');
  const closeButtons = ['import', 'setup'].map((name) => {
    const button = new FakeElement('close-' + name); button.dialog = el(name + '-dialog'); button.dialog.children.push(button); return button;
  });
  const documentSurface = new FakeElement('document');
  const windowSurface = new FakeElement('window');
  const document = {
    getElementById: (id: string) => nodes.get(id) ?? null,
    querySelectorAll: (selector: string) => selector === '[data-open-import]' ? [openImport]
      : selector === '[data-close-dialog]' ? closeButtons
      : selector === 'dialog:not([data-goal-dialog])' ? [el('import-dialog'), el('setup-dialog')] : [],
    querySelector: (selector: string) => selector === 'label[for="import-file"]' ? fileLabel
      : selector === '[data-open-import]' ? openImport
      : selector === 'dialog[open]' ? [el('import-dialog'), el('setup-dialog')].find((dialog) => dialog.open) ?? null : null,
    addEventListener: (name: string, listener: Listener) => documentSurface.addEventListener(name, listener),
    visibilityState: 'visible', documentElement: new FakeElement('html'), activeElement: openImport,
  };
  const location = { pathname: '/sync', search: '', hash: options.handoff ? '#device=jso_sync_' + 'a'.repeat(43) + '&payload=' + encodeURIComponent(JSON.stringify(payload())) : '', origin: 'https://synthetic-sync.example' };
  const history = { replaceState(_state: unknown, _title: string, path: string) {
    const url = new URL(path, location.origin); location.pathname = url.pathname; location.search = url.search; location.hash = url.hash;
  } };
  const server = { data: diagnostics(undefined, options.empty), nextImportFailure: options.importFailure ?? '', nextStatusFailure: false, statusCalls: 0 };
  const calls: { path: string; method: string; body: string | null; device: string | null }[] = [];
  let firstImportStarted: () => void = () => {};
  const firstImport = new Promise<void>((resolve) => { firstImportStarted = resolve; });
  let resolveInitialStatus: ((value: Response) => void) | undefined;
  const initialStatus = options.holdInitialStatus ? new Promise<Response>((resolve) => { resolveInitialStatus = resolve; }) : null;
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (path: string, init: RequestInit = {}) => {
    calls.push({ path, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : null, device: new Headers(init.headers).get('X-Sync-Device') });
    if (path === '/api/sync/status') {
      server.statusCalls++;
      if (server.statusCalls === 1 && initialStatus) return initialStatus;
      if (server.nextStatusFailure) { server.nextStatusFailure = false; return response({ error: '同步结果暂不可用' }, 503); }
      return response(server.data);
    }
    if (path.startsWith('/api/health?')) return response({ measurements: [], lastSync: null });
    if (path === '/api/health/import') {
      firstImportStarted();
      const failure = server.nextImportFailure; server.nextImportFailure = '';
      if (failure === 'network') throw new Error('synthetic interrupted connection');
      if (failure === '401') return response({ error: '请先登录', code: 'SIGN_IN_REQUIRED' }, 401);
      if (failure === 'revoked') return response({ error: '同步连接已撤销', code: 'SYNC_DEVICE_INVALID' }, 403);
      return response({ ok: true, imported: 1, skipped: 0, lastSync: NOW });
    }
    throw new Error('Unexpected endpoint ' + path);
  };
  const timers: Array<() => unknown> = [];
  new Script(script).runInNewContext({ document, window: windowSurface, location, history, fetch, Date: FixedDate, Intl, URLSearchParams, URL,
    crypto, TextEncoder, Error, Event, console, navigator: {},
    setTimeout: (callback: () => unknown, delay: number) => { if (delay === 0) timers.push(callback); return 1; }, clearTimeout() {},
  });
  const settle = async () => { for (let index = 0; index < 4; index++) { while (timers.length) timers.shift()!(); await new Promise<void>((resolve) => setImmediate(resolve)); } };
  await settle();
  return { el, openImport, closeImport: closeButtons[0], server, calls, settle, documentSurface, firstImport,
    releaseInitialStatus(data = diagnostics([], true)) { assert.ok(resolveInitialStatus); resolveInitialStatus(response(data)); },
  };
}

void test('the actual sync script distinguishes five metric dates from an empty latest batch', async () => {
  const f = await fixture({ empty: true });
  const rows = f.el('sync-diagnostics-rows').innerHTML;
  assert.equal((rows.match(/<tr>/g) ?? []).length, 5);
  assert.match(rows, /步数<\/th><td>2026-11-12/);
  assert.match(rows, /体重<\/th><td>2026-10-01.*?记录较早/);
  assert.match(rows, /睡眠<\/th><td>—.*?暂无有效记录/);
  assert.match(f.el('sync-batch-summary').textContent, /本次为空批次，没有更新任何指标/);
  assert.equal(f.el('sync-diagnostics-refresh').disabled, false);
});

void test('an unavailable diagnostics refresh clears the displayed result and can recover', async () => {
  const f = await fixture();
  f.server.nextStatusFailure = true;
  await f.el('sync-diagnostics-refresh').emit('click');
  assert.equal(f.el('sync-batch-summary').hidden, true);
  assert.match(f.el('sync-diagnostics-rows').innerHTML, /暂时无法核对/);
  assert.ok(f.el('sync-diagnostics-status').classes.has('error'));
  assert.equal(f.el('sync-diagnostics-refresh').disabled, false);
  await f.el('sync-diagnostics-refresh').emit('click');
  assert.match(f.el('sync-diagnostics-rows').innerHTML, /2026-11-12/);
  assert.equal(f.el('sync-diagnostics-status').classes.has('error'), false);
});

void test('an uncertain import preserves its in-memory JSON and offers result verification before retry', async () => {
  const f = await fixture(); await f.openImport.emit('click');
  const json = JSON.stringify(payload()); f.el('import-json').value = json; f.server.nextImportFailure = 'network';
  await f.el('import-form').emit('submit'); await f.settle();
  assert.equal(f.el('import-json').value, json);
  assert.equal(f.el('import-dialog').open, true);
  assert.equal(f.el('import-json').disabled, false);
  assert.equal(f.el('import-submit').disabled, false);
  assert.match(f.el('import-error').textContent, /导入结果暂未确认.*刷新同步结果/);
  assert.equal(f.el('import-recovery').hidden, true);
});

void test('a signed-out import preserves its draft and successful retry refreshes diagnostics', async () => {
  const f = await fixture(); await f.openImport.emit('click');
  const json = JSON.stringify(payload()); f.el('import-json').value = json; f.server.nextImportFailure = '401';
  await f.el('import-form').emit('submit'); await f.settle();
  assert.equal(f.el('import-json').value, json);
  assert.equal(f.el('import-recovery').hidden, false);
  assert.match(f.el('import-error').textContent, /同一个 Safari 重新登录/);
  const before = f.server.statusCalls;
  await f.el('import-form').emit('submit'); await f.settle();
  assert.equal(f.el('import-dialog').open, false);
  assert.equal(f.el('import-json').value, '');
  assert.ok(f.server.statusCalls > before);
});

void test('a successful import waits out an older status request and then fetches a fresh result', async () => {
  const f = await fixture({ holdInitialStatus: true });
  await f.openImport.emit('click'); f.el('import-json').value = JSON.stringify(payload());
  await f.el('import-form').emit('submit'); await f.settle();
  assert.equal(f.server.statusCalls, 1);
  f.releaseInitialStatus(); await f.settle();
  assert.equal(f.server.statusCalls, 2);
  assert.match(f.el('sync-diagnostics-rows').innerHTML, /步数<\/th><td>2026-11-12/);
  assert.doesNotMatch(f.el('sync-batch-summary').textContent, /本次为空批次/);
});

void test('a revoked handoff retains its draft and requires an explicit manual confirmation without reusing the revoked key', async () => {
  const f = await fixture({ handoff: true, importFailure: 'revoked' });
  await f.firstImport;
  await f.settle();
  const imports = () => f.calls.filter((call) => call.path === '/api/health/import');
  assert.equal(imports().length, 1);
  assert.ok(imports()[0].device);
  assert.equal(f.el('import-dialog').open, true);
  assert.equal(f.el('import-json').value, JSON.stringify(payload()));
  assert.match(f.el('import-error').textContent, /重新生成地址.*手动确认导入/);
  await f.el('import-form').emit('submit'); await f.settle();
  assert.equal(imports().length, 2);
  assert.equal(imports()[1].device, null);
  assert.equal(f.el('import-dialog').open, false);
});
