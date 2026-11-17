import {
  FinanceBookError, financeBookAccessChanged, financeBookAccessRevoked, normalizeFinanceBookActor,
  parseFinanceBookId, parseFinanceBookInvite, parseFinanceBookMemberAction,
} from '../lib/finance-books.ts';
import type { FinanceBookActor, FinanceBookChoice, FinanceBookInvitation, FinanceBookMember, FinanceBookPublic, FinanceBookScope } from '../lib/finance-books.ts';
import { normalizeTimestamp } from '../lib/health.ts';

export type FinanceBooksDatabase = Pick<D1Database, 'prepare' | 'batch'>;
export interface FamilyBookRecord { id: string; ownerUserId: string; ownerEmail: string; ownerName: string; name: string; createdAt: string; updatedAt: string }
interface MemberRow extends Omit<FinanceBookMember, 'bound'> { userId: string | null }
interface OperationRow { actorUserId: string; bookId: string; memberId: string; requestHash: string }
const bookColumns = 'id,owner_user_id AS ownerUserId,owner_email AS ownerEmail,owner_name AS ownerName,name,created_at AS createdAt,updated_at AS updatedAt';
const memberColumns = 'id,book_id AS bookId,email,user_id AS userId,status,role,revision,expires_at AS expiresAt,accepted_at AS acceptedAt,created_at AS createdAt,updated_at AS updatedAt';
const conflict = (message = '家庭成员状态已变化，请重新读取后核对原操作。') => new FinanceBookError('FINANCE_BOOK_MEMBER_CHANGED', 409, message);
const ownerRequired = () => new FinanceBookError('FINANCE_BOOK_OWNER_REQUIRED', 403, '只有这本家庭账本的创建者可以管理成员。');
function instant(value: string): string { const normalized = normalizeTimestamp(value); if (!normalized) throw new FinanceBookError('FINANCE_BOOK_INVALID', 400, '操作时间无效，请重试。'); return normalized; }
function present(row: MemberRow): FinanceBookMember { const { userId, ...visible } = row; return { ...visible, bound: userId !== null }; }
function publicBook(book: FamilyBookRecord | null, actor: ReturnType<typeof normalizeFinanceBookActor>): FinanceBookPublic {
  return { id: book?.id ?? 'own', name: book?.name ?? '我的家庭账本', ownerName: book?.ownerName ?? actor.displayName, createdAt: book?.createdAt ?? null, updatedAt: book?.updatedAt ?? null };
}
async function ownBook(db: FinanceBooksDatabase, userId: string) { return db.prepare(`SELECT ${bookColumns} FROM family_books WHERE owner_user_id=?`).bind(userId).first<FamilyBookRecord>(); }
async function readBook(db: FinanceBooksDatabase, id: string) { return db.prepare(`SELECT ${bookColumns} FROM family_books WHERE id=?`).bind(id).first<FamilyBookRecord>(); }
async function member(db: FinanceBooksDatabase, id: string) { return db.prepare(`SELECT ${memberColumns} FROM family_book_members WHERE id=?`).bind(id).first<MemberRow>(); }
async function hash(value: unknown) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map((part) => part.toString(16).padStart(2, '0')).join(''); }
function expectedRace(error: unknown) { return error instanceof Error && /UNIQUE constraint|integer overflow/.test(error.message); }

/** Existing finance rows retain their original user_id; creating a book only enables sharing. */
export async function ensureOwnFamilyBook(db: FinanceBooksDatabase, value: FinanceBookActor, now = new Date().toISOString()): Promise<FamilyBookRecord> {
  const actor = normalizeFinanceBookActor(value), timestamp = instant(now);
  const existing = await ownBook(db, actor.userId); if (existing) return existing;
  await db.prepare(`INSERT INTO family_books(id,owner_user_id,owner_email,owner_name,name,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner_user_id) DO NOTHING`).bind(crypto.randomUUID(), actor.userId, actor.email, actor.displayName, '我的家庭账本', timestamp, timestamp).run();
  const book = await ownBook(db, actor.userId); if (!book) throw new Error('Family book was not created'); return book;
}

