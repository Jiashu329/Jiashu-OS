import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCOUNT_TYPES,
  CURRENCIES,
  LEDGERS,
  FinanceValidationError,
  buildFinanceSummary,
  compareBalanceEntries,
  decimalFromMinor,
  formatMoney,
  latestBalanceEntry,
  parseAccountPatch,
  parseAccountPatchCommand,
  parseAccountUpdate,
  parseBalanceEntry,
  parseCreateAccount,
  parseMoney,
  summarizeAccounts,
  todayShanghai,
} from './finance.ts';

const options = { today: '2026-11-09' };
const opening = {
  ledger: 'personal',
  name: '备用金',
  type: 'bank',
  currency: 'CNY',
  amount: '1234.56',
  asOfDate: '2026-11-09',
};

function invalid(operation: () => unknown, path?: string) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof FinanceValidationError);
    assert.equal(error.status, 400);
    assert.ok(error.issues.length > 0);
    assert.ok(error.issues.every((issue) => typeof issue.path === 'string' && typeof issue.message === 'string' && issue.message.length > 0));
    if (path) assert.ok(error.issues.some((issue) => issue.path === path), 'validation points to ' + path);
    return true;
  });
}

test('money is converted and displayed exactly beyond Number safe integers', () => {
  const minor = parseMoney('90071992547409.93', 'CNY');
  assert.equal(minor, '9007199254740993');
  assert.equal(decimalFromMinor(minor, 'CNY'), '90071992547409.93');
  assert.equal(formatMoney(minor, 'CNY'), 'CNY 90,071,992,547,409.93');
  assert.equal(decimalFromMinor('-200', 'CNY'), '-2.00');
  assert.equal(formatMoney('-200', 'CNY'), 'CNY -2.00');
});

test('supported currencies have explicit precision and accepted grouping stays exact', () => {
  for (const currency of ['CNY', 'HKD', 'USD', 'EUR', 'GBP', 'SGD', 'AUD', 'CAD'] as const) {
    assert.equal(CURRENCIES[currency].decimals, 2);
    assert.equal(parseMoney('  001,234.50  ', currency), '123450');
    assert.equal(decimalFromMinor('0', currency), '0.00');
  }
  for (const amount of ['1,234,567.89', '1，234，567.89', '1 234 567.89', '1\u00a0234\u00a0567.89', '1\u202f234\u202f567.89']) {
    assert.equal(parseMoney(amount, 'CNY'), '123456789');
  }
  assert.equal(CURRENCIES.JPY.decimals, 0);
  assert.equal(parseMoney('1,234', 'JPY'), '1234');
  assert.equal(decimalFromMinor('1234', 'JPY'), '1234');
});

test('malformed and lossy monetary input fails instead of rounding or coercing', () => {
  for (const amount of ['', ' ', '-1', '+1', 'NaN', 'Infinity', '1e6', '.5', '1.234', '1,23', '1,234 567', '1,234，567', '1\u00a0234 567', '1.234,56', '1元', '1\n2']) {
    invalid(() => parseMoney(amount, 'CNY'));
  }
  invalid(() => parseMoney(12 as never, 'CNY'));
  invalid(() => parseMoney('100.0', 'JPY'));
  invalid(() => parseMoney('100.00', 'JPY'));
  invalid(() => parseMoney('1', 'BTC' as never));
});

test('the single-account amount bound is explicit and zero remains a recorded balance', () => {
  assert.equal(parseMoney('9999999999999999.99', 'CNY'), '999999999999999999');
  invalid(() => parseMoney('10000000000000000.00', 'CNY'));
  assert.equal(parseMoney('0', 'CNY'), '0');
  assert.equal(parseMoney('000.00', 'CNY'), '0');
});

test('account creation normalizes text and amount without accepting an owner from the client', () => {
  const created = parseCreateAccount({ ...opening, name: '  备用金  ', amount: '1,234.50', note: '  初始估值\n已核对  ' }, options);
  assert.equal(created.name, '备用金');
  assert.equal(created.note, '初始估值\n已核对');
  assert.equal(created.amount, '1234.50');
  assert.equal(created.amountMinor, '123450');
  assert.equal(created.ledger, 'personal');
  assert.equal(parseCreateAccount(opening, options).note, '');
  invalid(() => parseCreateAccount({ ...opening, userId: 'another-user' }, options), 'userId');
  invalid(() => parseCreateAccount({ ...opening, unexpected: true }, options), 'unexpected');
});

test('ledger, account classification and currency are constrained rather than silently defaulted', () => {
  assert.ok(LEDGERS.personal.label);
  assert.ok(LEDGERS.family.label);
  assert.equal(ACCOUNT_TYPES.bank.side, 'asset');
  assert.equal(ACCOUNT_TYPES.loan.side, 'liability');
  invalid(() => parseCreateAccount({ ...opening, ledger: 'shared' }, options), 'ledger');
  invalid(() => parseCreateAccount({ ...opening, type: 'unknown' }, options), 'type');
  invalid(() => parseCreateAccount({ ...opening, currency: 'BTC' }, options), 'currency');
  invalid(() => parseCreateAccount({ ...opening, amount: -100 }, options));
});

