import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { decimalFromMinor, parseBalanceEntry, parseMoney } from './finance.ts';
import { isCheckedThisMonth, normalizeCheckAmount, normalizeCheckNote, validateCheckDate } from './finance-balance-check.ts';

const TODAY = '2026-11-09';

void test('amount normalization matches independent finance money rules and preserves zero, decimals and large values', () => {
  for (const raw of ['0', '0.0', '000.00', '  12.3  ', '123.45', '1,234.5', '1，234.50', '1 234.50',
    '1\u00a0234.50', '1\u202f234.50', '12,345,678.90', '90071992547409.93', '9999999999999999.99']) {
    assert.equal(normalizeCheckAmount(raw, 2), decimalFromMinor(parseMoney(raw, 'CNY'), 'CNY'));
    assert.equal(normalizeCheckAmount(raw, 2), decimalFromMinor(parseMoney(raw, 'USD'), 'USD'));
  }
  assert.equal(normalizeCheckAmount('90071992547409.93', 2), '90071992547409.93');
  assert.equal(normalizeCheckAmount('0', 2), '0.00');
  assert.equal(normalizeCheckAmount('0012.3', 2), '12.30');
});

void test('JPY balances stay exact integer decimal strings without accepting fractional syntax', () => {
  for (const raw of ['0', '000000', ' 123 ', '1,234', '1\u202f234', '9007199254740993', '999999999999999999']) {
    assert.equal(normalizeCheckAmount(raw, 0), decimalFromMinor(parseMoney(raw, 'JPY'), 'JPY'));
  }
  for (const raw of ['0.0', '1.00', '1.5', '999.']) {
    assert.throws(() => parseMoney(raw, 'JPY'));
    assert.throws(() => normalizeCheckAmount(raw, 0), /小数/);
  }
});

void test('invalid, missing, coerced and oversized balances fail consistently with the server money parser', () => {
  const invalid: unknown[] = [undefined, null, '', '  ', 0, 123.45, true, {}, [],
    '-1', '+1', '-0', '1e3', '1E3', 'NaN', 'Infinity', '￥1', '1元', '.5', '1.', '1.001',
    '1,23', '1234,567', '1,234 567', '1，234,567', '1,,234', '1  234', '1\t234', '\t123', '123\n',
    '１，２３４', '1\u0000234', '123\u007f', '10000000000000000.00', '0'.repeat(129),
  ];
  for (const raw of invalid) {
    assert.throws(() => parseMoney(raw, 'CNY'));
    assert.throws(() => normalizeCheckAmount(raw, 2));
  }
  assert.throws(() => normalizeCheckAmount('1000000000000000000', 0), /过大/);
  for (const decimals of [-1, 1, 3, NaN, Infinity]) assert.throws(() => normalizeCheckAmount('1', decimals), /币种/);
});

void test('valid dates agree with the server balance contract, including leap days and inclusive endpoints', () => {
  for (const [day, today] of [
    ['1970-01-01', TODAY], ['2024-02-29', TODAY], ['2026-11-09', TODAY], ['2100-12-31', '2100-12-31'],
  ]) {
    assert.equal(validateCheckDate(day, today), parseBalanceEntry({ amount: '0', asOfDate: day }, 'CNY', { today }).asOfDate);
  }
});

void test('dates reject missing values, impossible calendars, whitespace, years outside the contract and future days', () => {
  const invalid: unknown[] = [undefined, null, '', 20261109, true, {}, '2026-2-09', ' 2026-11-09', '2026-11-09 ',
    '2026-11-09\n', '2026-11-01\n', '2026-11-09T00:00:00+08:00', '1969-12-31', '2101-01-01',
    '2026-00-01', '2026-13-01', '2026-11-00', '2026-11-31', '2025-02-29', '2100-02-29', '2026-11-10',
  ];
  for (const day of invalid) {
    assert.throws(() => parseBalanceEntry({ amount: '0', asOfDate: day }, 'CNY', { today: TODAY }));
    assert.throws(() => validateCheckDate(day, TODAY));
  }
  for (const today of ['', '2026-02-30', '2101-01-01', '2026-11-09T00:00:00Z']) {
    assert.throws(() => validateCheckDate('2026-11-01', today), /当前日期/);
  }
});

void test('monthly check status uses a valid as-of date rather than record creation or account update time', () => {
  for (const day of ['2026-11-01', '2026-11-09']) assert.equal(isCheckedThisMonth(day, TODAY), true);
  for (const day of ['', '2026-10-31', '2026-12-01', '2026-11-10', '2026-11-31', '2026-11-09T00:00:00Z', '2026-11-09\n', '2026-11-01\n']) {
    assert.equal(isCheckedThisMonth(day, TODAY), false);
  }
  assert.equal(isCheckedThisMonth('2024-02-29', '2024-02-29'), true);
  assert.equal(isCheckedThisMonth('2025-02-29', '2025-02-28'), false);
  assert.equal(isCheckedThisMonth('2026-12-31', '2027-01-01'), false);
  assert.equal(isCheckedThisMonth('2026-11-01', '2026-11-31'), false);
});

void test('notes match balance-entry normalization and allow only the same documented control whitespace', () => {
  for (const note of [undefined, '', '  已核对余额  ', '月度\n余额\t已核实\r\n', '备'.repeat(500), ' '.repeat(1000) + '备注']) {
    assert.equal(normalizeCheckNote(note), parseBalanceEntry({ amount: '0', asOfDate: TODAY, note }, 'CNY', { today: TODAY }).note);
  }
  for (const note of [null, 1, {}, '备'.repeat(501), '\u0000', '\u0008', '\u000b', '\u000c', '\u001f', '\u007f']) {
    assert.throws(() => parseBalanceEntry({ amount: '0', asOfDate: TODAY, note }, 'CNY', { today: TODAY }));
    assert.throws(() => normalizeCheckNote(note));
  }
});

void test('each helper runs independently after toString serialization without module imports or shared closures', () => {
  const isolatedAmount = runInNewContext('(' + normalizeCheckAmount.toString() + ')') as typeof normalizeCheckAmount;
  const isolatedDate = runInNewContext('(' + validateCheckDate.toString() + ')') as typeof validateCheckDate;
  const isolatedChecked = runInNewContext('(' + isCheckedThisMonth.toString() + ')') as typeof isCheckedThisMonth;
  const isolatedNote = runInNewContext('(' + normalizeCheckNote.toString() + ')') as typeof normalizeCheckNote;
  assert.equal(isolatedAmount('90,071,992,547,409.93', 2), '90071992547409.93');
  assert.equal(isolatedAmount('999999999999999999', 0), '999999999999999999');
  assert.equal(isolatedAmount('0', 2), '0.00');
  assert.throws(() => isolatedAmount('-1', 2), /非负/);
  assert.equal(isolatedDate('2024-02-29', TODAY), '2024-02-29');
  assert.throws(() => isolatedDate('2025-02-29', TODAY), /日期/);
  assert.throws(() => isolatedDate('2026-11-10', TODAY), /晚于今天/);
  assert.equal(isolatedChecked('2026-11-01', TODAY), true);
  assert.equal(isolatedChecked('2026-11-10', TODAY), false);
  assert.equal(isolatedNote('  已核对  '), '已核对');
  assert.equal(isolatedNote(undefined), '');
  assert.throws(() => isolatedNote('\u0001'), /控制字符/);
});
