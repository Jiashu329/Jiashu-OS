import assert from 'node:assert/strict';
import test from 'node:test';
import { FinanceValidationError } from './finance.ts';
import { buildFinanceReview, parseFinanceReviewQuery } from './finance-review.ts';
import type { ReviewAccountRow, ReviewBalanceRow } from './finance-review.ts';

const NOW = new Date('2026-11-09T08:00:00.000Z');
function selection(query = '') { return parseFinanceReviewQuery(new URLSearchParams(query), NOW); }
function account(accountId: string, patch: Partial<ReviewAccountRow> = {}): ReviewAccountRow {
  return { accountId, name: accountId, type: 'bank', ledger: 'personal', currency: 'CNY', archivedAt: null, ...patch };
}
function balance(accountId: string, amountMinor: string, asOfDate: string, sequence = 1): ReviewBalanceRow {
  return { accountId, amountMinor, asOfDate, sequence };
}

void test('query defaults use Shanghai dates and validate ledger, currency and nonfuture calendar months', () => {
  assert.deepEqual(selection(), {
    ledger: 'personal', currency: 'CNY', month: '2026-11', previousMonth: '2026-10',
    today: '2026-11-09', cutoffDay: '2026-11-09', previousCutoffDay: '2026-10-31',
  });
  const afterMidnight = parseFinanceReviewQuery(new URLSearchParams(), new Date('2026-11-30T16:00:00Z'));
  assert.equal(afterMidnight.today, '2026-12-01');
  assert.equal(afterMidnight.month, '2026-12');
  assert.equal(afterMidnight.cutoffDay, '2026-12-01');
  assert.equal(selection('ledger=family&currency=JPY').currency, 'JPY');
  for (const query of ['ledger=other', 'ledger=', 'currency=BTC', 'currency=cny', 'currency=', 'month=',
    'month=2026-13', 'month=2026-00', 'month=2026-1', 'month=1969-12', 'month=2026-12', 'month=2026-11-01']) {
    assert.throws(() => selection(query), FinanceValidationError);
  }
});

void test('missing history remains null while an explicitly recorded zero is a real first snapshot', () => {
  const accounts = [account('empty'), account('zero')];
  const missing = buildFinanceReview(accounts, [], selection());
  assert.deepEqual(missing.snapshot, {
    assetsMinor: null, liabilitiesMinor: null, netMinor: null, accountCount: 0,
    oldestBalanceDate: null, latestBalanceDate: null, carriedAccountCount: 0,
  });
  assert.deepEqual(missing.change, { assetsMinor: null, liabilitiesMinor: null, netMinor: null, comparableNetMinor: null, newNetMinor: null });
  assert.deepEqual(missing.accounts, []);
  assert.ok(missing.trend.every((point) => point.netMinor === null));
  const zero = buildFinanceReview(accounts, [balance('zero', '0', '2026-11-02')], selection());
  assert.equal(zero.snapshot.accountCount, 1);
  assert.equal(zero.snapshot.assetsMinor, '0');
  assert.equal(zero.snapshot.liabilitiesMinor, '0');
  assert.equal(zero.snapshot.netMinor, '0');
  assert.equal(zero.change.netMinor, null);
  assert.equal(zero.change.comparableNetMinor, null);
  assert.equal(zero.change.newNetMinor, '0');
  assert.equal(zero.accounts[0].kind, 'new');
  assert.equal(zero.accounts[0].netChangeMinor, null);
  assert.equal(zero.accounts[0].previousMinor, null);
});

