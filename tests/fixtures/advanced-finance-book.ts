import { FinanceBookError } from '../../lib/finance-books.ts';
import type { FinanceBookScope } from '../../lib/finance-books.ts';

export const SHARED_FINANCE_BOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export interface AdvancedScopeOptions {
  ledger?: 'personal' | 'family'; accountId?: string; goalId?: string;
  write?: { action: string; input: unknown; operationId?: string; targetId?: string };
}

/** Request-boundary substitute only; accounting and SQLite stores remain real. */
export function advancedFinanceBookFixture(db: D1Database, resourceLedger: (options: AdvancedScopeOptions, owner: string) => 'personal' | 'family' | undefined, storageReady: () => boolean = () => true) {
  let revoked = false;
  const calls: Array<{ actorUserId: string; ownerUserId: string; options: AdvancedScopeOptions }> = [];
  const financeRequestScope = async (request: Request, actor: { userId: string }, options: AdvancedScopeOptions = {}) => {
    if (!storageReady()) throw new Error('Finance database unavailable');
    const params = new URL(request.url).searchParams;
    const rawBook = params.get('book'), book = rawBook === 'own' ? null : rawBook;
    const ownerUserId = book ? 'alice' : actor.userId;
    const resource = resourceLedger(options, ownerUserId);
    const ledger = options.ledger ?? (book ? 'family' : resource ?? 'personal');
    if (book && ledger !== 'family') throw new FinanceBookError('FINANCE_BOOK_INVALID', 400, 'Family books only');
    if (book && (options.goalId || options.accountId) && resource !== 'family') throw new FinanceBookError(options.goalId ? 'FINANCE_GOAL_NOT_FOUND' : 'FINANCE_ACCOUNT_NOT_FOUND', 404, 'Not in selected book');
    if (book && book !== SHARED_FINANCE_BOOK) throw new FinanceBookError('FINANCE_BOOK_ACCESS_REVOKED', 403, 'Access revoked');
    if (book && (ledger !== 'family' || !['alice', 'bob'].includes(actor.userId) || revoked)) throw new FinanceBookError('FINANCE_BOOK_ACCESS_REVOKED', 403, 'Access revoked');
    const editor = Boolean(book && actor.userId !== ownerUserId);
    if (editor && options.write && params.get('bookRevision') !== '3') throw new FinanceBookError('FINANCE_BOOK_ACCESS_CHANGED', 409, 'Access changed');
    const scope: FinanceBookScope = {
      actorUserId: actor.userId, actorEmail: actor.userId + '@example.test', actorName: actor.userId,
      ownerUserId, ledger, bookId: book, role: editor ? 'editor' : 'owner',
      membershipId: editor ? 'synthetic-membership' : null, accessRevision: editor ? 3 : 0, isSiteOwner: false,
    };
    calls.push({ actorUserId: actor.userId, ownerUserId, options });
    return { scope, db };
  };
  return {
    FinanceBookError, financeRequestScope, calls,
    revoke() { revoked = true; },
    publicFinanceBook(scope: FinanceBookScope) {
      return { id: scope.bookId, role: scope.role, accessRevision: scope.accessRevision, canExport: scope.role === 'owner' };
    },
    assertFinanceBookExport(scope: FinanceBookScope) {
      if (scope.role !== 'owner') throw new FinanceBookError('FINANCE_BOOK_EXPORT_FORBIDDEN', 403, 'Only the book owner can export');
    },
  };
}
