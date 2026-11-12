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

export async function financeOverview(userId: string, ledger: Ledger, includeArchived = false) {
  const accounts = (await listFinanceAccounts(database(), userId, ledger, includeArchived)).map(presentAccount);
  return {
    ledger, accounts, summary: buildFinanceSummary(accounts, ledger),
    meta: { today: todayShanghai(), ledgers: LEDGERS, accountTypes: ACCOUNT_TYPES, currencies: CURRENCIES },
  };
}

export async function financeAccountDetails(userId: string, accountId: string) {
  const snapshot = await findFinanceAccountSnapshot(database(), userId, accountId);
  const row = snapshot.account;
  if (!row) return null;
  const account = presentAccount(row);
  const balances = snapshot.balances.map((entry) => presentBalance(entry, account.currency));
  const changes = await financeBalanceChangeHistory(database(), userId, accountId);
  return { account, balances, history: balances, changes, classifications: snapshot.classifications };
}

export async function previewBalanceChange(userId: string, accountId: string, entryId: string, input: FinanceBalanceChangeInput) {
  return previewFinanceBalanceChange(database(), userId, accountId, entryId, input);
}

export async function applyBalanceChange(userId: string, accountId: string, entryId: string, input: FinanceBalanceChangeInput, operationId: string) {
  if (!await changeFinanceBalance(database(), userId, accountId, entryId, input, operationId)) return null;
  return financeAccountDetails(userId, accountId);
}

export async function newFinanceAccount(userId: string, input: NewFinanceAccount, idempotencyKey?: string) {
  const id = await createFinanceAccount(database(), userId, input, undefined, idempotencyKey);
  return financeAccountDetails(userId, id);
}

export async function updateFinanceAccount(userId: string, accountId: string, patch: FinanceAccountPatch) {
  if (!await patchFinanceAccount(database(), userId, accountId, patch)) return null;
  return financeAccountDetails(userId, accountId);
}

export async function newFinanceBalance(userId: string, accountId: string, input: NewFinanceBalance, idempotencyKey?: string) {
  const id = await appendFinanceBalance(database(), userId, accountId, input, undefined, idempotencyKey);
  if (!id) return null;
  return financeAccountDetails(userId, accountId);
}

export async function financeExport(userId: string, ledger: Ledger) {
  const snapshot = await exportFinanceSnapshot(database(), userId, ledger);
  const accounts = snapshot.accounts.map(presentAccount);
  const currencies = new Map(accounts.map((row) => [row.id, row.currency]));
  const balances = snapshot.balances.map((row) => presentBalance(row, currencies.get(row.accountId)!));
  return { version: 1, kind: 'jiashu-finance-backup', ledger, exportedAt: new Date().toISOString(), accounts, balances, classifications: snapshot.classifications };
}
