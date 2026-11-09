import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinanceGoalView, FinanceGoalValidationError, parseFinanceGoalCreate, parseFinanceGoalPatch } from './finance-goals.ts';
import type { FinanceGoalAccount, FinanceGoalPlan } from './finance-goals.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const TODAY = '2026-11-09';
function input(patch: Record<string, unknown> = {}) {
  return { ledger: 'personal', currency: 'CNY', name: '专项储蓄', targetAmount: '1.00', deadline: '2027-01-01', accountIds: [A], ...patch };
}
function plan(patch: Partial<FinanceGoalPlan> = {}): FinanceGoalPlan {
  return { ...parseFinanceGoalCreate(input()), id: crypto.randomUUID(), userId: 'alice', creationHash: 'immutable-initial-hash',
    createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', archivedAt: null, ...patch };
}
function account(id: string, balanceMinor: string, patch: Partial<FinanceGoalAccount> = {}): FinanceGoalAccount {
  return { id, name: '合成账户', ledger: 'personal', currency: 'CNY', type: 'bank', balanceMinor, asOfDate: TODAY, archivedAt: null, ...patch };
}

void test('goal creation parses exact money, normalizes duplicate references and allows valid expired deadlines', () => {
  const parsed = parseFinanceGoalCreate(input({ name: '  旅行储蓄  ', targetAmount: '9,007,199,254,740.99', accountIds: [B, A, A], deadline: '2000-02-29' }));
  assert.equal(parsed.name, '旅行储蓄');
  assert.equal(parsed.targetMinor, '900719925474099');
  assert.deepEqual(parsed.accountIds, [A, B]);
  assert.equal(parsed.deadline, '2000-02-29');
  assert.equal(parseFinanceGoalCreate(input({ currency: 'JPY', targetAmount: '999999999999999999' })).targetMinor, '999999999999999999');
});

void test('goal fields are strict, target money is positive and invalid dates or account selections fail', () => {
  for (const patch of [
    { targetAmount: '0' }, { targetAmount: '-1' }, { targetAmount: '1e3' }, { targetAmount: 100 },
    { targetAmount: '10000000000000000.00' }, { currency: 'JPY', targetAmount: '1.00' },
    { name: '' }, { name: 'x'.repeat(61) }, { name: '旅行\n储蓄' }, { deadline: '2026-02-30' },
    { deadline: '2100-02-29' }, { deadline: '1969-12-31' }, { deadline: '2101-01-01' }, { deadline: '2026-11-01\n' },
    { accountIds: [] }, { accountIds: [null] }, { accountIds: ['not-an-account'] }, { extra: true },
  ]) assert.throws(() => parseFinanceGoalCreate(input(patch)));
  for (const patch of [{}, { ledger: 'family' }, { currency: 'USD' }, { archived: 'true' }, { targetAmount: '0' }, { accountIds: [] }]) {
    assert.throws(() => parseFinanceGoalPatch(patch, 'CNY'), FinanceGoalValidationError);
  }
  assert.deepEqual(parseFinanceGoalPatch({ name: ' 改名 ', targetAmount: '2.50', archived: false }, 'CNY'), { name: '改名', targetMinor: '250', archived: false });
});

void test('monthly reference amounts include the current calendar month and round up the smallest unit', () => {
  const view = buildFinanceGoalView(plan(), [account(A, '0')], TODAY);
  assert.equal(view.currentMinor, '0');
  assert.equal(view.gapMinor, '100');
  assert.equal(view.monthsRemaining, 3);
  assert.equal(view.monthlyMinor, '34');
  assert.equal(view.daysRemaining, 53);
  assert.equal(view.percent, 0);
  assert.equal(view.targetAmount, '1.00');
  assert.equal(view.status, 'active');
  const dueToday = buildFinanceGoalView(plan({ deadline: TODAY }), [account(A, '50')], TODAY);
  assert.equal(dueToday.daysRemaining, 0);
  assert.equal(dueToday.monthsRemaining, 1);
  assert.equal(dueToday.monthlyMinor, '50');
  assert.equal(dueToday.status, 'active');
  const leap = buildFinanceGoalView(plan({ deadline: '2024-03-01' }), [account(A, '0')], '2024-02-28');
  assert.equal(leap.daysRemaining, 2);
  assert.equal(leap.monthsRemaining, 2);
});

void test('expired unmet goals have no monthly estimate while achieved goals always have zero gap', () => {
  const expired = buildFinanceGoalView(plan({ deadline: '2026-11-08' }), [account(A, '10')], TODAY);
  assert.equal(expired.status, 'overdue');
  assert.equal(expired.daysRemaining, 0);
  assert.equal(expired.monthsRemaining, 0);
  assert.equal(expired.monthlyMinor, null);
  assert.equal(expired.gapMinor, '90');
  const achieved = buildFinanceGoalView(plan({ deadline: '2026-11-08' }), [account(A, '101')], TODAY);
  assert.equal(achieved.status, 'achieved');
  assert.equal(achieved.percent, 100);
  assert.equal(achieved.gapMinor, '0');
  assert.equal(achieved.monthlyMinor, '0');
});

void test('large balances, gaps and monthly references keep exact BigInt arithmetic and bounded display ratios', () => {
  const large = buildFinanceGoalView(plan({ targetMinor: '999999999999999999', deadline: '2026-12-01' }), [account(A, '9007199254740993')], TODAY);
  assert.equal(large.currentMinor, '9007199254740993');
  assert.equal(large.gapMinor, '990992800745259006');
  assert.equal(large.monthlyMinor, '495496400372629503');
  assert.equal(large.percent, 0.9);
  const summed = buildFinanceGoalView(plan({ targetMinor: '999999999999999999', accountIds: [A, B] }), [
    account(A, '999999999999999999'), account(B, '999999999999999999'),
  ], TODAY);
  assert.equal(summed.currentMinor, '1999999999999999998');
  assert.equal(summed.percent, 100);
});

void test('only linked active asset balances of the same ledger and currency contribute once, and missing links remain visible', () => {
  const view = buildFinanceGoalView(plan({ accountIds: [A, B] }), [
    account(A, '40'), account(A, '40'), account(B, '999', { archivedAt: '2026-11-08T00:00:00Z' }),
    account(crypto.randomUUID(), '999'),
  ], TODAY);
  assert.equal(view.currentMinor, '40');
  assert.equal(view.missingCount, 1);
  assert.equal(view.matchedAccountCount, 1);
  for (const patch of [{ ledger: 'family' }, { currency: 'USD' }, { type: 'loan' }]) {
    const missing = buildFinanceGoalView(plan(), [account(A, '999', patch)], TODAY);
    assert.equal(missing.currentMinor, '0');
    assert.equal(missing.missingCount, 1);
    assert.equal(missing.gapMinor, '100');
  }
  assert.equal(Object.hasOwn(view, 'userId'), false);
  assert.equal(Object.hasOwn(view, 'creationHash'), false);
});
