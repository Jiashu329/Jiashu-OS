import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import test from 'node:test';
import { buildFinanceReview, parseFinanceReviewQuery } from './finance-review.ts';
import { renderFinanceReview } from './finance-review-ui.ts';

const NOW = '2026-11-12T08:00:00.000Z';
const MONTH = '2026-10';
type UiEvent = { target: FakeElement; preventDefault(): void; key?: string; detail?: unknown; persisted?: boolean };
type Listener = (event: UiEvent) => unknown;

class FakeElement {
  readonly listeners = new Map<string, Listener[]>();
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly classList = { toggle: (_name: string, _value: boolean) => {} };
  textContent = '';
  value = '';
  hidden = false;
  disabled = false;
  required = false;
  open = false;
  tabIndex = 0;
  max = '';
  readonly id: string;
  private html = '';
  constructor(id: string) { this.id = id; }
  addEventListener(name: string, listener: Listener) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  set innerHTML(value: string) {
    this.html = value;
    if (this.id === 'review-close-versions') {
      const options = [...value.matchAll(/<option value="([^"]+)"([^>]*)>/g)];
      this.value = (options.find((option) => option[2].includes('selected')) ?? options[0])?.[1] ?? '';
    }
  }
  get innerHTML() { return this.html; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; void this.emit('close'); }
  async emit(name: string, extra: Partial<UiEvent> = {}) {
    const event = { target: this, preventDefault() {}, ...extra };
    for (const listener of this.listeners.get(name) ?? []) await listener(event);
  }
}

class FixedDate extends Date {
  constructor(input?: string | number | Date) { super(input === undefined ? NOW : input instanceof Date ? input.getTime() : input); }
}

function report(netMinor = '20000') {
  const selection = parseFinanceReviewQuery(new URLSearchParams({ ledger: 'personal', currency: 'CNY', month: MONTH }), new Date(NOW));
  return buildFinanceReview([{ accountId: 'bank', name: '储蓄账户', type: 'bank', ledger: 'personal', currency: 'CNY', archivedAt: null }], [
    { accountId: 'bank', amountMinor: '10000', asOfDate: '2026-09-30', sequence: 1 },
    { accountId: 'bank', amountMinor: netMinor, asOfDate: '2026-10-31', sequence: 2 },
  ], selection);
}

