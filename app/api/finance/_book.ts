import { env } from 'cloudflare:workers';
import { FinanceBookError, parseFinanceBookId } from '../../../lib/finance-books';
import type { FinanceBookActor, FinanceBookScope } from '../../../lib/finance-books';
import type { LedgerKind } from '../../../lib/finance';
import { resolveFinanceBookScope } from '../../../db/finance-books-store';
import { financeBookDatabase } from '../../../db/finance-book-database';

interface FinanceScopeOptions {
  ledger?: LedgerKind;
  accountId?: string;
  goalId?: string;
  write?: { action: string; input: unknown; operationId?: string; targetId?: string };
}

function invalid(message: string): never { throw new FinanceBookError('FINANCE_BOOK_INVALID', 400, message); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
async function fingerprint(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value))));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The actor remains the logged-in account. Only this finance-specific boundary
 * can select another owner's family data; it is never used by full backups. */
export async function financeRequestScope(request: Request, actor: FinanceBookActor, options: FinanceScopeOptions = {}): Promise<{ scope: FinanceBookScope; db: D1Database }> {
  if (!env.DB) throw new Error('Finance database unavailable');
  const raw = env.DB, query = new URL(request.url).searchParams;
  for (const key of ['book', 'bookRevision']) if (query.getAll(key).length > 1) invalid('账本范围参数不能重复。');
  const book = parseFinanceBookId(query.get('book'));
  const revisionText = query.get('bookRevision');
  let accessRevision: number | undefined;
  if (revisionText !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(revisionText) || !Number.isSafeInteger(Number(revisionText))) invalid('请重新选择家庭账本，核对访问版本。');
    accessRevision = Number(revisionText);
  }
  let ledger: LedgerKind = options.ledger ?? (query.get('ledger') === 'family' || book !== 'own' ? 'family' : 'personal');
  let scope: FinanceBookScope;
  const resourceId = options.accountId ?? options.goalId;
  if (resourceId) {
    const table = options.accountId ? 'finance_accounts' : 'finance_goal_plans';
    if (book === 'own') {
      // Legacy ID routes omit ledger. Infer it only from an actor-owned resource,
      // never from a globally visible account or a request-supplied owner ID.
      const resource = await raw.prepare(`SELECT ledger FROM ${table} WHERE user_id=? AND id=?`).bind(actor.userId, resourceId).first<{ ledger: LedgerKind }>();
      if (!resource) throw new FinanceBookError(options.accountId ? 'FINANCE_ACCOUNT_NOT_FOUND' : 'FINANCE_GOAL_NOT_FOUND', 404, '找不到这条财务记录。');
      ledger = resource.ledger;
      if (options.ledger && options.ledger !== ledger) invalid('记录不属于所选账本。');
      scope = await resolveFinanceBookScope(raw, actor, ledger, 'own', accessRevision);
    } else {
      if (options.ledger && options.ledger !== 'family') invalid('协作权限只适用于所选家庭账本。');
      ledger = 'family';
      scope = await resolveFinanceBookScope(raw, actor, ledger, book, accessRevision);
      const scoped = financeBookDatabase(raw, scope);
      const resource = await scoped.prepare(`SELECT id FROM ${table} WHERE user_id=? AND ledger='family' AND id=?`).bind(scope.ownerUserId, resourceId).first<{ id: string }>();
      if (!resource) throw new FinanceBookError(options.accountId ? 'FINANCE_ACCOUNT_NOT_FOUND' : 'FINANCE_GOAL_NOT_FOUND', 404, '找不到这个家庭账本中的记录。');
    }
  } else {
    if (ledger !== 'personal' && ledger !== 'family') invalid('请选择个人账本或家庭账本。');
    if (ledger === 'personal' && book !== 'own') invalid('协作权限不能用于个人账本。');
    scope = await resolveFinanceBookScope(raw, actor, ledger, book, accessRevision);
  }
  if (scope.role === 'viewer' && options.write) throw new FinanceBookError('FINANCE_BOOK_READ_ONLY', 403, '你在这本家庭账本中拥有只读权限，不能修改记录。');
  if (scope.role === 'editor' && options.write && accessRevision === undefined) {
    throw new FinanceBookError('FINANCE_BOOK_ACCESS_CHANGED', 409, '请从家庭账本选择器重新打开协作账本；原提交保持原目标。');
  }
  if (!options.write) return { scope, db: financeBookDatabase(raw, scope) };
  const command = options.write;
  const operationId = command.operationId ?? crypto.randomUUID();
  const requestHash = await fingerprint([scope.bookId, scope.actorUserId, scope.membershipId, scope.accessRevision,
    command.action, command.targetId ?? null, command.input]);
  return { scope, db: financeBookDatabase(raw, scope, { operationId, requestHash, action: command.action, targetId: command.targetId }) };
}

export function publicFinanceBook(scope: FinanceBookScope) {
  return { id: scope.ledger === 'personal' ? 'personal' : scope.role === 'owner' ? 'own' : scope.bookId,
    role: scope.role, canWrite: scope.role !== 'viewer', accessRevision: scope.accessRevision, canManageMembers: scope.ledger === 'family' && scope.role === 'owner', canExport: scope.role === 'owner' };
}
export function assertFinanceBookExport(scope: FinanceBookScope): void {
  if (scope.role !== 'owner') throw new FinanceBookError('FINANCE_BOOK_OWNER_REQUIRED', 403, '仅账本拥有人可以导出这本家庭账本。');
}
