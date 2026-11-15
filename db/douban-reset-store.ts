export type DoubanResetDatabase = Pick<D1Database, 'prepare' | 'batch'>;
export interface DoubanResetCounts { all: number; screen: number; movie: number; series: number; book: number; music: number }
export interface DoubanResetPreview { epoch: number; total: number; counts: DoubanResetCounts; latestUpdatedAt: string | null; previewHash: string }
export interface DoubanResetReceipt { requestId: string; epoch: number; deleted: number; counts: DoubanResetCounts; clearedAt: string }
export interface DoubanResetCommand { expectedEpoch: number; expectedPreviewHash: string; requestId: string; confirmed: true; now?: string }
export class DoubanResetStoreError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = 'DOUBAN_RESET_CONFLICT', status = 409) { super(message); this.name = 'DoubanResetStoreError'; this.code = code; this.status = status; }
}
interface ResetControl { epoch: number; requestId: string; requestHash: string; receiptJson: string }
interface ResetSnapshot {
  total: number; screen: number; movie: number; series: number; book: number; music: number;
  latestUpdatedAt: string | null; latestObservedAt: string | null; localRevisionSnapshot: string;
}
const kinds = ['screen', 'movie', 'series', 'book', 'music'] as const;
// Local edits have their own monotonic revisions, independent of sync times.
// Sum six 10-bit parts instead of whole MAX_SAFE_INTEGER revisions: each row
// contributes at most 1023 to a part, avoiding SQLite integer overflow. Keep
// these totals as decimal text so neither D1 nor JSON rounds them in JavaScript.
// If any local revision advances, at least one part total must change, including
// across carries; this remains a fixed-size snapshot for large collections.
const localRevisionSnapshotSql = `json_array(${Array.from({ length: 6 }, (_, index) =>
  `CAST(COALESCE(SUM((local_revision >> ${index * 10}) & 1023),0) AS TEXT)`).join(',')})`;
const snapshotSql = `SELECT COUNT(*) AS total,${kinds.map(kind => `COALESCE(SUM(CASE WHEN kind='${kind}' THEN 1 ELSE 0 END),0) AS ${kind}`).join(',')},
  MAX(updated_at) AS latestUpdatedAt,MAX(observed_at) AS latestObservedAt,${localRevisionSnapshotSql} AS localRevisionSnapshot FROM douban_items WHERE user_id=?`;
const snapshotGuard = `EXISTS(SELECT 1 FROM (${snapshotSql}) s WHERE s.total=? AND ${kinds.map(kind => `s.${kind}=?`).join(' AND ')}
  AND s.latestUpdatedAt IS ? AND s.latestObservedAt IS ? AND s.localRevisionSnapshot=?)`;