test('name and note boundaries match the form and control characters are not accepted', () => {
  assert.equal(parseCreateAccount({ ...opening, name: '名'.repeat(60), note: '注'.repeat(500) }, options).name.length, 60);
  invalid(() => parseCreateAccount({ ...opening, name: '名'.repeat(61) }, options), 'name');
  invalid(() => parseCreateAccount({ ...opening, name: '   ' }, options), 'name');
  invalid(() => parseCreateAccount({ ...opening, name: '账\n户' }, options), 'name');
  invalid(() => parseCreateAccount({ ...opening, note: '注'.repeat(501) }, options), 'note');
  invalid(() => parseCreateAccount({ ...opening, note: '备注\u0000' }, options), 'note');
});

test('record dates are real calendar days and cannot be forecasts', () => {
  assert.equal(parseCreateAccount({ ...opening, asOfDate: '2024-02-29' }, options).asOfDate, '2024-02-29');
  for (const asOfDate of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-11-10', '2026-11-09T00:00:00Z', '11/09/2026', '1969-12-31']) {
    invalid(() => parseCreateAccount({ ...opening, asOfDate }, options), 'asOfDate');
  }
  assert.equal(todayShanghai(new Date('2026-12-31T16:00:00Z')), '2027-01-01');
  assert.equal(todayShanghai(Date.parse('2026-11-08T16:00:00Z')), '2026-11-09');
});

test('metadata patches do not mutate a ledger, currency, owner or balance', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parseAccountPatch({ name: '  新名称 ', note: ' 备注 ', archived: true }))), { name: '新名称', note: '备注', archived: true });
  assert.deepEqual(JSON.parse(JSON.stringify(parseAccountUpdate({ type: 'loan' }))), { type: 'loan' });
  invalid(() => parseAccountPatch({}));
  for (const raw of [{ ledger: 'family' }, { currency: 'USD' }, { userId: 'other' }, { amount: '1' }, { archived: 'false' }]) {
    invalid(() => parseAccountPatch(raw));
  }
});

test('balance records keep the account currency precision and debt uses a positive amount', () => {
  const entry = parseBalanceEntry({ amount: '100.01', asOfDate: '2026-10-01', note: ' 重新估值 ' }, 'CNY', options);
  assert.equal(entry.amountMinor, '10001');
  assert.equal(entry.amount, '100.01');
  assert.equal(entry.note, '重新估值');
  assert.equal(parseBalanceEntry({ amount: '100', asOfDate: '2026-11-09' }, 'JPY', options).amountMinor, '100');
  invalid(() => parseBalanceEntry({ amount: '100.00', asOfDate: '2026-11-09' }, 'JPY', options));
  invalid(() => parseBalanceEntry({ amount: '-100', asOfDate: '2026-11-09' }, 'CNY', options));
  invalid(() => parseBalanceEntry({ amount: '100', asOfDate: '2026-11-10' }, 'CNY', options));
  invalid(() => parseBalanceEntry({ amount: '100', asOfDate: '2026-11-09', userId: 'other' }, 'CNY', options));
});

test('personal, family and currency totals are independent and archived accounts are excluded', () => {
  const accounts = [
    { ledger: 'personal' as const, type: 'bank' as const, currency: 'CNY' as const, balanceMinor: '10000' },
    { ledger: 'personal' as const, type: 'loan' as const, currency: 'CNY' as const, balanceMinor: '3000' },
    { ledger: 'personal' as const, type: 'investment' as const, currency: 'USD' as const, balanceMinor: '20000' },
    { ledger: 'family' as const, type: 'property' as const, currency: 'CNY' as const, balanceMinor: '90000000' },
    { ledger: 'personal' as const, type: 'cash' as const, currency: 'CNY' as const, balanceMinor: '99999999', archived: true },
  ];
  const personal = summarizeAccounts(accounts, 'personal');
  assert.equal(personal.accountCount, 3);
  assert.equal(personal.byCurrency.CNY!.assetsMinor, '10000');
  assert.equal(personal.byCurrency.CNY!.liabilitiesMinor, '3000');
  assert.equal(personal.byCurrency.CNY!.netMinor, '7000');
  assert.equal(personal.byCurrency.CNY!.netAmount, '70.00');
  assert.equal(personal.byCurrency.CNY!.netFormatted, 'CNY 70.00');
  assert.equal(personal.byCurrency.USD!.assetsMinor, '20000');
  assert.equal(personal.byCurrency.USD!.netMinor, '20000');
  assert.equal(personal.currencies.length, 2);
  assert.equal(buildFinanceSummary(accounts, 'family').byCurrency.CNY!.netMinor, '90000000');
});

