import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinanceReview, parseFinanceReviewQuery } from './finance-review.ts';
import { financeReviewHash, parseFinanceCloseInput, parseStoredFinanceReview } from './finance-review-close.ts';

const NOW = new Date('2026-11-12T06:00:00Z');
function report(month = '2026-10') {
  const selection = parseFinanceReviewQuery(new URLSearchParams({ month }), NOW);
  return buildFinanceReview([{ accountId: 'bank', name: '储蓄', ledger: 'personal', currency: 'CNY', type: 'bank', archivedAt: null }],
    [{ accountId: 'bank', amountMinor: '9007199254740993', asOfDate: month + '-01', sequence: 1 }], selection);
}

void test('month close confirms ended months with explicit current version and mandatory reclose reason', () => {
  const input = { ledger: 'personal', currency: 'CNY', month: '2026-10', expectedVersion: 0, previewHash: 'a'.repeat(64), reason: '' };
  assert.equal(parseFinanceCloseInput(input, NOW).selection.cutoffDay, '2026-10-31');
  for (const patch of [{ month: '2026-11' }, { expectedVersion: -1 }, { expectedVersion: 0.5 }, { previewHash: 'bad' }, { expectedVersion: 1 }, { reason: 3 }, { unexpected: true }]) {
    assert.throws(() => parseFinanceCloseInput({ ...input, ...patch }, NOW));
  }
  assert.equal(parseFinanceCloseInput({ ...input, expectedVersion: 1, reason: '  余额更正  ' }, NOW).reason, '余额更正');
});

void test('durable snapshots validate exact money, dates, account roles and restore scope', () => {
  const original = report();
  assert.deepEqual(parseStoredFinanceReview(JSON.parse(JSON.stringify(original))), original);
  assert.equal(parseStoredFinanceReview(original).snapshot.netMinor, '9007199254740993');
  assert.throws(() => parseStoredFinanceReview(original, { ledger: 'family', currency: 'CNY', month: '2026-10' }));
  for (const mutate of [
    (value: typeof original) => { value.snapshot.netMinor = '1'; },
    (value: typeof original) => { value.cutoffDay = '2026-10-32'; },
    (value: typeof original) => { value.accounts[0].side = 'liability'; },
    (value: typeof original) => { value.accounts[0].currentMinor = '1e10'; },
    (value: typeof original) => { value.accounts.push(value.accounts[0]); },
    (value: typeof original) => { value.trend = []; },
  ]) {
    const corrupted = structuredClone(original); mutate(corrupted); assert.throws(() => parseStoredFinanceReview(corrupted));
  }
  assert.equal(parseStoredFinanceReview(report('1970-01')).previousMonth, '1969-12');
});

void test('preview fingerprint survives a new viewing day and rejects changed accounting', async () => {
  const original = report();
  const nextDay = { ...original, today: '2026-11-13' };
  assert.equal(await financeReviewHash(original), await financeReviewHash(nextDay));
  const changed = structuredClone(original); changed.accounts[0].name = '重命名';
  assert.notEqual(await financeReviewHash(original), await financeReviewHash(changed));
});

void test('snapshots preserve dated classifications and known zero membership without rejecting archived final accounts', () => {
  const selection = parseFinanceReviewQuery(new URLSearchParams({ month: '2026-10' }), NOW);
  const archived = buildFinanceReview([{ accountId: 'bank', name: '历史账户', ledger: 'personal', currency: 'CNY', type: 'loan', archivedAt: '2026-10-20T04:00:00Z' }],
    [{ accountId: 'bank', amountMinor: '10000', asOfDate: '2026-09-15', sequence: 1 }], selection, [
      { accountId: 'bank', revision: 1, effectiveFrom: '1970-01-01', type: 'bank', archived: 0, origin: 'opening', recordedAt: '2026-09-15T04:00:00Z' },
      { accountId: 'bank', revision: 2, effectiveFrom: '2026-10-20', type: 'loan', archived: 1, origin: 'change', recordedAt: '2026-10-20T04:00:00Z' },
    ]);
  const restored = parseStoredFinanceReview(JSON.parse(JSON.stringify(archived)));
  assert.equal(restored.snapshot.accountCount, 0);
  assert.equal(restored.snapshot.netMinor, '0');
  assert.equal(restored.previous.netMinor, '10000');
  assert.equal(restored.change.membershipNetMinor, '-10000');
  assert.equal(restored.accounts[0].previousType, 'bank');
  assert.equal(restored.accounts[0].archived, true);
  const corrupt = structuredClone(archived); corrupt.accounts[0].classificationChangeMinor = 'invalid';
  assert.throws(() => parseStoredFinanceReview(corrupt));
});