function invalid(): never { throw new DoubanResetStoreError('请先预览并确认清空本人书影音记录。', 'INVALID_DOUBAN_RESET', 400); }
function epochConflict(): never { throw new DoubanResetStoreError('书影音资料已清空或重新开始，请刷新后重新核对。', 'DOUBAN_DATA_EPOCH_CONFLICT'); }
function snapshotConflict(): never { throw new DoubanResetStoreError('书影音记录已发生变化，未清空任何资料。请重新预览后核对。'); }
function actor(userId: string) { if (typeof userId !== 'string' || !userId || userId.length > 512) invalid(); }
function epoch(value: number) { if (!Number.isSafeInteger(value) || value < 0) invalid(); }
function timestamp(value: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
async function digest(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function control(db: DoubanResetDatabase, userId: string): Promise<ResetControl | null> {
  return db.prepare(`SELECT data_epoch AS epoch,last_request_id AS requestId,last_request_hash AS requestHash,last_receipt_json AS receiptJson
    FROM douban_data_resets WHERE user_id=?`).bind(userId).first<ResetControl>();
}
/** Zero is the pre-reset generation; the control record is deliberately local, not portable. */
export async function readDoubanDataEpoch(db: DoubanResetDatabase, userId: string): Promise<number> {
  actor(userId); const current = await control(db, userId); const value = current?.epoch ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new DoubanResetStoreError('书影音资料版本暂时无法读取，请稍后重试。', 'DOUBAN_RESET_UNAVAILABLE', 503);
  return value;
}
function counts(snapshot: ResetSnapshot): DoubanResetCounts { return { all: snapshot.total, ...Object.fromEntries(kinds.map(kind => [kind, snapshot[kind]])) } as DoubanResetCounts; }
function guardValues(userId: string, snapshot: ResetSnapshot) { return [userId, snapshot.total, ...kinds.map(kind => snapshot[kind]), snapshot.latestUpdatedAt, snapshot.latestObservedAt, snapshot.localRevisionSnapshot]; }
async function plan(db: DoubanResetDatabase, userId: string) {
  const dataEpoch = await readDoubanDataEpoch(db, userId);
  const snapshot = await db.prepare(snapshotSql).bind(userId).first<ResetSnapshot>();
  if (!snapshot) throw new DoubanResetStoreError('清空预览暂时无法读取，请稍后重试。', 'DOUBAN_RESET_UNAVAILABLE', 503);
  const preview: DoubanResetPreview = { epoch: dataEpoch, total: snapshot.total, counts: counts(snapshot), latestUpdatedAt: snapshot.latestUpdatedAt,
    previewHash: await digest([1, userId, dataEpoch, snapshot]) };
  return { preview, snapshot };
}
export async function previewDoubanReset(db: DoubanResetDatabase, userId: string): Promise<DoubanResetPreview> {
  actor(userId); return (await plan(db, userId)).preview;
}
function replay(current: ResetControl | null, requestId: string, requestHash: string): DoubanResetReceipt | null {
  if (current?.requestId !== requestId) return null;
  if (current.requestHash !== requestHash) snapshotConflict();
  try { return JSON.parse(current.receiptJson) as DoubanResetReceipt; }
  catch { throw new DoubanResetStoreError('清空回执暂时无法读取，请保留提交标识后重试。', 'DOUBAN_RESET_UNAVAILABLE', 503); }
}
/** One actor, one atomic transaction: erase collections and diagnostics, retaining the binding. */
export async function commitDoubanReset(db: DoubanResetDatabase, userId: string, command: DoubanResetCommand): Promise<DoubanResetReceipt> {
  actor(userId); epoch(command.expectedEpoch);
  if (command.confirmed !== true || typeof command.expectedPreviewHash !== 'string' || !/^[a-f0-9]{64}$/.test(command.expectedPreviewHash)
    || typeof command.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(command.requestId)
    || command.expectedEpoch >= Number.MAX_SAFE_INTEGER) invalid();
  const now = timestamp(command.now ?? new Date().toISOString()), requestId = command.requestId.toLowerCase();
  const requestHash = await digest([1, userId, command.expectedEpoch, command.expectedPreviewHash]);
  const prior = await control(db, userId), original = replay(prior, requestId, requestHash);
  if (original) return original;
  if ((prior?.epoch ?? 0) !== command.expectedEpoch) epochConflict();
  const current = await plan(db, userId);
  if (current.preview.epoch !== command.expectedEpoch) epochConflict();
  if (current.preview.previewHash !== command.expectedPreviewHash) snapshotConflict();
  const nextEpoch = command.expectedEpoch + 1;
  const receipt: DoubanResetReceipt = { requestId, epoch: nextEpoch, deleted: current.preview.total, counts: current.preview.counts, clearedAt: now };
  const receiptJson = JSON.stringify(receipt);
  const successfulReset = `EXISTS(SELECT 1 FROM douban_data_resets WHERE user_id=? AND data_epoch=? AND last_request_id=? AND last_request_hash=?)`;
  const successValues = [userId, nextEpoch, requestId, requestHash];
  const statements = [
    db.prepare(`INSERT INTO douban_data_resets (user_id,data_epoch,last_request_id,last_request_hash,last_receipt_json,created_at,updated_at)
      SELECT ?,?,?,?,?,?,? WHERE COALESCE((SELECT data_epoch FROM douban_data_resets WHERE user_id=?),0)=? AND ${snapshotGuard}
      ON CONFLICT(user_id) DO UPDATE SET data_epoch=excluded.data_epoch,last_request_id=excluded.last_request_id,last_request_hash=excluded.last_request_hash,
        last_receipt_json=excluded.last_receipt_json,updated_at=MAX(douban_data_resets.updated_at,excluded.updated_at)
      WHERE douban_data_resets.data_epoch=? AND douban_data_resets.last_request_id<>? RETURNING last_receipt_json AS receiptJson`)
      .bind(userId, nextEpoch, requestId, requestHash, receiptJson, now, now, userId, command.expectedEpoch, ...guardValues(userId, current.snapshot), command.expectedEpoch, requestId),
    // Without this probe, a concurrent retry that loses the first CAS could see
    // the winner's epoch/id and erase freshly resynced records a second time.
    // Violating NOT NULL rolls the entire D1 batch back before any deletion.
    db.prepare(`UPDATE douban_data_resets SET last_receipt_json=CASE WHEN changes()=1 AND data_epoch=? AND last_request_id=? AND last_request_hash=?
      THEN last_receipt_json ELSE NULL END WHERE user_id=?`).bind(nextEpoch, requestId, requestHash, userId),
    db.prepare(`DELETE FROM douban_items WHERE user_id=? AND ${successfulReset}`).bind(userId, ...successValues),
    db.prepare(`DELETE FROM douban_sync_runs WHERE user_id=? AND ${successfulReset}`).bind(userId, ...successValues),
    db.prepare(`DELETE FROM douban_import_receipts WHERE user_id=? AND ${successfulReset}`).bind(userId, ...successValues),
    db.prepare(`UPDATE douban_connections SET revision=revision+1,updated_at=MAX(updated_at,?) WHERE user_id=? AND ${successfulReset}`).bind(now, userId, ...successValues),
    db.prepare(`SELECT last_receipt_json AS receiptJson FROM douban_data_resets WHERE user_id=? AND data_epoch=? AND last_request_id=? AND last_request_hash=?`).bind(...successValues),
  ];
  async function afterFailure(): Promise<DoubanResetReceipt> {
    const latest = await control(db, userId), alreadyDone = replay(latest, requestId, requestHash);
    if (alreadyDone) return alreadyDone;
    if ((latest?.epoch ?? 0) !== command.expectedEpoch) epochConflict();
    const latestPlan = await plan(db, userId);
    if (latestPlan.preview.epoch !== command.expectedEpoch) epochConflict();
    if (latestPlan.preview.previewHash !== command.expectedPreviewHash) snapshotConflict();
    throw new DoubanResetStoreError('清空结果尚未确认，请保留原提交标识后重试。', 'DOUBAN_RESET_UNAVAILABLE', 503);
  }
  let results: D1Result[];
  try { results = await db.batch(statements); } catch { return afterFailure(); }
  if (!results[0]?.results.length || !results.at(-1)?.results.length) return afterFailure();
  return receipt;
}
