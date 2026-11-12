import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinanceAllocationView } from './finance-allocation.ts';
import { buildFinanceGoalView } from './finance-goals.ts';
import type { FinanceGoalAccount, FinanceGoalPlan } from './finance-goals.ts';
import type { FinanceRunwaySettings } from './finance-runway.ts';

const scope = { userId: 'alice', ledger: 'personal' as const };
function plan(id: string, accountIds = ['a'], patch: Partial<FinanceGoalPlan> = {}): FinanceGoalPlan {
  return { id, accountIds, name: '目标' + id, userId: 'alice', ledger: 'personal', currency: 'CNY',
    targetMinor: '100000', deadline: '2027-01-01', creationHash: '', createdAt: '', updatedAt: '', archivedAt: null, ...patch };
}
function account(id: string, patch: Partial<FinanceGoalAccount> & { userId?: string } = {}) {
  return { id, name: '账户' + id, ledger: 'personal', currency: 'CNY', type: 'bank', balanceMinor: '9007199254740993',
    asOfDate: '2026-11-12', archivedAt: null, ...patch };
}
function runway(accountIds = ['a'], patch: Partial<FinanceRunwaySettings> = {}): FinanceRunwaySettings {
  return { ...scope, currency: 'CNY', monthlyExpenseMinor: '10000', targetMonths: 6, accountIds, createdAt: '', updatedAt: '', ...patch };
}

void test('shared references retain exact balances once per account and never change goal progress', () => {
  const plans = [plan('one', ['a', 'a', 'b']), plan('two', ['a', 'b']), plan('three', ['a'])];
  const accounts = [account('a'), account('b', { balanceMinor: '7' }), account('a')];
  const before = buildFinanceGoalView(plans[0], accounts, '2026-11-12');
  const result = buildFinanceAllocationView(scope, plans, accounts, [runway()]);
  assert.equal(result.accounts.length, 2);
  assert.deepEqual(result.accounts[0].goals.map((goal) => goal.id), ['one', 'two', 'three']);
  assert.equal(result.accounts[0].includesRunway, true);
  assert.equal(result.byGoal.one.sharedBalanceMinor, '9007199254741000');
  assert.deepEqual(result.byGoal.one.otherGoals.map((goal) => goal.id), ['two', 'three']);
  assert.deepEqual(buildFinanceGoalView(plans[0], accounts, '2026-11-12'), before);
  assert.deepEqual(plans[0].accountIds, ['a', 'a', 'b']);
});

void test('one goal shared only with emergency funds is surfaced, including a genuine zero balance', () => {
  const result = buildFinanceAllocationView(scope, [plan('one')], [account('a', { balanceMinor: '0' })], [runway()]);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.byGoal.one.sharedBalanceMinor, '0');
  assert.deepEqual(result.byGoal.one.otherGoals, []);
  assert.equal(result.byGoal.one.includesRunway, true);
});

void test('archived and foreign plans and nonmatching runway scopes do not create overlaps', () => {
  const result = buildFinanceAllocationView(scope, [plan('one'), plan('archived', ['a'], { archivedAt: '2026-11-01' }),
    plan('foreign', ['a'], { userId: 'bob' }), plan('family', ['a'], { ledger: 'family' }), plan('usd', ['a'], { currency: 'USD' })],
  [account('a')], [runway(['a'], { userId: 'bob' }), runway(['a'], { ledger: 'family' }), runway(['a'], { currency: 'USD' })]);
  assert.deepEqual(result.accounts, []);
  assert.deepEqual(result.byGoal.one.accounts, []);
  assert.equal(result.byGoal.archived, undefined);
  assert.equal(result.byGoal.foreign, undefined);
  assert.equal(result.byGoal.family, undefined);
});

void test('unknown, archived, foreign, liability and wrong-currency account references never warn as usable funds', () => {
  const ids = ['missing', 'archived', 'foreign', 'family', 'loan', 'usd', 'unknown'];
  const result = buildFinanceAllocationView(scope, [plan('one', ids), plan('two', ids)], [
    account('archived', { archivedAt: '2026-11-01' }), account('foreign', { userId: 'bob' }), account('family', { ledger: 'family' }),
    account('loan', { type: 'loan' }), account('usd', { currency: 'USD' }), account('unknown', { type: 'unrecognized' }),
  ], [runway(ids)]);
  assert.deepEqual(result.accounts, []);
  assert.equal(result.byGoal.one.sharedBalanceMinor, '0');
  assert.equal(result.byGoal.one.includesRunway, false);
});

void test('separate accounts and archived targets leave no shared warning', () => {
  const result = buildFinanceAllocationView(scope, [plan('one'), plan('two', ['b'])], [account('a'), account('b')], [runway(['c'])]);
  assert.deepEqual(result.accounts, []);
  assert.deepEqual(result.byGoal.one.otherGoals, []);
  assert.deepEqual(result.byGoal.two.accounts, []);
});
