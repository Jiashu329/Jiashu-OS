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
function create(owner: string, session: ReturnType<typeof storage>) {
  return runInNewContext(FINANCE_PENDING_SCRIPT + ';createFinancePendingStore(owner,()=>session)', { crypto, Date, owner, session }) as Store;
}

test('pending finance requests are immutable, restored with their original key, and scoped to the signed-in owner', () => {
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

test('missing owner or unavailable session persistence prevents a request from being staged', () => {
  const session = storage();
  assert.throws(() => create('', session).stage('account', '/api/finance/accounts', body), /重新登录/);
  session.setItem = () => { throw new Error('Synthetic storage blocked'); };
  const store = create('owner', session);
  assert.throws(() => store.stage('account', '/api/finance/accounts', body), /本次未发送/);
  assert.equal(store.value, null);
});

test('network failures, deadlines, authentication and service errors remain uncertain; only explicit rejection may be cleared', () => {
  const store = create('owner', storage());
  for (const error of [{}, { code: 'REQUEST_TIMEOUT' }, { status: 401 }, { status: 429 }, { status: 503 }]) assert.equal(store.definiteRejection(error), false);
  for (const status of [400, 403, 404, 409, 413, 415, 422]) assert.equal(store.definiteRejection({ status }), true);
});

test('successful responses must identify the original account or balance operation before local pending state can be cleared', () => {
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

test('balance corrections and voids retain their original revisions, reason and result identity across reload', () => {
  const session = storage(); const store = create('owner', session);
  const operation = store.stage('change', '/api/finance/accounts/' + account.id + '/balances/initial%3A' + account.id, { action: 'void', expectedRevision: 0, expectedAccountRevision: 2, reason: '合成日期误录' }, account);
  const refreshed = create('owner', session);
  assert.equal(refreshed.value?.key, operation.key);
  assert.equal(refreshed.value?.body.expectedAccountRevision, 2);
  assert.equal(refreshed.matchesResult({ account, changes: [{ id: operation.key }] }), true);
  assert.equal(refreshed.matchesResult({ account, balances: [{ id: operation.key }] }), false);
});

test('malformed stored requests never become an outbound arbitrary path or another owner request', () => {
  const session = storage(); const store = create('owner', session);
  store.stage('account', '/api/finance/accounts', body);
  const key = [...session.values.keys()][0]; const original = JSON.parse(session.values.get(key)!);
  for (const changed of [{ ...original, ownerId: 'someone-else' }, { ...original, path: 'https://other.example/accounts' }, { ...original, body: { ...original.body, apiKey: 'synthetic-forbidden-field' } }]) {
    session.values.set(key, JSON.stringify(changed)); const read = create('owner', session);
    assert.equal(read.value, null); assert.match(read.problem, /无法读取/);
    assert.throws(() => read.stage('account', '/api/finance/accounts', body), /无法读取/);
  }
});

test('failed cleanup keeps the original operation available and prevents a new key', () => {
  const session = storage(); const store = create('owner', session);
  const original = store.stage('account', '/api/finance/accounts', body);
  session.removeItem = () => { throw new Error('Synthetic cleanup blocked'); };
  assert.throws(() => store.clear(), /未能清理/);
  assert.equal(store.value?.key, original.key);
  assert.throws(() => store.stage('account', '/api/finance/accounts', body), /未能清理/);
});
