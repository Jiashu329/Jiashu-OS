import { FinanceBookError, type FinanceBookScope } from '../lib/finance-books.ts';

export interface FinanceBookCommand {
  operationId: string;
  requestHash: string;
  action: string;
  targetId?: string | null;
}

const financeTables = new Set(['finance_accounts', 'finance_account_classifications', 'finance_balance_entries', 'finance_balance_changes', 'finance_goal_plans', 'finance_runway_settings', 'finance_month_closes']);
const abort = 'abs(-9223372036854775808)';
const bookError = (code: string, status: number, message: string) => new FinanceBookError(code, status, message);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Restricts this adapter to application finance statements. SQL is server authored;
 * neither a request nor an imported backup may supply a statement to it. */
function isWrite(sql: string): boolean {
  const text = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, ' ').trim().replace(/;\s*$/, '');
  if (text.includes(';')) throw new Error('A finance statement must contain exactly one SQL command');
  if (/^(?:SELECT|WITH)\b/i.test(text) && !/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|DETACH)\b/i.test(text)) return false;
  const mutation = /^(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?([a-z_]+)["`]?\b/i.exec(text);
  if (!mutation || !financeTables.has(mutation[1].toLowerCase())) throw new Error('Only finance business tables may be changed through a finance book');
  return true;
}

/** Every execution, including early idempotency reads, checks the current grant
 * in the same D1 transaction as the business statements. Do not use for backups. */
export function financeBookDatabase(db: D1Database, scope: FinanceBookScope, command?: FinanceBookCommand): D1Database {
  if (!scope.bookId) return db;
  if (command && (!uuid.test(command.operationId) || !/^[0-9a-f]{64}$/.test(command.requestHash) || !command.action || command.action.length > 100)) throw bookError('FINANCE_BOOK_OPERATION_CONFLICT', 409, '提交标识或内容无效，请重新确认。');
  const statements = new WeakMap<object, { raw: D1PreparedStatement; write: boolean }>();
  const bookId = scope.bookId;
  const permissionSQL = `EXISTS (SELECT 1 FROM family_books b WHERE b.id=? AND b.owner_user_id=? AND (
    (?='owner' AND ?=b.owner_user_id AND ? IS NULL AND ?=0) OR
    (?='editor' AND EXISTS (SELECT 1 FROM family_book_members m WHERE m.id=? AND m.book_id=b.id AND m.user_id=? AND m.status='active' AND m.revision=?))
  )) AND (?=1 OR EXISTS (SELECT 1 FROM app_access_grants g WHERE g.bound_user_id=? AND g.status='active'))`;
  const permissionValues = [bookId, scope.ownerUserId, scope.role, scope.actorUserId, scope.membershipId, scope.accessRevision,
    scope.role, scope.membershipId, scope.actorUserId, scope.accessRevision, scope.isSiteOwner ? 1 : 0, scope.actorUserId];
  const permission = () => db.prepare(`SELECT CASE WHEN ${permissionSQL} THEN 1 ELSE ${abort} END AS allowed`).bind(...permissionValues);
  const receiptMatch = `actor_user_id=? AND membership_id IS ? AND access_revision=? AND request_hash=? AND action=? AND target_id IS ?`;
  const receiptValues = command ? [scope.actorUserId, scope.membershipId, scope.accessRevision, command.requestHash, command.action, command.targetId ?? null] : [];
  const legacySQL = `EXISTS (SELECT 1 FROM finance_accounts WHERE id=?) OR EXISTS (SELECT 1 FROM finance_balance_entries WHERE id=?) OR EXISTS (SELECT 1 FROM finance_balance_changes WHERE id=?) OR EXISTS (SELECT 1 FROM finance_goal_plans WHERE id=?) OR EXISTS (SELECT 1 FROM finance_month_closes WHERE user_id=? AND operation_id=?)`;
  const legacyValues = command ? [command.operationId, command.operationId, command.operationId, command.operationId, scope.ownerUserId, command.operationId] : [];
  const commandCondition = command ? `NOT EXISTS (SELECT 1 FROM family_finance_commands WHERE book_id=? AND operation_id=? AND NOT (${receiptMatch}))
    AND (?=? OR EXISTS (SELECT 1 FROM family_finance_commands WHERE book_id=? AND operation_id=?) OR NOT (${legacySQL}))` : '';
  const commandValues = command ? [bookId, command.operationId, ...receiptValues, scope.actorUserId, scope.ownerUserId, bookId, command.operationId, ...legacyValues] : [];
  const commandGuard = () => db.prepare(`SELECT CASE WHEN ${commandCondition} THEN 1 ELSE ${abort} END AS allowed`).bind(...commandValues);

  async function explain(error: unknown): Promise<never> {
    // Re-read only to classify an intentional SQL abort; never mask an unrelated
    // database/CAS failure when authorization and the command remain valid.
    const valid = await db.prepare(`SELECT (${permissionSQL}) AS allowed`).bind(...permissionValues).first<{ allowed: number }>();
    if (!valid?.allowed) {
      const member = scope.membershipId ? await db.prepare('SELECT status,revision,user_id AS userId FROM family_book_members WHERE id=? AND book_id=?').bind(scope.membershipId, bookId).first<{ status: string; revision: number; userId: string | null }>() : null;
      if (member?.status === 'active' && member.userId === scope.actorUserId && member.revision !== scope.accessRevision) throw bookError('FINANCE_BOOK_ACCESS_CHANGED', 409, '家庭账本授权已变化，请重新打开账本。原提交已保留。');
      throw bookError('FINANCE_BOOK_ACCESS_REVOKED', 403, '家庭账本访问已停用。原提交已保留，请联系账本所有者。');
    }
    if (command) {
      const validCommand = await db.prepare(`SELECT (${commandCondition}) AS allowed`).bind(...commandValues).first<{ allowed: number }>();
      if (!validCommand?.allowed) throw bookError('FINANCE_BOOK_OPERATION_CONFLICT', 409, '这次提交标识已用于其他操作者或内容，请核对记录后重新提交。');
    }
    throw error;
  }

  async function execute<T>(items: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const bound = items.map((statement) => {
      const entry = statements.get(statement);
      if (!entry) throw new Error('Finance book batches must use statements prepared by the same book adapter');
      return entry;
    });
    const writes = bound.some((entry) => entry.write);
    if (writes && !command) throw bookError('FINANCE_BOOK_COMMAND_REQUIRED', 400, '请使用有效提交标识保存家庭账本。');
    const guards = [permission(), ...(command ? [commandGuard()] : [])];
    const audit = writes && command ? [db.prepare(`INSERT INTO family_finance_commands
      (book_id,operation_id,actor_user_id,actor_name,actor_email,membership_id,access_revision,request_hash,action,target_id,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE changes()>0 ON CONFLICT(book_id,operation_id) DO NOTHING`).bind(bookId, command.operationId, scope.actorUserId, scope.actorName, scope.actorEmail, scope.membershipId, scope.accessRevision, command.requestHash, command.action, command.targetId ?? null, new Date().toISOString())] : [];
    try {
      const result = await db.batch<T>([...guards, ...bound.map((entry) => entry.raw), ...audit]);
      return result.slice(guards.length, guards.length + bound.length);
    } catch (error) { return explain(error); }
  }

  function prepare(sql: string, values: unknown[] = []): D1PreparedStatement {
    const write = isWrite(sql);
    const raw = values.length ? db.prepare(sql).bind(...values) : db.prepare(sql);
    const statement = {
      bind(...parameters: unknown[]) { return prepare(sql, parameters); },
      async all<T>() { return (await execute<T>([statement as unknown as D1PreparedStatement]))[0]; },
      async run<T>() { return (await execute<T>([statement as unknown as D1PreparedStatement]))[0]; },
      async first<T>(column?: string) {
        const row = (await execute<Record<string, unknown>>([statement as unknown as D1PreparedStatement]))[0].results[0];
        if (!row) return null;
        if (column === undefined) return row as T;
        if (!Object.hasOwn(row, column)) throw new Error(`D1_COLUMN_NOTFOUND: Column ${column} not found`);
        return row[column] as T;
      },
      async raw<T>(options?: { columnNames?: boolean }) {
        const rows = (await execute<Record<string, unknown>>([statement as unknown as D1PreparedStatement]))[0].results;
        const names = rows[0] ? Object.keys(rows[0]) : [];
        return [...(options?.columnNames ? [names] : []), ...rows.map((row) => names.map((name) => row[name]))] as T[];
      },
    };
    statements.set(statement, { raw, write });
    return statement as unknown as D1PreparedStatement;
  }
  return {
    prepare,
    batch<T>(items: D1PreparedStatement[]) { return execute<T>(items); },
    exec() { throw new Error('Finance book access requires prepared, guarded statements'); },
    dump() { throw new Error('A shared finance book cannot dump its database'); },
    withSession() { throw new Error('Finance book sessions must preserve the guarded adapter'); },
  } as unknown as D1Database;
}