export async function resolveFinanceBookScope(db: FinanceBooksDatabase, value: FinanceBookActor, ledger: 'personal' | 'family', bookId?: string | null, accessRevision?: number): Promise<FinanceBookScope> {
  const actor = normalizeFinanceBookActor(value), selected = parseFinanceBookId(bookId);
  if (ledger !== 'personal' && ledger !== 'family') throw new FinanceBookError('FINANCE_BOOK_INVALID', 400, '请选择个人或家庭账本。');
  if (ledger === 'personal' && selected !== 'own') throw new FinanceBookError('FINANCE_BOOK_INVALID', 400, '个人账本不能使用家庭共享身份。');
  const base = { actorUserId: actor.userId, actorEmail: actor.email, actorName: actor.displayName, ledger,
    isSiteOwner: actor.isOwner === true, localAccountRevision: actor.localAccountRevision };
  const book = ledger === 'personal' ? null : selected === 'own' ? await ownBook(db, actor.userId) : await readBook(db, selected);
  if (selected === 'own' || book?.ownerUserId === actor.userId) {
    if (accessRevision !== undefined && accessRevision !== 0) throw financeBookAccessChanged();
    return { ...base, ownerUserId: actor.userId, bookId: book?.id ?? null, role: 'owner', canWrite: true, membershipId: null, accessRevision: 0 };
  }
  if (!book) throw financeBookAccessRevoked();
  const grant = await db.prepare(`SELECT ${memberColumns} FROM family_book_members WHERE book_id=? AND user_id=? AND status='active'`).bind(book.id, actor.userId).first<MemberRow>();
  if (!grant) throw financeBookAccessRevoked();
  if (accessRevision !== undefined && accessRevision !== grant.revision) throw financeBookAccessChanged();
  return { ...base, ownerUserId: book.ownerUserId, bookId: book.id, role: grant.role, canWrite: grant.role === 'editor', membershipId: grant.id, accessRevision: grant.revision };
}

export async function listFinanceBooks(db: FinanceBooksDatabase, value: FinanceBookActor, now = new Date().toISOString()): Promise<{ books: FinanceBookChoice[]; invitations: FinanceBookInvitation[] }> {
  const actor = normalizeFinanceBookActor(value), timestamp = instant(now), own = await ownBook(db, actor.userId);
  const shared = await db.prepare(`SELECT b.id,b.name,b.owner_name AS ownerName,m.revision AS accessRevision,m.role FROM family_books b
    JOIN family_book_members m ON m.book_id=b.id WHERE m.user_id=? AND m.status='active' AND b.owner_user_id<>? ORDER BY b.created_at,b.id`).bind(actor.userId, actor.userId).all<{ id: string; name: string; ownerName: string; accessRevision: number; role: 'editor' | 'viewer' }>();
  const pending = await db.prepare(`SELECT m.id,m.book_id AS bookId,b.name AS bookName,b.owner_name AS ownerName,m.email,m.role,m.revision,m.created_at AS createdAt,m.expires_at AS expiresAt
    FROM family_book_members m JOIN family_books b ON b.id=m.book_id
    WHERE m.email=? AND m.status='pending' AND m.expires_at>? AND (m.user_id IS NULL OR m.user_id=?) AND b.owner_user_id<>?
    ORDER BY m.created_at,m.id`).bind(actor.email, timestamp, actor.userId, actor.userId).all<FinanceBookInvitation>();
  return { books: [{ id: 'own', name: own?.name ?? '我的家庭账本', ownerName: actor.displayName, role: 'owner', accessRevision: 0, canWrite: true, canManageMembers: true, canExport: true },
    ...shared.results.map((row): FinanceBookChoice => ({ ...row, canWrite: row.role === 'editor', canManageMembers: false, canExport: false }))], invitations: pending.results };
}

async function requireBookOwner(db: FinanceBooksDatabase, actor: ReturnType<typeof normalizeFinanceBookActor>, bookId: string | null | undefined, create = false, now?: string) {
  const id = parseFinanceBookId(bookId);
  const book = id === 'own' ? await ownBook(db, actor.userId) ?? (create ? await ensureOwnFamilyBook(db, actor, now) : null) : await readBook(db, id);
  if (id !== 'own' && (!book || book.ownerUserId !== actor.userId)) throw ownerRequired();
  return book;
}

export async function listFinanceBookMembers(db: FinanceBooksDatabase, value: FinanceBookActor, bookId = 'own'): Promise<{ book: FinanceBookPublic; members: FinanceBookMember[] }> {
  const actor = normalizeFinanceBookActor(value), book = await requireBookOwner(db, actor, bookId);
  const rows = book ? (await db.prepare(`SELECT ${memberColumns} FROM family_book_members WHERE book_id=? ORDER BY created_at,id`).bind(book.id).all<MemberRow>()).results : [];
  return { book: publicBook(book, actor), members: rows.map(present) };
}

