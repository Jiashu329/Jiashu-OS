import { FinanceBookError, type FinanceBookActor } from '../lib/finance-books.ts';
import { resolveFinanceBookScope, type FinanceBooksDatabase } from './finance-books-store.ts';
import { financeBookDatabase } from './finance-book-database.ts';

export interface FinanceBookActivity {
  id: string; actorName: string; action: string; targetId: string | null;
  targetName: string | null; createdAt: string; summary: string;
}
export interface FinanceBookActivityOptions { offset?: number; limit?: number; accessRevision?: number; excludeActor?: boolean }
const descriptions: Record<string, string> = {
  'account.create': '新增了账户', 'account.update': '更新了账户资料',
  'balance.append': '记录了余额', 'balance.correct': '更正了余额记录', 'balance.void': '作废了余额记录',
  'balance.restore': '恢复了余额记录', 'goal.create': '新增了资金目标', 'goal.update': '更新了资金目标',
  'runway.update': '更新了应急储备设置', 'review.close': '确认了月度结算',
  'member.invite.editor': '邀请了可编辑成员', 'member.invite.viewer': '邀请了只读成员',
  'member.revoke': '撤销了成员访问', 'member.role.editor': '将成员权限改为可编辑',
  'member.role.viewer': '将成员权限改为只读', 'member.accept': '接受了家庭账本邀请', 'member.decline': '婉拒了家庭账本邀请',
};

/** A feed read rechecks the current grant inside the same transaction as its
 * query. Receipts, actor IDs, member IDs and request hashes stay server-only. */
export async function listFinanceBookActivity(db: FinanceBooksDatabase, actor: FinanceBookActor, bookId = 'own', options: FinanceBookActivityOptions = {}) {
  const offset = options.offset ?? 0, limit = options.limit ?? 30;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new FinanceBookError('FINANCE_BOOK_INVALID', 400, '请提交有效的活动分页参数。');
  const scope = await resolveFinanceBookScope(db, actor, 'family', bookId, options.accessRevision);
  if (!scope.bookId) return { items: [] as FinanceBookActivity[], offset, limit, hasMore: false };
  const guarded = financeBookDatabase(db as D1Database, scope);
  const exclusion = options.excludeActor === true ? ' AND actor_user_id<>?' : '';
  const exclusions = options.excludeActor === true ? [scope.actorUserId] : [];
  const result = await guarded.prepare(`SELECT id,actorName,action,targetId,targetName,createdAt FROM (
    SELECT 'finance:'||c.operation_id AS id,c.actor_name AS actorName,c.action,c.target_id AS targetId,
      COALESCE(
        (SELECT a.name FROM finance_accounts a WHERE a.id=c.target_id AND a.user_id=? AND a.ledger='family'),
        (SELECT a.name FROM finance_balance_entries e JOIN finance_accounts a ON a.id=e.account_id AND a.user_id=e.user_id WHERE e.id=c.target_id AND e.user_id=? AND a.ledger='family'),
        (SELECT g.name FROM finance_goal_plans g WHERE g.id=c.target_id AND g.user_id=? AND g.ledger='family')
      ) AS targetName,c.created_at AS createdAt
      FROM family_finance_commands c WHERE c.book_id=?${exclusion}
    UNION ALL
    SELECT 'member:'||id AS id,actor_name AS actorName,action,NULL AS targetId,target_name AS targetName,created_at AS createdAt
      FROM family_book_activity WHERE book_id=?${exclusion}
  ) ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?`).bind(scope.ownerUserId, scope.ownerUserId, scope.ownerUserId,
    scope.bookId, ...exclusions, scope.bookId, ...exclusions, limit + 1, offset).all<Omit<FinanceBookActivity, 'summary'>>();
  return { items: result.results.slice(0, limit).map((item) => ({ ...item,
    summary: descriptions[item.action] ?? '更新了家庭账本' })), offset, limit, hasMore: result.results.length > limit };
}