async function fixture(latestVersion = 0) {
  const html = renderFinanceReview({ standalone: true });
  const script = html.match(/<script type="module">([\s\S]*)<\/script>$/)?.[1];
  assert.ok(script);
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], new FakeElement(match[1])]));
  const el = (id: string) => {
    const found = nodes.get('review-' + id);
    assert.ok(found, 'Missing actual rendered element review-' + id);
    return found;
  };
  const root = nodes.get('monthly-review')!;
  root.dataset.reviewStandalone = 'true';
  for (const id of ['currency', 'back-link', 'ledger-personal', 'ledger-family']) nodes.set('review-' + id, new FakeElement('review-' + id));
  const tabs = [el('ledger-personal'), el('ledger-family')];
  tabs[0].dataset.reviewLedger = 'personal'; tabs[1].dataset.reviewLedger = 'family';
  const documentSurface = new FakeElement('document');
  const windowSurface = new FakeElement('window');
  const document = {
    getElementById: (id: string) => nodes.get(id) ?? null,
    querySelectorAll: (selector: string) => selector === '[data-review-ledger]' ? tabs : [],
    addEventListener: (name: string, listener: Listener) => documentSurface.addEventListener(name, listener),
    visibilityState: 'visible',
  };
  const location = { pathname: '/finance/review', search: '?ledger=personal&currency=CNY&month=' + MONTH, hash: '' };
  const history = { replaceState(_state: unknown, _title: string, path: string) {
    const url = new URL(path, 'https://synthetic.example');
    location.pathname = url.pathname; location.search = url.search; location.hash = url.hash;
  } };
  const server = { latestVersion, previewHash: 'a'.repeat(64), amount: '20000', nextPostFailure: '' };
  const versions = new Map<number, ReturnType<typeof report>>();
  for (let version = 1; version <= latestVersion; version++) versions.set(version, report(String(version * 10000)));
  const calls: { url: URL; method: string; body: Record<string, unknown> | null; key: string | null }[] = [];
  function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
  const fetch = async (path: string, options: RequestInit = {}) => {
    const url = new URL(path, 'https://synthetic.example');
    const method = options.method ?? 'GET';
    const body = typeof options.body === 'string' ? JSON.parse(options.body) as Record<string, unknown> : null;
    calls.push({ url, method, body, key: new Headers(options.headers).get('Idempotency-Key') });
    if (method === 'POST') {
      if (server.nextPostFailure) {
        const failure = server.nextPostFailure; server.nextPostFailure = '';
        if (failure === 'network') throw new Error('synthetic network interruption');
        return response({ error: '报表已经变化，请重新读取。' }, 409);
      }
      server.latestVersion++;
      versions.set(server.latestVersion, report(server.amount));
      return response({ version: server.latestVersion }, 201);
    }
    const requested = url.searchParams.get('version');
    const draft = url.searchParams.get('draft') === '1';
    const closedVersion = draft ? 0 : requested ? Number(requested) : server.latestVersion;
    const data = closedVersion ? versions.get(closedVersion)! : report(server.amount);
    return response({ ...data,
      close: { state: closedVersion ? 'closed' : 'draft', version: closedVersion,
        latestVersion: server.latestVersion, canClose: true, currentToday: NOW.slice(0, 10),
        previewHash: closedVersion ? null : server.previewHash, closedAt: NOW, reason: '',
        versions: [...versions.keys()].sort((a, b) => b - a).map((version) => ({ version, closedAt: NOW, reason: '' })) },
      decisions: { basis: 'current', asOfDate: NOW.slice(0, 10), goals: [{ name: '<旅行储蓄>', status: 'active', gapMinor: '12345', monthlyMinor: '2500' }],
        runway: { runwayMonths: '3.25', gapMinor: '10000' }, sharing: { accounts: [{ accountId: 'bank' }] } },
    });
  };
  new Script(script).runInNewContext({ document, window: windowSurface, location, history, fetch,
    Date: FixedDate, Intl, URLSearchParams, AbortController, crypto, console });
  const settle = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
  await settle();
  return { el, server, calls, documentSurface, windowSurface, settle };
}

