import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { FINANCE_PENDING_SCRIPT } from './finance-pending.ts';

type Operation = { key: string; kind: string; body: Record<string, unknown>; path: string; account: Record<string, string> | null };
type Store = { value: Operation | null; problem: string; stage(kind: string, path: string, body: Record<string, unknown>, account?: Record<string, string>): Operation; clear(): void; definiteRejection(error: unknown): boolean; matchesResult(result: unknown): boolean };
const account = { id: '11111111-1111-4111-8111-111111111111', name: '合成账户', type: 'bank', ledger: 'personal', currency: 'CNY' };
const body = { name: account.name, type: 'bank', ledger: 'personal', currency: 'CNY', amount: '100.00', asOfDate: '2026-11-11', note: '合成备注' };
const storage = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
function create(owner: string, session: ReturnType<typeof storage>, scopeKey = '') {
  return runInNewContext(FINANCE_PENDING_SCRIPT + ';createFinancePendingStore(owner,()=>session,scopeKey)', { crypto, Date, owner, session, scopeKey }) as Store;
}

void test('pending finance requests are immutable, restored with their original key, and scoped to the signed-in owner', () => {
  const session = storage(); const first = create('owner-A', session);
  const operation = first.stage('account', '/api/finance/accounts', body);
  assert.ok(Object.isFrozen(operation)); assert.ok(Object.isFrozen(operation.body));
  assert.equal(first.stage('account', '/api/finance/accounts', { ...body, name: '另一个账户' }).key, operation.key);
  const refreshed = create('owner-A', session);
  assert.equal(refreshed.value?.key, operation.key);
  assert.equal(JSON.stringify(refreshed.value?.body), JSON.stringify(operation.body));
  const otherOwner = create('owner-B', session);
  assert.equal(otherOwner.value, null); assert.equal(otherOwner.problem, '');
  refreshed.clear(); assert.equal(session.values.size, 0);
});

void test('missing owner or unavailable session persistence prevents a request from being staged', () => {
  const session = storage();
  assert.throws(() => create('', session).stage('account', '/api/finance/accounts', body), /重新登录/);
  session.setItem = () => { throw new Error('Synthetic storage blocked'); };
  const store = create('owner', session);
  assert.throws(() => store.stage('account', '/api/finance/accounts', body), /本次未发送/);
  assert.equal(store.value, null);
});

void test('network failures, deadlines, authentication and service errors remain uncertain; only explicit rejection may be cleared', () => {
  const store = create('owner', storage());
  for (const error of [{}, { code: 'REQUEST_TIMEOUT' }, { status: 401 }, { status: 429 }, { status: 503 }]) assert.equal(store.definiteRejection(error), false);
  for (const status of [400, 403, 404, 409, 413, 415, 422]) assert.equal(store.definiteRejection({ status }), true);
});

void test('successful responses must identify the original account or balance operation before local pending state can be cleared', () => {
  const session = storage(); const store = create('owner', session);
  const operation = store.stage('account', '/api/finance/accounts', body);
  assert.equal(store.matchesResult({ account: { id: account.id } }), false);
  assert.equal(store.matchesResult({ account: { id: operation.key } }), true);
  store.clear();
  const balance = store.stage('balance', '/api/finance/accounts/' + account.id + '/balances', { amount: '200', asOfDate: body.asOfDate, note: '' }, account);
  assert.equal(store.matchesResult({ account, balances: [] }), false);
  assert.equal(store.matchesResult({ account: { id: 'someone-else' }, balances: [{ id: balance.key }] }), false);
  assert.equal(store.matchesResult({ account, balances: [{ id: balance.key }] }), true);
});

void test('balance corrections and voids retain their original revisions, reason and result identity across reload', () => {
  const session = storage(); const store = create('owner', session);
  const operation = store.stage('change', '/api/finance/accounts/' + account.id + '/balances/initial%3A' + account.id, { action: 'void', expectedRevision: 0, expectedAccountRevision: 2, reason: '合成日期误录' }, account);
  const refreshed = create('owner', session);
  assert.equal(refreshed.value?.key, operation.key);
  assert.equal(refreshed.value?.body.expectedAccountRevision, 2);
  assert.equal(refreshed.matchesResult({ account, changes: [{ id: operation.key }] }), true);
  assert.equal(refreshed.matchesResult({ account, balances: [{ id: operation.key }] }), false);
});

void test('malformed stored requests never become an outbound arbitrary path or another owner request', () => {
  const session = storage(); const store = create('owner', session);
  store.stage('account', '/api/finance/accounts', body);
  const key = [...session.values.keys()][0]; const original = JSON.parse(session.values.get(key)!);
  for (const changed of [{ ...original, ownerId: 'someone-else' }, { ...original, path: 'https://other.example/accounts' }, { ...original, body: { ...original.body, apiKey: 'synthetic-forbidden-field' } }]) {
    session.values.set(key, JSON.stringify(changed)); const read = create('owner', session);
    assert.equal(read.value, null); assert.match(read.problem, /无法读取/);
    assert.throws(() => read.stage('account', '/api/finance/accounts', body), /无法读取/);
  }
});