test('net assets may be negative although each recorded liability is positive', () => {
  const summary = summarizeAccounts([
    { ledger: 'family', type: 'cash', currency: 'HKD', balanceMinor: '100' },
    { ledger: 'family', type: 'credit_card', currency: 'HKD', balanceMinor: '300' },
  ], 'family');
  const hkd = summary.byCurrency.HKD!;
  assert.equal(hkd.assetsMinor, '100');
  assert.equal(hkd.liabilitiesMinor, '300');
  assert.equal(hkd.netMinor, '-200');
  assert.equal(hkd.netFormatted, 'HKD -2.00');
  assert.equal(hkd.assetCount, 1);
  assert.equal(hkd.liabilityCount, 1);
});

test('summary totals can exceed a single-account bound without numeric overflow', () => {
  const summary = summarizeAccounts([
    { ledger: 'personal', type: 'bank', currency: 'CNY', balanceMinor: '999999999999999999' },
    { ledger: 'personal', type: 'property', currency: 'CNY', balanceMinor: '999999999999999999' },
  ], 'personal');
  assert.equal(summary.byCurrency.CNY!.assetsMinor, '1999999999999999998');
  assert.equal(summary.byCurrency.CNY!.assetsAmount, '19999999999999999.98');
  assert.equal(summary.byCurrency.CNY!.assetsFormatted, 'CNY 19,999,999,999,999,999.98');
  assert.doesNotThrow(() => JSON.stringify(summary));
});

test('an empty book remains distinguishable from an explicitly recorded zero balance', () => {
  const empty = summarizeAccounts([], 'personal');
  assert.equal(empty.accountCount, 0);
  assert.deepEqual(empty.currencies, []);
  assert.deepEqual(Object.keys(empty.byCurrency), []);
  const zero = summarizeAccounts([{ ledger: 'personal', type: 'bank', currency: 'CNY', balanceMinor: '0' }], 'personal');
  assert.equal(zero.accountCount, 1);
  assert.equal(zero.byCurrency.CNY!.netMinor, '0');
});

test('backdated records cannot replace a newer balance and ties have deterministic ordering', () => {
  const prior = { id: 'entry-a', asOfDate: '2026-10-01', createdAt: '2026-11-09T04:00:00.000Z', amountMinor: '500' };
  const current = { id: 'entry-b', asOfDate: '2026-11-09', createdAt: '2026-11-09T03:00:00.000Z', amountMinor: '1000' };
  const corrected = { id: 'entry-c', asOfDate: '2026-11-09', createdAt: '2026-11-09T05:00:00.000Z', amountMinor: '1200' };
  const sameTime = { ...corrected, id: 'entry-d' };
  const original = [current, sameTime, prior, corrected];
  assert.ok(compareBalanceEntries(prior, current) < 0);
  assert.ok(compareBalanceEntries(current, corrected) < 0);
  assert.ok(compareBalanceEntries(corrected, sameTime) < 0);
  assert.equal(compareBalanceEntries(current, current), 0);
  assert.equal(latestBalanceEntry(original)?.id, 'entry-d');
  assert.equal(original[0], current, 'selecting the latest record does not mutate input order');
  assert.equal(latestBalanceEntry([]), null);
});

test('date fields and stored minor units cannot contain trailing line breaks', () => {
  invalid(() => parseCreateAccount({ ...opening, asOfDate: '2026-11-08\n' }, options), 'asOfDate');
  invalid(() => parseBalanceEntry({ amount: '1', asOfDate: '2026-11-08\r\n' }, 'CNY', options), 'asOfDate');
  invalid(() => decimalFromMinor('100\n', 'CNY'), 'amountMinor');
});

test('duplicate or malformed account identities cannot silently inflate or hide totals', () => {
  const account = { id: 'account-a', ledger: 'personal' as const, type: 'bank' as const, currency: 'CNY' as const, balanceMinor: '100' };
  invalid(() => summarizeAccounts([account, { ...account }], 'personal'), 'accounts[1].id');
  invalid(() => summarizeAccounts([{ ...account, ledger: 'personl' as never }], 'personal'), 'ledger');
  invalid(() => latestBalanceEntry([{ id: 'bad', asOfDate: '2026-11-09', createdAt: 'not-a-date' }]), 'createdAt');
});


test('account write commands require an explicit positive read revision without changing bare backup validation', () => {
  assert.deepEqual(parseAccountPatchCommand({name:'新名称',expectedRevision:2}),{name:'新名称',expectedRevision:2});
  for(const expectedRevision of [undefined,null,0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1])invalid(()=>parseAccountPatchCommand({name:'旧页面',expectedRevision}),'expectedRevision');
  invalid(()=>parseAccountPatchCommand({expectedRevision:1}));
});
