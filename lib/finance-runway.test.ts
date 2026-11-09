import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinanceRunwayView, FinanceRunwayValidationError, parseFinanceRunwayInput } from './finance-runway.ts';
import type { FinanceRunwayAccount, FinanceRunwaySettings } from './finance-runway.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
function input(patch: Record<string, unknown> = {}) {
  return { monthlyExpenseAmount: '3.00', targetMonths: 6, accountIds: [A], ...patch };
}
function settings(patch: Partial<FinanceRunwaySettings> = {}): FinanceRunwaySettings {
  return { ...parseFinanceRunwayInput(input(), 'CNY'), userId: 'alice', ledger: 'personal', currency: 'CNY',
    createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', ...patch };
}
function account(id: string, balanceMinor: string, patch: Partial<FinanceRunwayAccount> = {}): FinanceRunwayAccount {
  return { id, name: '合成资产', ledger: 'personal', currency: 'CNY', type: 'bank', balanceMinor, asOfDate: '2026-11-09', archivedAt: null, ...patch };
}

void test('unset settings do not invent an expense, target, account selection or progress', () => {
  assert.deepEqual(buildFinanceRunwayView(null, [account(A, '10000')]), { settings: null, progress: null });
});

void test('complete input parses exact money and normalizes references without choosing defaults', () => {
  assert.deepEqual(parseFinanceRunwayInput(input({ monthlyExpenseAmount: '9,007,199,254,740.99', accountIds: [B, A, A] }), 'CNY'), {
    monthlyExpenseMinor: '900719925474099', targetMonths: 6, accountIds: [A, B],
  });
  assert.equal(parseFinanceRunwayInput(input({ monthlyExpenseAmount: '999999999999999999' }), 'JPY').monthlyExpenseMinor, '999999999999999999');
  assert.equal(parseFinanceRunwayInput(input({ targetMonths: Number.MAX_SAFE_INTEGER }), 'CNY').targetMonths, Number.MAX_SAFE_INTEGER);
});

void test('expenses must be positive and months safe integers, with strict complete fields and valid nonempty references', () => {
  for (const monthlyExpenseAmount of ['0', '-1', '1e3', '', 100, '0.001', '10000000000000000.00']) {
    assert.throws(() => parseFinanceRunwayInput(input({ monthlyExpenseAmount }), 'CNY'), FinanceRunwayValidationError);
  }
  for (const targetMonths of [0, -1, 1.5, '6', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseFinanceRunwayInput(input({ targetMonths }), 'CNY'), FinanceRunwayValidationError);
  }
  for (const accountIds of [[], null, [null], ['invalid'], [A + '\n']]) assert.throws(() => parseFinanceRunwayInput(input({ accountIds }), 'CNY'), FinanceRunwayValidationError);
  for (const raw of [null, [], {}, { monthlyExpenseAmount: '1', targetMonths: 6 }, { ...input(), ledger: 'family' }]) {
    assert.throws(() => parseFinanceRunwayInput(raw, 'CNY'), FinanceRunwayValidationError);
  }
  assert.throws(() => parseFinanceRunwayInput(input({ monthlyExpenseAmount: '1.00' }), 'JPY'), FinanceRunwayValidationError);
});

void test('decimal runway is truncated while the quotient and remainder retain the exact ratio', () => {
  const result = buildFinanceRunwayView(settings(), [account(A, '10000')]);
  assert.equal(result.progress!.currentMinor, '10000');
  assert.equal(result.progress!.runwayMonths, '33.33');
  assert.equal(result.progress!.runwayWholeMonths, '33');
  assert.equal(result.progress!.runwayRemainderMinor, '100');
  assert.equal(result.progress!.targetMinor, '1800');
  assert.equal(result.progress!.gapMinor, '0');
  assert.equal(result.progress!.percent, 100);
  assert.equal(result.progress!.status, 'covered');
  assert.equal(result.settings!.monthlyExpenseAmount, '3.00');
  const short = buildFinanceRunwayView(settings(), [account(A, '100')]).progress!;
  assert.equal(short.runwayMonths, '0.33');
  assert.equal(short.gapMinor, '1700');
  assert.equal(short.status, 'short');
  assert.equal(short.percent, 5.55);
});

void test('large exact amounts and targets stay decimal strings even when the runway exceeds Number precision', () => {
  const huge = buildFinanceRunwayView(settings({ monthlyExpenseMinor: '1', targetMonths: 12 }), [account(A, '999999999999999999')]);
  assert.equal(huge.progress!.runwayMonths, '999999999999999999.00');
  assert.equal(huge.progress!.runwayWholeMonths, '999999999999999999');
  assert.equal(huge.progress!.runwayRemainderMinor, '0');
  const target = buildFinanceRunwayView(settings({ monthlyExpenseMinor: '999999999999999999', targetMonths: 12 }), [account(A, '9007199254740993')]).progress!;
  assert.equal(target.targetMinor, '11999999999999999988');
  assert.equal(target.gapMinor, '11990992800745258995');
  assert.equal(target.currentMinor, '9007199254740993');
});

void test('only selected same-scope active assets contribute, zero remains zero, and balance dates expose stale inputs', () => {
  const result = buildFinanceRunwayView(settings({ accountIds: [A, B] }), [
    account(A, '0', { asOfDate: '2026-10-01' }), account(B, '50'), account(A, '0', { asOfDate: '2026-10-01' }),
    account(crypto.randomUUID(), '999'),
  ]).progress!;
  assert.equal(result.currentMinor, '50');
  assert.equal(result.matchedAccountCount, 2);
  assert.equal(result.missingCount, 0);
  assert.equal(result.oldestBalanceDate, '2026-10-01');
  assert.equal(result.latestBalanceDate, '2026-11-09');
  for (const patch of [{ archivedAt: '2026-11-09T00:00:00Z' }, { currency: 'USD' }, { ledger: 'family' }, { type: 'loan' }]) {
    const missing = buildFinanceRunwayView(settings(), [account(A, '999', patch)]).progress!;
    assert.equal(missing.currentMinor, '0');
    assert.equal(missing.runwayMonths, '0.00');
    assert.equal(missing.missingCount, 1);
    assert.equal(missing.oldestBalanceDate, null);
    assert.equal(missing.latestBalanceDate, null);
  }
  const output = buildFinanceRunwayView(settings(), [account(A, '0')]);
  assert.equal(Object.hasOwn(output.settings!, 'userId'), false);
});