async function replay(db: FinanceBooksDatabase, operationId: string, actorId: string, requestHash: string, bookId?: string) {
  const receipt = await db.prepare('SELECT actor_user_id AS actorUserId,book_id AS bookId,member_id AS memberId,request_hash AS requestHash FROM family_book_member_operations WHERE operation_id=?').bind(operationId).first<OperationRow>();
  if (!receipt) return null;
  if (receipt.actorUserId !== actorId || receipt.requestHash !== requestHash || bookId !== undefined && receipt.bookId !== bookId) throw new FinanceBookError('FINANCE_BOOK_OPERATION_CONFLICT', 409, '同一操作标识已用于不同账户、账本或内容，请核对原操作。');
  const current = await member(db, receipt.memberId); if (!current || current.bookId !== receipt.bookId) throw new Error('Family member operation has no member');
  return { member: present(current), replayed: true };
}
function receiptInsert(db: FinanceBooksDatabase, operationId: string, actorId: string, bookId: string, memberId: string, requestHash: string, now: string) {
  return db.prepare('INSERT INTO family_book_member_operations(operation_id,actor_user_id,book_id,member_id,request_hash,created_at) VALUES (?,?,?,?,?,?)').bind(operationId, actorId, bookId, memberId, requestHash, now);
}
function activityInsert(db: FinanceBooksDatabase, id: string, bookId: string, actor: ReturnType<typeof normalizeFinanceBookActor>, action: string, now: string) {
  return db.prepare('INSERT INTO family_book_activity(id,book_id,actor_user_id,actor_name,action,target_id,target_name,created_at) VALUES (?,?,?,?,?,NULL,?,?)')
    .bind(id, bookId, actor.userId, actor.displayName, action, '家庭成员', now);
}
function ownerGuard(db: FinanceBooksDatabase, book: FamilyBookRecord, actorId: string, current?: MemberRow) {
  return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM family_books WHERE id=? AND owner_user_id=?)
    ${current ? "AND EXISTS(SELECT 1 FROM family_book_members WHERE id=? AND book_id=? AND revision=?)" : ''}
    THEN 1 ELSE abs(-9223372036854775808) END AS family_member_guard`).bind(book.id, actorId, ...(current ? [current.id, book.id, current.revision] : []));
}

export async function inviteFinanceBookMember(db: FinanceBooksDatabase, value: FinanceBookActor, bookId: string, input: { email: string; role?: 'editor' | 'viewer' }, requestId: string, now = new Date().toISOString()) {
  const actor = normalizeFinanceBookActor(value), invitation = parseFinanceBookInvite(input), { email } = invitation, role = invitation.role ?? 'editor', operationId = parseFinanceBookId(requestId, false), timestamp = instant(now);
  if (email === actor.email) throw new FinanceBookError('FINANCE_BOOK_INVALID', 400, '账本创建者已拥有访问权限，无需邀请自己。');
  const book = (await requireBookOwner(db, actor, bookId, true, timestamp))!;
  const requestHash = await hash(role === 'editor' ? ['invite', book.id, email] : ['invite', book.id, email, role]);
  const prior = await replay(db, operationId, actor.userId, requestHash, book.id); if (prior) return prior;
  const current = await db.prepare(`SELECT ${memberColumns} FROM family_book_members WHERE book_id=? AND email=?`).bind(book.id, email).first<MemberRow>();
  if (current?.status === 'active') throw conflict('这个账户已是家庭账本成员，无需再次邀请。');
  const expiresAt = new Date(Date.parse(timestamp) + 30 * 86400000).toISOString(), id = current?.id ?? operationId;
  const commands = [ownerGuard(db, book, actor.userId, current ?? undefined)];
  commands.push(current
    ? db.prepare(`UPDATE family_book_members SET status='pending',role=?,revision=revision+1,expires_at=?,accepted_at=NULL,updated_at=? WHERE id=? AND revision=?`).bind(role, expiresAt, timestamp, id, current.revision)
    : db.prepare(`INSERT INTO family_book_members(id,book_id,email,user_id,status,role,revision,expires_at,accepted_at,created_at,updated_at)
      VALUES (?,?,?,NULL,'pending',?,1,?,NULL,?,?)`).bind(id, book.id, email, role, expiresAt, timestamp, timestamp));
  commands.push(receiptInsert(db, operationId, actor.userId, book.id, id, requestHash, timestamp));
  commands.push(activityInsert(db, operationId, book.id, actor, 'member.invite.' + role, timestamp));
  try { await db.batch(commands); }
  catch (error) { const done = await replay(db, operationId, actor.userId, requestHash, book.id); if (done) return done; if (expectedRace(error)) throw conflict(); throw error; }
  const saved = await member(db, id); if (!saved) throw new Error('Family invitation was not saved');
  return { member: present(saved), replayed: false };
}

export async function changeFinanceBookMember(db: FinanceBooksDatabase, value: FinanceBookActor, bookId: string, memberId: string, input: { action: 'revoke' | 'role'; expectedRevision: number; role?: 'editor' | 'viewer' }, requestId: string, now = new Date().toISOString()) {
  const actor = normalizeFinanceBookActor(value), operationId = parseFinanceBookId(requestId, false), id = parseFinanceBookId(memberId, false), change = parseFinanceBookMemberAction(input, ['revoke', 'role']), timestamp = instant(now);
  const book = await requireBookOwner(db, actor, bookId); if (!book) throw ownerRequired();
  const requestHash = await hash(change.action === 'revoke' ? ['revoke', book.id, id, change.expectedRevision] : ['role', book.id, id, change.expectedRevision, change.role]);
  const prior = await replay(db, operationId, actor.userId, requestHash, book.id); if (prior) return prior;
  const current = await member(db, id); if (!current || current.bookId !== book.id) throw ownerRequired();
  if (current.revision !== change.expectedRevision) throw conflict();
  if (change.action === 'role' && !['pending', 'active'].includes(current.status)) throw conflict('请先重新邀请此账户，再调整协作权限。');
  try { await db.batch([ownerGuard(db, book, actor.userId, current),
    change.action === 'revoke'
      ? db.prepare("UPDATE family_book_members SET status='revoked',revision=revision+1,updated_at=? WHERE id=? AND book_id=? AND revision=?").bind(timestamp, id, book.id, change.expectedRevision)
      : db.prepare("UPDATE family_book_members SET role=?,revision=revision+1,updated_at=? WHERE id=? AND book_id=? AND revision=?").bind(change.role, timestamp, id, book.id, change.expectedRevision),
    receiptInsert(db, operationId, actor.userId, book.id, id, requestHash, timestamp),
    activityInsert(db, operationId, book.id, actor, change.action === 'revoke' ? 'member.revoke' : 'member.role.' + change.role, timestamp)]); }
  catch (error) { const done = await replay(db, operationId, actor.userId, requestHash, book.id); if (done) return done; if (expectedRace(error)) throw conflict(); throw error; }
  const saved = await member(db, id); if (!saved) throw new Error('Family membership was not saved'); return { member: present(saved), replayed: false };
}

export async function respondFinanceBookInvitation(db: FinanceBooksDatabase, value: FinanceBookActor, invitationId: string, input: { action: 'accept' | 'decline'; expectedRevision: number }, requestId: string, now = new Date().toISOString()) {
  const actor = normalizeFinanceBookActor(value), operationId = parseFinanceBookId(requestId, false), id = parseFinanceBookId(invitationId, false), change = parseFinanceBookMemberAction(input, ['accept', 'decline']), timestamp = instant(now);
  const requestHash = await hash(['respond', id, change.action, change.expectedRevision]);
  const prior = await replay(db, operationId, actor.userId, requestHash); if (prior) return prior;
  const current = await member(db, id), book = current ? await readBook(db, current.bookId) : null;
  if (!current || !book || current.email !== actor.email || current.userId !== null && current.userId !== actor.userId || book.ownerUserId === actor.userId) throw financeBookAccessRevoked();
  if (current.revision !== change.expectedRevision || current.status !== 'pending') throw conflict();
  if (current.expiresAt <= timestamp) throw new FinanceBookError('FINANCE_BOOK_INVITATION_EXPIRED', 409, '邀请已过期，请联系账本创建者重新邀请。');
  try { await db.batch([
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM family_book_members m JOIN family_books b ON b.id=m.book_id
      WHERE m.id=? AND m.book_id=? AND m.email=? AND (m.user_id IS NULL OR m.user_id=?) AND m.revision=? AND m.status='pending' AND m.expires_at>? AND b.owner_user_id<>?)
      THEN 1 ELSE abs(-9223372036854775808) END AS family_member_guard`).bind(id, book.id, actor.email, actor.userId, change.expectedRevision, timestamp, actor.userId),
    db.prepare(`UPDATE family_book_members SET status=?,user_id=CASE WHEN ?='accept' THEN COALESCE(user_id,?) ELSE user_id END,
      accepted_at=CASE WHEN ?='accept' THEN ? ELSE NULL END,revision=revision+1,updated_at=? WHERE id=? AND book_id=? AND revision=?`)
      .bind(change.action === 'accept' ? 'active' : 'declined', change.action, actor.userId, change.action, timestamp, timestamp, id, book.id, change.expectedRevision),
    receiptInsert(db, operationId, actor.userId, book.id, id, requestHash, timestamp),
    activityInsert(db, operationId, book.id, actor, 'member.' + change.action, timestamp),
  ]); }
  catch (error) { const done = await replay(db, operationId, actor.userId, requestHash, book.id); if (done) return done; if (expectedRace(error)) throw conflict(); throw error; }
  const saved = await member(db, id); if (!saved) throw new Error('Family invitation response was not saved'); return { member: present(saved), replayed: false };
}
