import { EFFECTIVE_FINANCE_BALANCES } from './finance-effective-balances.ts';
/** SQL persistence is independent of Worker globals so it can be exercised on SQLite. */
export type FinanceDatabase = Pick<D1Database, 'prepare' | 'batch'>;

export interface FinanceAccountRow {
  id: string; ledger: string; name: string; type: string; currency: string; note: string;
  createdAt: string; updatedAt: string; archivedAt: string | null;
  balanceMinor: string; asOfDate: string; balanceUpdatedAt: string;
  balanceRevision: number;
  metadataRevision: number;
}
export interface FinanceBalanceRow {
  id: string; accountId: string; amountMinor: string; asOfDate: string; note: string; createdAt: string;
  sequence?: number;
  revision?: number; status?: 'active' | 'corrected' | 'void';
  originalAmountMinor?: string; originalAsOfDate?: string; originalNote?: string;
  changeReason?: string | null; changedAt?: string | null;
}
export interface NewFinanceAccount {
  ledger: string; name: string; type: string; currency: string; note: string; amountMinor: string; asOfDate: string;
}
export interface NewFinanceBalance { amountMinor: string; asOfDate: string; note: string }
export interface FinanceAccountPatch { name?: string; type?: string; note?: string; archived?: boolean; expectedRevision: number }

export class FinanceMetadataConflictError extends Error {
  readonly code = 'FINANCE_METADATA_CONFLICT';
  constructor(message = '账户或目标已经更新。你的填写已保留，请读取最新内容，核对后再保存。') { super(message); this.name = 'FinanceMetadataConflictError'; }
}

export class FinanceIdempotencyConflictError extends Error {
  constructor() { super('The submission key is already bound to different finance data'); this.name = 'FinanceIdempotencyConflictError'; }
}

