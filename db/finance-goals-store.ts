import { FinanceIdempotencyConflictError } from './finance-store.ts';
import { FinanceGoalValidationError } from '../lib/finance-goals.ts';
import type { FinanceGoalCreate, FinanceGoalPatch, FinanceGoalPlan } from '../lib/finance-goals.ts';
import type { CurrencyCode, LedgerKind } from '../lib/finance.ts';

export type FinanceGoalsDatabase = Pick<D1Database, 'prepare' | 'batch'>;
interface GoalRow {
  id: string; userId: string; ledger: LedgerKind; currency: CurrencyCode; name: string;
  targetMinor: string; deadline: string; accountIdsJson: string; creationHash: string;
  createdAt: string; updatedAt: string; archivedAt: string | null;
}
const columns = `id, user_id AS userId, ledger, currency, name, target_minor AS targetMinor,
  deadline, account_ids_json AS accountIdsJson, creation_hash AS creationHash,
  created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt`;
const validAccounts = `SELECT COUNT(*) FROM finance_accounts WHERE user_id = ? AND ledger = ? AND currency = ?
  AND archived_at IS NULL AND type IN ('cash','bank','investment','property','receivable','other_asset')
  AND id IN (SELECT value FROM json_each(?))`;
function plan(row: GoalRow): FinanceGoalPlan {
  const { accountIdsJson, ...rest } = row;
  return { ...rest, accountIds: JSON.parse(accountIdsJson) as string[] };
}
function invalidAccounts(): never { throw new FinanceGoalValidationError([{ path: 'accountIds', message: '关联账户必须是你在同一账本、同一币种下的未归档资产账户，请重新选择。' }]); }
async function checkAccounts(db: FinanceGoalsDatabase, userId: string, input: Pick<FinanceGoalCreate, 'ledger' | 'currency' | 'accountIds'>) {
  const count = await db.prepare('SELECT (' + validAccounts + ') AS total')
    .bind(userId, input.ledger, input.currency, JSON.stringify(input.accountIds)).first<{ total: number }>();
  if (count?.total !== input.accountIds.length) invalidAccounts();
}
async function creationFingerprint(input: FinanceGoalCreate) {
  const encoded = JSON.stringify([input.ledger, input.currency, input.name, input.targetMinor, input.deadline, input.accountIds]);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded)))]
    .map((part) => part.toString(16).padStart(2, '0')).join('');
}

export async function readFinanceGoalPlans(db: FinanceGoalsDatabase, userId: string, ledger: LedgerKind, currency: 'all' | CurrencyCode, includeArchived = false): Promise<FinanceGoalPlan[]> {
  const rows = await db.prepare(`SELECT ${columns} FROM finance_goal_plans WHERE user_id = ? AND ledger = ?
    AND (? = 'all' OR currency = ?) ${includeArchived ? '' : 'AND archived_at IS NULL'}
    ORDER BY (archived_at IS NOT NULL), updated_at DESC, id`).bind(userId, ledger, currency, currency).all<GoalRow>();
  return rows.results.map(plan);
}

export async function findFinanceGoalPlan(db: FinanceGoalsDatabase, userId: string, id: string): Promise<FinanceGoalPlan | null> {
  const row = await db.prepare(`SELECT ${columns} FROM finance_goal_plans WHERE user_id = ? AND id = ?`).bind(userId, id).first<GoalRow>();
  return row ? plan(row) : null;
}

export async function createFinanceGoalPlan(db: FinanceGoalsDatabase, userId: string, input: FinanceGoalCreate, key: string, now = new Date().toISOString()): Promise<FinanceGoalPlan> {
  const hash = await creationFingerprint(input);
  const existing = await db.prepare(`SELECT ${columns} FROM finance_goal_plans WHERE id = ?`).bind(key).first<GoalRow>();
  if (existing) {
    if (existing.userId === userId && existing.creationHash === hash) return plan(existing);
    throw new FinanceIdempotencyConflictError();
  }
  await checkAccounts(db, userId, input);
  const ids = JSON.stringify(input.accountIds);
  const result = await db.batch<GoalRow>([
    db.prepare(`INSERT INTO finance_goal_plans
      (id, user_id, ledger, currency, name, target_minor, deadline, account_ids_json, creation_hash, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (${validAccounts}) = ?
      ON CONFLICT(id) DO NOTHING`)
      .bind(key, userId, input.ledger, input.currency, input.name, input.targetMinor, input.deadline, ids, hash, now, now,
        userId, input.ledger, input.currency, ids, input.accountIds.length),
    db.prepare(`SELECT ${columns} FROM finance_goal_plans WHERE id = ?`).bind(key),
  ]);
  const created = result[1].results[0];
  if (created) {
    if (created.userId === userId && created.creationHash === hash) return plan(created);
    throw new FinanceIdempotencyConflictError();
  }
  return invalidAccounts();
}

export async function patchFinanceGoalPlan(db: FinanceGoalsDatabase, userId: string, id: string, patch: FinanceGoalPatch, now = new Date().toISOString()): Promise<FinanceGoalPlan | null> {
  const existing = await findFinanceGoalPlan(db, userId, id);
  if (!existing) return null;
  if (patch.accountIds) await checkAccounts(db, userId, { ledger: existing.ledger, currency: existing.currency, accountIds: patch.accountIds });
  const assignments: string[] = [];
  const values: (string | null)[] = [];
  for (const [key, column] of [['name', 'name'], ['targetMinor', 'target_minor'], ['deadline', 'deadline']] as const) {
    if (patch[key] !== undefined) { assignments.push(column + ' = ?'); values.push(patch[key]!); }
  }
  if (patch.accountIds) { assignments.push('account_ids_json = ?'); values.push(JSON.stringify(patch.accountIds)); }
  if (patch.archived !== undefined) { assignments.push('archived_at = ?'); values.push(patch.archived ? existing.archivedAt ?? now : null); }
  if (!assignments.length) return existing;
  assignments.push('updated_at = ?');
  const condition = patch.accountIds ? `AND (${validAccounts}) = ?` : '';
  const accountParams = patch.accountIds ? [userId, existing.ledger, existing.currency, JSON.stringify(patch.accountIds), patch.accountIds.length] : [];
  const result = await db.batch<GoalRow>([
    db.prepare(`UPDATE finance_goal_plans SET ${assignments.join(', ')} WHERE user_id = ? AND id = ? ${condition}`)
      .bind(...values, now, userId, id, ...accountParams),
    db.prepare(`SELECT ${columns} FROM finance_goal_plans WHERE user_id = ? AND id = ?`).bind(userId, id),
  ]);
  const updated = result[1].results[0];
  if (!updated) return null;
  if (result[0].meta.changes !== 1) return invalidAccounts();
  return plan(updated);
}