void test('failed cleanup keeps the original operation available and prevents a new key', () => {
  const session = storage(); const store = create('owner', session);
  const original = store.stage('account', '/api/finance/accounts', body);
  session.removeItem = () => { throw new Error('Synthetic cleanup blocked'); };
  assert.throws(() => store.clear(), /未能清理/);
  assert.equal(store.value?.key, original.key);
  assert.throws(() => store.stage('account', '/api/finance/accounts', body), /未能清理/);
});

void test('shared book pending state is isolated by actor and immutable book scope, with the original URL and revision retained', () => {
  const session = storage();
  const book = '22222222-2222-4222-8222-222222222222';
  const path = '/api/finance/accounts?book=' + book + '&bookRevision=2';
  const operation = create('editor', session, book + ':2').stage('account', path, { ...body, ledger: 'family' });
  const firstKey = [...session.values.keys()][0]; const bytes = session.values.get(firstKey);
  assert.equal(create('editor', session, book + ':2').value?.path, path);
  assert.equal(create('editor', session, book + ':2').value?.key, operation.key);
  assert.equal(create('editor', session, 'other-book').value, null);
  assert.equal(create('different-editor', session, book + ':2').value, null);
  assert.equal(create('editor', session).value, null);
  assert.equal(JSON.parse(bytes!).ownerId, 'editor');
  assert.equal(session.values.get(firstKey), bytes);
  const resumed = create('editor', session, book + ':2');
  assert.equal(resumed.stage('account', '/api/finance/accounts?book=' + book + '&bookRevision=4', { ...body, ledger: 'family' }).path, path);
});

void test('default storage keys and envelopes remain byte compatible and shared correction paths retain their exact query', () => {
  const session = storage(); const legacy = create('owner', session);
  legacy.stage('account', '/api/finance/accounts', body);
  assert.equal([...session.values.keys()][0], 'jiashu-finance-pending:v1:owner');
  assert.equal(Object.hasOwn(JSON.parse([...session.values.values()][0]), 'scopeKey'), false);
  const book = '22222222-2222-4222-8222-222222222222';
  const path = '/api/finance/accounts/' + account.id + '/balances/initial%3A' + account.id + '?bookRevision=2&book=' + book;
  const scoped = create('owner', session, book + ':2');
  scoped.stage('change', path, { action: 'void', expectedRevision: 0, expectedAccountRevision: 2, reason: '原操作' }, { ...account, ledger: 'family' });
  assert.equal(create('owner', session, book + ':2').value?.path, path);
});

void test('book paths reject unknown, duplicate, partial or unsafe query fields and preserve pending on revoked or changed access', () => {
  const book = '22222222-2222-4222-8222-222222222222';
  for (const query of [
    '?ownerId=someone', '?book=' + book, '?bookRevision=2', '?book=' + book + '&bookRevision=-1',
    '?book=' + book + '&bookRevision=9007199254740992', '?book=' + book + '&bookRevision=2&ledger=family',
    '?book=' + book + '&book=' + book, '?book=' + book + '&bookRevision=2#ignored',
    '?book=wrong&bookRevision=2', '?book=' + book + '&bookRevision=2?more',
  ]) assert.throws(() => create('editor', storage(), book + ':2').stage('account', '/api/finance/accounts' + query, { ...body, ledger: 'family' }), /无法读取/);
  const session = storage(); const store = create('editor', session, book + ':2');
  const staged = store.stage('balance', '/api/finance/accounts/' + account.id + '/balances?book=' + book + '&bookRevision=2', { amount: '1', asOfDate: body.asOfDate, note: '' }, { ...account, ledger: 'family' });
  const original = [...session.values.values()][0];
  assert.equal(store.definiteRejection({ status: 403, code: 'FINANCE_BOOK_ACCESS_REVOKED' }), false);
  assert.equal(store.definiteRejection({ status: 409, code: 'FINANCE_BOOK_ACCESS_CHANGED' }), false);
  assert.equal(store.definiteRejection({ status: 409, code: 'FINANCE_BOOK_OPERATION_CONFLICT' }), true);
  assert.equal(store.value?.key, staged.key); assert.equal([...session.values.values()][0], original);
});

void test('shared staging injects the original book revision automatically and refuses explicitly different targets', () => {
  const book = '22222222-2222-4222-8222-222222222222';
  const other = '33333333-3333-4333-8333-333333333333';
  const session = storage();
  const operation = create('editor', session, book + ':2').stage('balance', '/api/finance/accounts/' + account.id + '/balances', { amount: '1', asOfDate: body.asOfDate, note: '' }, { ...account, ledger: 'family' });
  assert.equal(operation.path, '/api/finance/accounts/' + account.id + '/balances?book=' + book + '&bookRevision=2');
  for (const path of ['/api/finance/accounts?book=' + other + '&bookRevision=2', '/api/finance/accounts?book=' + book + '&bookRevision=3']) {
    assert.throws(() => create('editor', storage(), book + ':2').stage('account', path, { ...body, ledger: 'family' }), /无法读取/);
  }
  for (const scope of [book, book + ':missing', book + ':', book + ':9007199254740992']) {
    assert.throws(() => create('editor', storage(), scope).stage('account', '/api/finance/accounts', { ...body, ledger: 'family' }), /无法读取/);
  }
  const owner = create('owner', storage(), book + ':0').stage('account', '/api/finance/accounts', { ...body, ledger: 'family' });
  assert.equal(owner.path, '/api/finance/accounts?book=' + book + '&bookRevision=0');
});