async function creationFingerprint(input: NewFinanceAccount) {
  const bytes = new TextEncoder().encode(JSON.stringify([input.ledger, input.name, input.type, input.currency, input.note, input.amountMinor, input.asOfDate]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((part) => part.toString(16).padStart(2, '0')).join('');
}

async function accountOperation(db: FinanceDatabase, id: string) {
  return db.prepare('SELECT user_id AS userId, creation_hash AS creationHash FROM finance_accounts WHERE id = ?')
    .bind(id).first<{ userId: string; creationHash: string | null }>();
}

async function balanceOperation(db: FinanceDatabase, id: string) {
  return db.prepare(`SELECT user_id AS userId, account_id AS accountId, amount_minor AS amountMinor,
    as_of_date AS asOfDate, note FROM finance_balance_entries WHERE id = ?`)
    .bind(id).first<{ userId: string; accountId: string; amountMinor: string; asOfDate: string; note: string }>();
}

const accountSelect = `SELECT a.id, a.ledger, a.name, a.type, a.currency, a.note,
  a.balance_revision AS balanceRevision, a.metadata_revision AS metadataRevision,
  a.created_at AS createdAt, a.updated_at AS updatedAt, a.archived_at AS archivedAt,
  b.amount_minor AS balanceMinor, b.as_of_date AS asOfDate, b.created_at AS balanceUpdatedAt
  FROM finance_accounts a JOIN (${EFFECTIVE_FINANCE_BALANCES}) b ON b.sequence = (
    SELECT newest.sequence FROM (${EFFECTIVE_FINANCE_BALANCES}) newest
    WHERE newest.account_id = a.id AND newest.user_id = a.user_id
    ORDER BY newest.as_of_date DESC, newest.sequence DESC LIMIT 1
  )`;

function accountListStatement(db: FinanceDatabase, userId: string, ledger: string, includeArchived: boolean) {
  return db.prepare(accountSelect + ` WHERE a.user_id = ? AND a.ledger = ?
    ${includeArchived ? '' : 'AND a.archived_at IS NULL'}
    ORDER BY (a.archived_at IS NOT NULL), a.name COLLATE NOCASE, a.id`).bind(userId, ledger);
}

function balanceExportStatement(db: FinanceDatabase, userId: string, ledger: string) {
  return db.prepare(`SELECT b.id, b.account_id AS accountId, b.amount_minor AS amountMinor,
    b.as_of_date AS asOfDate, b.note, b.created_at AS createdAt
    FROM (${EFFECTIVE_FINANCE_BALANCES}) b JOIN finance_accounts a ON a.id = b.account_id AND a.user_id = b.user_id
    WHERE b.user_id = ? AND a.ledger = ? ORDER BY b.account_id, b.as_of_date DESC, b.sequence DESC`)
    .bind(userId, ledger);
}

function balanceHistoryStatement(db: FinanceDatabase, userId: string, accountId: string) {
  return db.prepare(`SELECT b.id, b.sequence, b.account_id AS accountId,
    COALESCE(c.amount_minor, b.amount_minor) AS amountMinor,
    COALESCE(c.as_of_date, b.as_of_date) AS asOfDate,
    COALESCE(c.note, b.note) AS note, b.created_at AS createdAt,
    b.amount_minor AS originalAmountMinor, b.as_of_date AS originalAsOfDate, b.note AS originalNote,
    COALESCE(c.revision, 0) AS revision,
    CASE WHEN c.action = 'void' THEN 'void' WHEN c.action = 'correct' THEN 'corrected' ELSE 'active' END AS status,
    c.reason AS changeReason, c.created_at AS changedAt
    FROM finance_balance_entries b JOIN finance_accounts a ON a.id = b.account_id AND a.user_id = b.user_id
    LEFT JOIN finance_balance_changes c ON c.sequence = (
      SELECT latest.sequence FROM finance_balance_changes latest
      WHERE latest.user_id = b.user_id AND latest.entry_id = b.id ORDER BY latest.revision DESC LIMIT 1
    )
    WHERE b.user_id = ? AND b.account_id = ?
    ORDER BY COALESCE(c.as_of_date, b.as_of_date) DESC, b.sequence DESC`).bind(userId, accountId);
}

export async function listFinanceAccounts(db: FinanceDatabase, userId: string, ledger: string, includeArchived = false): Promise<FinanceAccountRow[]> {
  const rows = await accountListStatement(db, userId, ledger, includeArchived).all<FinanceAccountRow>();
  return rows.results;
}

export async function findFinanceAccount(db: FinanceDatabase, userId: string, accountId: string): Promise<FinanceAccountRow | null> {
  return db.prepare(accountSelect + ' WHERE a.user_id = ? AND a.id = ? LIMIT 1').bind(userId, accountId).first<FinanceAccountRow>();
}

export async function findFinanceAccountSnapshot(db: FinanceDatabase, userId: string, accountId: string): Promise<{ account: FinanceAccountRow | null; balances: FinanceBalanceRow[] }> {
  const result = await db.batch<FinanceAccountRow | FinanceBalanceRow>([
    db.prepare(accountSelect + ' WHERE a.user_id = ? AND a.id = ? LIMIT 1').bind(userId, accountId),
    balanceHistoryStatement(db, userId, accountId),
  ]);
  return { account: (result[0].results[0] as FinanceAccountRow | undefined) ?? null, balances: result[1].results as FinanceBalanceRow[] };
}

export async function createFinanceAccount(db: FinanceDatabase, userId: string, input: NewFinanceAccount, now = new Date().toISOString(), idempotencyKey?: string): Promise<string> {
  const accountId = idempotencyKey ?? crypto.randomUUID();
  const fingerprint = await creationFingerprint(input);
  const existing = await accountOperation(db, accountId);
  if (existing) {
    if (existing.userId === userId && existing.creationHash === fingerprint) return accountId;
    throw new FinanceIdempotencyConflictError();
  }
  if (await balanceOperation(db, accountId)) throw new FinanceIdempotencyConflictError();
  await db.batch([
    db.prepare(`INSERT INTO finance_accounts
      (id, user_id, ledger, name, type, currency, note, created_at, updated_at, archived_at, creation_hash)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ? WHERE NOT EXISTS (
        SELECT 1 FROM finance_balance_entries WHERE id = ?
      ) ON CONFLICT(id) DO NOTHING`)
      .bind(accountId, userId, input.ledger, input.name, input.type, input.currency, input.note, now, now, fingerprint, accountId),
    db.prepare(`INSERT INTO finance_balance_entries
      (id, user_id, account_id, amount_minor, as_of_date, note, created_at)
      SELECT ?, ?, ?, ?, ?, ?, a.created_at FROM finance_accounts a
      WHERE a.id = ? AND a.user_id = ? AND a.creation_hash = ?
      ON CONFLICT(id) DO NOTHING`)
      .bind('initial:' + accountId, userId, accountId, input.amountMinor, input.asOfDate, '初始余额', accountId, userId, fingerprint),
  ]);
  const completed = await accountOperation(db, accountId);
  if (!completed || completed.userId !== userId || completed.creationHash !== fingerprint) throw new FinanceIdempotencyConflictError();
  return accountId;
}

export async function patchFinanceAccount(db: FinanceDatabase, userId: string, accountId: string, patch: FinanceAccountPatch, now = new Date().toISOString()): Promise<boolean> {
  if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 1) throw new FinanceMetadataConflictError('账户版本缺失，请重新读取账户后保存。');
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  for (const key of ['name', 'type', 'note'] as const) {
    if (patch[key] !== undefined) { assignments.push(`${key} = ?`); values.push(patch[key]!); }
  }
  if (patch.archived !== undefined) { assignments.push('archived_at = ?'); values.push(patch.archived ? now : null); }
  if (!assignments.length) return false;
  assignments.push('updated_at = ?', 'metadata_revision = metadata_revision + 1'); values.push(now, userId, accountId, patch.expectedRevision);
  const result = await db.prepare(`UPDATE finance_accounts SET ${assignments.join(', ')} WHERE user_id = ? AND id = ? AND metadata_revision = ?`).bind(...values).run();
  if (result.meta.changes === 1) return true;
  if (await findFinanceAccount(db, userId, accountId)) throw new FinanceMetadataConflictError();
  return false;
}

export async function appendFinanceBalance(db: FinanceDatabase, userId: string, accountId: string, input: NewFinanceBalance, now = new Date().toISOString(), idempotencyKey?: string): Promise<string | null> {
  const entryId = idempotencyKey ?? crypto.randomUUID();
  const matches = (entry: { userId: string; accountId: string; amountMinor: string; asOfDate: string; note: string }) =>
    entry.userId === userId && entry.accountId === accountId && entry.amountMinor === input.amountMinor
      && entry.asOfDate === input.asOfDate && entry.note === input.note;
  const existing = await balanceOperation(db, entryId);
  if (existing) {
    if (matches(existing)) return entryId;
    throw new FinanceIdempotencyConflictError();
  }
  if (await accountOperation(db, entryId)) throw new FinanceIdempotencyConflictError();
  const results = await db.batch([
    db.prepare(`INSERT INTO finance_balance_entries
      (id, user_id, account_id, amount_minor, as_of_date, note, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM finance_accounts WHERE user_id = ? AND id = ? AND archived_at IS NULL
      ) AND NOT EXISTS (SELECT 1 FROM finance_accounts WHERE id = ?)
      ON CONFLICT(id) DO NOTHING`).bind(entryId, userId, accountId, input.amountMinor, input.asOfDate, input.note, now, userId, accountId, entryId),
    db.prepare(`UPDATE finance_accounts SET updated_at = ?, balance_revision = balance_revision + 1 WHERE user_id = ? AND id = ?
      AND changes() = 1
      AND EXISTS (SELECT 1 FROM finance_balance_entries WHERE id = ? AND user_id = ? AND account_id = ?)`)
      .bind(now, userId, accountId, entryId, userId, accountId),
  ]);
  const completed = await balanceOperation(db, entryId);
  if (completed) {
    if (matches(completed)) return entryId;
    throw new FinanceIdempotencyConflictError();
  }
  if (await accountOperation(db, entryId)) throw new FinanceIdempotencyConflictError();
  return results[0].meta.changes === 1 ? entryId : null;
}

export async function listFinanceBalances(db: FinanceDatabase, userId: string, accountId: string): Promise<FinanceBalanceRow[]> {
  const rows = await balanceHistoryStatement(db, userId, accountId).all<FinanceBalanceRow>();
  return rows.results;
}

export async function exportFinanceBalances(db: FinanceDatabase, userId: string, ledger: string): Promise<FinanceBalanceRow[]> {
  const rows = await balanceExportStatement(db, userId, ledger).all<FinanceBalanceRow>();
  return rows.results;
}

/** D1 batch executes both reads in one transaction, keeping backup records consistent. */
export async function exportFinanceSnapshot(db: FinanceDatabase, userId: string, ledger: string): Promise<{ accounts: FinanceAccountRow[]; balances: FinanceBalanceRow[] }> {
  const result = await db.batch<FinanceAccountRow | FinanceBalanceRow>([
    accountListStatement(db, userId, ledger, true),
    balanceExportStatement(db, userId, ledger),
  ]);
  return { accounts: result[0].results as FinanceAccountRow[], balances: result[1].results as FinanceBalanceRow[] };
}
