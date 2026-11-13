import { env } from 'cloudflare:workers';
import { changeFinanceBalance, financeBalanceChangeHistory, previewFinanceBalanceChange } from './finance-balance-changes-store';
import type { FinanceBalanceChangeInput } from '../lib/finance-balance-change';
import { ACCOUNT_TYPES, CURRENCIES, LEDGERS, buildFinanceSummary, decimalFromMinor, formatMoney, todayShanghai } from '../lib/finance';
import {
  appendFinanceBalance, createFinanceAccount, exportFinanceSnapshot, findFinanceAccountSnapshot,
  listFinanceAccounts, patchFinanceAccount,
  type FinanceAccountRow, type FinanceBalanceRow, type FinanceAccountPatch, type NewFinanceAccount, type NewFinanceBalance,
} from './finance-store';

type Currency = keyof typeof CURRENCIES;
type Ledger = keyof typeof LEDGERS;
type AccountType = keyof typeof ACCOUNT_TYPES;

function database() {
  if (!env.DB) throw new Error('Finance database unavailable');
  return env.DB;
}

function presentAccount(row: FinanceAccountRow) {
  const currency = row.currency as Currency;
  return {
    ...row, currency, ledger: row.ledger as Ledger, type: row.type as AccountType,
    archived: row.archivedAt !== null,
    currentBalanceMinor: row.balanceMinor,
    amount: decimalFromMinor(row.balanceMinor, currency),
    amountFormatted: formatMoney(row.balanceMinor, currency),
  };
}

function presentBalance(row: FinanceBalanceRow, currency: Currency) {
  return { ...row, amount: decimalFromMinor(row.amountMinor, currency), amountFormatted: formatMoney(row.amountMinor, currency) };
}

export async function financeOverview(userId: string, ledger: Ledger, includeArchived = false, db: D1Database = database()) {
  const accounts = (await listFinanceAccounts(db, userId, ledger, includeArchived)).map(presentAccount);
  return {
    ledger, accounts, summary: buildFinanceSummary(accounts, ledger),
    meta: { today: todayShanghai(), ledgers: LEDGERS, accountTypes: ACCOUNT_TYPES, currencies: CURRENCIES },
  };
}

export async function financeAccountDetails(userId: string, accountId: string, db: D1Database = database()) {
  const snapshot = await findFinanceAccountSnapshot(db, userId, accountId);
  const row = snapshot.account;
  if (!row) return null;
  const account = presentAccount(row);
  const balances = snapshot.balances.map((entry) => presentBalance(entry, account.currency));
  const changes = await financeBalanceChangeHistory(db, userId, accountId);
  return { account, balances, history: balances, changes, classifications: snapshot.classifications };
}

export async function previewBalanceChange(userId: string, accountId: string, entryId: string, input: FinanceBalanceChangeInput, db: D1Database = database()) {
  return previewFinanceBalanceChange(db, userId, accountId, entryId, input);
}

export async function applyBalanceChange(userId: string, accountId: string, entryId: string, input: FinanceBalanceChangeInput, operationId: string, db: D1Database = database()) {
  if (!await changeFinanceBalance(db, userId, accountId, entryId, input, operationId)) return null;
  return financeAccountDetails(userId, accountId, db);
}

export async function newFinanceAccount(userId: string, input: NewFinanceAccount, idempotencyKey?: string, db: D1Database = database()) {
  const id = await createFinanceAccount(db, userId, input, undefined, idempotencyKey);
  return financeAccountDetails(userId, id, db);
}

export async function updateFinanceAccount(userId: string, accountId: string, patch: FinanceAccountPatch, db: D1Database = database()) {
  if (!await patchFinanceAccount(db, userId, accountId, patch)) return null;
  return financeAccountDetails(userId, accountId, db);
}

export async function newFinanceBalance(userId: string, accountId: string, input: NewFinanceBalance, idempotencyKey?: string, db: D1Database = database()) {
  const id = await appendFinanceBalance(db, userId, accountId, input, undefined, idempotencyKey);
  if (!id) return null;
  return financeAccountDetails(userId, accountId, db);
}

export async function financeExport(userId: string, ledger: Ledger, db: D1Database = database()) {
  const snapshot = await exportFinanceSnapshot(db, userId, ledger);
  const accounts = snapshot.accounts.map(presentAccount);
  const currencies = new Map(accounts.map((row) => [row.id, row.currency]));
  const balances = snapshot.balances.map((row) => presentBalance(row, currencies.get(row.accountId)!));
  return { version: 1, kind: 'jiashu-finance-backup', ledger, exportedAt: new Date().toISOString(), accounts, balances, classifications: snapshot.classifications };
}