void test('balances carry across missing months with source dates rather than filling gaps with zero', () => {
  const result = buildFinanceReview([account('bank')], [balance('bank', '9007199254740993', '2026-09-18')], selection());
  assert.equal(result.snapshot.netMinor, '9007199254740993');
  assert.equal(result.previous.netMinor, '9007199254740993');
  assert.equal(result.change.netMinor, '0');
  assert.equal(result.change.comparableNetMinor, '0');
  assert.equal(result.change.newNetMinor, '0');
  assert.equal(result.snapshot.carriedAccountCount, 1);
  assert.equal(result.snapshot.oldestBalanceDate, '2026-09-18');
  assert.equal(result.snapshot.latestBalanceDate, '2026-09-18');
  assert.deepEqual(result.accounts[0], {
    accountId: 'bank', name: 'bank', type: 'bank', side: 'asset', kind: 'existing',
    previousMinor: '9007199254740993', currentMinor: '9007199254740993', netChangeMinor: '0',
    currentAsOfDate: '2026-09-18', previousAsOfDate: '2026-09-18', carried: true,
  });
  assert.equal(result.trend.length, 12);
  assert.equal(result.trend[0].month, '2025-12');
  assert.equal(result.trend.find((point) => point.month === '2026-08')!.netMinor, null);
  assert.equal(result.trend.find((point) => point.month === '2026-09')!.carriedAccountCount, 0);
  assert.deepEqual(result.trend.at(-1), { month: '2026-11', cutoffDay: '2026-11-09', ...result.snapshot });
});

void test('latest as-of date wins before same-day sequence and never depends on input order or creation time', () => {
  const initial = { ...balance('a', '100', '2026-10-31', 4), createdAt: '2026-11-09T10:00:00Z' };
  const correction = { ...balance('a', '200', '2026-10-31', 7), createdAt: '2026-10-31T10:00:00Z' };
  const lateBackfill = { ...balance('a', '50', '2026-10-01', 100), createdAt: '2026-11-10T10:00:00Z' };
  const november = balance('a', '500', '2026-11-05', 1);
  const future = balance('a', '999', '2026-11-10', 101);
  const records = [initial, november, lateBackfill, future, correction];
  const result = buildFinanceReview([account('a')], records, selection());
  const reordered = buildFinanceReview([account('a')], records.toReversed(), selection());
  assert.deepEqual(result, reordered);
  assert.equal(result.snapshot.netMinor, '500');
  assert.equal(result.previous.netMinor, '200');
  assert.equal(result.change.netMinor, '300');
  assert.equal(result.trend.find((point) => point.month === '2026-10')!.netMinor, '200');
});

void test('liability reductions contribute positively and all money, sums and deltas retain BigInt precision', () => {
  const large = '999999999999999999';
  const result = buildFinanceReview([
    account('cash'), account('loan', { type: 'loan' }), account('extra'),
  ], [
    balance('cash', large, '2026-10-31'), balance('cash', '999999999999999998', '2026-11-03', 2),
    balance('loan', '50000', '2026-10-31'), balance('loan', '40000', '2026-11-04', 2),
    balance('extra', large, '2026-11-04'),
  ], selection());
  assert.equal(result.snapshot.assetsMinor, '1999999999999999997');
  assert.equal(result.snapshot.liabilitiesMinor, '40000');
  assert.equal(result.snapshot.netMinor, '1999999999999959997');
  assert.equal(result.change.assetsMinor, '999999999999999998');
  assert.equal(result.change.liabilitiesMinor, '-10000');
  assert.equal(result.change.comparableNetMinor, '9999');
  assert.equal(result.change.newNetMinor, large);
  assert.equal(result.change.netMinor, '1000000000000009998');
  assert.equal(BigInt(result.change.comparableNetMinor!) + BigInt(result.change.newNetMinor!), BigInt(result.change.netMinor!));
  assert.equal(result.accounts.find((row) => row.accountId === 'loan')!.netChangeMinor, '10000');
  assert.equal(result.accounts.find((row) => row.accountId === 'extra')!.netChangeMinor, null);
});

void test('new assets and debts are first inclusion, not comparative account returns', () => {
  const result = buildFinanceReview([
    account('old'), account('new-bank'), account('new-debt', { type: 'credit_card' }),
  ], [
    balance('old', '1000', '2026-10-01'), balance('old', '1100', '2026-11-01', 2),
    balance('new-bank', '500', '2026-11-01'), balance('new-debt', '200', '2026-11-01'),
  ], selection());
  assert.equal(result.change.comparableNetMinor, '100');
  assert.equal(result.change.newNetMinor, '300');
  assert.equal(result.change.netMinor, '400');
  assert.equal(result.previous.accountCount, 1);
  assert.equal(result.snapshot.accountCount, 3);
  assert.equal(result.accounts.filter((row) => row.kind === 'new').length, 2);
  assert.ok(result.accounts.filter((row) => row.kind === 'new').every((row) => row.netChangeMinor === null));
});