void test('the actual review script parses and renders ended-month actions with current planning links', async () => {
  const f = await fixture();
  assert.equal(f.el('content').hidden, false);
  assert.equal(f.el('close-confirm').hidden, false);
  assert.equal(f.el('close-preview').hidden, true);
  assert.match(f.el('close-state').textContent, /未结报表/);
  assert.match(f.el('decisions').innerHTML, /不属于已结快照/);
  assert.match(f.el('decisions').innerHTML, /&lt;旅行储蓄&gt;/);
  assert.match(f.el('decisions').innerHTML, /CNY 123\.45/);
  assert.match(f.el('decisions').innerHTML, /\/finance\/goals\?/);
  assert.match(f.el('decisions').innerHTML, /\/finance\/runway\?/);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

void test('explicit confirmation posts the shown preview and then displays the immutable closed report', async () => {
  const f = await fixture();
  await f.el('close-confirm').emit('click');
  assert.equal(f.el('close-dialog').open, true);
  assert.match(f.el('close-dialog-summary').textContent, /2026年10月.*个人账本.*净资产 CNY 200\.00/);
  assert.equal(f.calls.length, 1, 'opening confirmation must never save');
  await f.el('close-form').emit('submit');
  await f.settle();
  const post = f.calls.find((call) => call.method === 'POST')!;
  assert.deepEqual(JSON.parse(JSON.stringify(post.body)), { ledger: 'personal', currency: 'CNY', month: MONTH, expectedVersion: 0, previewHash: 'a'.repeat(64), reason: '' });
  assert.ok(post.key);
  assert.equal(f.el('close-dialog').open, false);
  assert.match(f.el('close-state').textContent, /已确认月结 · 版本 1/);
  assert.equal(f.el('close-confirm').hidden, true);
  assert.equal(f.el('close-preview').hidden, false);
  assert.equal(f.calls.at(-1)?.url.searchParams.has('draft'), false);
});

void test('historical version selection and explicit reclose preview preserve the latest optimistic version', async () => {
  const f = await fixture(2);
  f.el('close-versions').value = '1'; await f.el('close-versions').emit('change'); await f.settle();
  assert.equal(f.calls.at(-1)?.url.searchParams.get('version'), '1');
  assert.match(f.el('close-state').textContent, /版本 1/);
  assert.match(f.el('stats').innerHTML, /CNY 100\.00/);
  await f.el('close-preview').emit('click'); await f.settle();
  assert.equal(f.calls.at(-1)?.url.searchParams.get('draft'), '1');
  assert.equal(f.calls.at(-1)?.url.searchParams.has('version'), false);
  await f.el('close-confirm').emit('click');
  assert.equal(f.el('close-reason').required, true);
  assert.match(f.el('close-dialog-summary').textContent, /追加版本 3/);
  await f.el('close-form').emit('submit');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  assert.match(f.el('close-dialog-error').textContent, /需填写原因/);
  f.el('close-reason').value = '补记十月末余额';
  await f.el('close-form').emit('submit'); await f.settle();
  const post = f.calls.find((call) => call.method === 'POST')!;
  assert.equal(post.body?.expectedVersion, 2); assert.equal(post.body?.reason, '补记十月末余额');
  assert.match(f.el('close-state').textContent, /版本 3/);
});

void test('an uncertain save retries the same immutable body and idempotency key', async () => {
  const f = await fixture(1);
  await f.el('close-preview').emit('click'); await f.settle();
  await f.el('close-confirm').emit('click'); f.el('close-reason').value = '更正余额';
  f.server.nextPostFailure = 'network';
  await f.el('close-form').emit('submit');
  assert.equal(f.el('close-dialog').open, true);
  assert.equal(f.el('close-reason').disabled, true);
  assert.equal(f.el('close-submit').disabled, false);
  assert.match(f.el('close-submit').textContent, /重试同次/);
  f.el('close-reason').value = 'different text cannot alter pending payload';
  await f.el('close-form').emit('submit'); await f.settle();
  const posts = f.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 2); assert.equal(posts[0].key, posts[1].key);
  assert.deepEqual(posts[0].body, posts[1].body); assert.equal(posts[1].body?.reason, '更正余额');
});

void test('a failed confirmation can be cancelled, refreshed and reopened with an editable new reason', async () => {
  const f = await fixture(1);
  await f.el('close-preview').emit('click'); await f.settle();
  await f.el('close-confirm').emit('click'); f.el('close-reason').value = '第一次说明';
  f.server.nextPostFailure = 'conflict'; await f.el('close-form').emit('submit');
  assert.match(f.el('close-dialog-error').textContent, /关闭窗口后会重新读取/);
  await f.el('close-cancel').emit('click'); await f.settle();
  await f.el('close-confirm').emit('click');
  assert.equal(f.el('close-reason').disabled, false, 'a fresh confirmation must unlock its required reason');
  assert.equal(f.el('close-reason').value, '');
});

void test('background refresh cannot replace the preview being explicitly confirmed', async () => {
  const f = await fixture();
  await f.el('close-confirm').emit('click');
  f.server.previewHash = 'b'.repeat(64); f.server.amount = '99999';
  await f.documentSurface.emit('visibilitychange'); await f.settle();
  await f.el('close-form').emit('submit'); await f.settle();
  const post = f.calls.find((call) => call.method === 'POST')!;
  assert.equal(post.body?.previewHash, 'a'.repeat(64), 'confirmation must refer to the report the user saw in the dialog');
});