void test('current ledger, currency, type and archive status define historical inclusion', () => {
  const accounts = [
    account('cny'), account('usd', { currency: 'USD' }), account('hkd', { currency: 'HKD' }),
    account('family', { ledger: 'family' }), account('archived', { currency: 'EUR', archivedAt: '2026-11-09T00:00:00Z' }),
    account('retyped', { type: 'loan' }),
  ];
  const records = accounts.map((row) => balance(row.accountId, '100', '2026-10-01'));
  const personal = buildFinanceReview(accounts, records, selection());
  assert.deepEqual(personal.availableCurrencies, ['CNY', 'HKD', 'USD']);
  assert.equal(personal.snapshot.assetsMinor, '100');
  assert.equal(personal.snapshot.liabilitiesMinor, '100');
  assert.equal(personal.snapshot.netMinor, '0');
  assert.equal(personal.snapshot.accountCount, 2);
  assert.equal(personal.previous.netMinor, '0');
  const usd = buildFinanceReview(accounts, records, selection('currency=USD'));
  assert.equal(usd.snapshot.assetsMinor, '100');
  assert.equal(usd.snapshot.accountCount, 1);
  assert.equal(usd.accounts[0].accountId, 'usd');
  const family = buildFinanceReview(accounts, records, selection('ledger=family'));
  assert.deepEqual(family.availableCurrencies, ['CNY']);
  assert.equal(family.accounts[0].accountId, 'family');
});

void test('historical month ends, leap years and year transitions use correct cutoffs', () => {
  const january = selection('month=2026-01');
  assert.equal(january.previousMonth, '2025-12');
  assert.equal(january.previousCutoffDay, '2025-12-31');
  assert.equal(january.cutoffDay, '2026-01-31');
  assert.equal(selection('month=2024-02').cutoffDay, '2024-02-29');
  assert.equal(selection('month=2025-02').cutoffDay, '2025-02-28');
  const result = buildFinanceReview([account('bank')], [
    balance('bank', '100', '2025-12-31'), balance('bank', '300', '2026-01-31', 2), balance('bank', '900', '2026-02-01', 3),
  ], january);
  assert.equal(result.snapshot.netMinor, '300');
  assert.equal(result.previous.netMinor, '100');
  assert.equal(result.change.netMinor, '200');
  assert.equal(result.trend[0].month, '2025-02');
  assert.equal(result.trend.at(-1)!.cutoffDay, '2026-01-31');
  const earliest = buildFinanceReview([], [], selection('month=1970-01'));
  assert.equal(earliest.previousMonth, '1969-12');
  assert.equal(earliest.previousCutoffDay, '1969-12-31');
  assert.equal(earliest.trend.length, 1);
  assert.equal(earliest.trend[0].month, '1970-01');
});

void test('existing accounts sort by exact absolute net change, with stable names and ids and new accounts last', () => {
  const accounts = [account('b', { name: 'same' }), account('c', { name: 'same' }), account('a'), account('new')];
  const records = [
    balance('a', '100', '2026-10-31'), balance('a', '0', '2026-11-01', 2),
    balance('b', '100', '2026-10-31'), balance('b', '9007199254740994', '2026-11-01', 2),
    balance('c', '100', '2026-10-31'), balance('c', '9007199254740994', '2026-11-01', 2),
    balance('new', '999999999999999999', '2026-11-01'),
  ];
  const result = buildFinanceReview(accounts, records, selection());
  assert.deepEqual(result.accounts.map((row) => row.accountId), ['b', 'c', 'a', 'new']);
  assert.deepEqual(buildFinanceReview(accounts.toReversed(), records.toReversed(), selection()), result);
});
