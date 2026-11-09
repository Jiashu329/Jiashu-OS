import { measurementDay, measurementKey } from '../lib/health.ts';
import type { HealthMeasurement } from '../lib/health.ts';
import type { HealthRecordCommand, HealthRecordView, HealthRecordSelection, HealthRecordChangeView } from '../lib/health-records.ts';

export type HealthRecordsDatabase = Pick<D1Database, 'prepare' | 'batch'>;
interface RecordRow {
  recordKey: string; metric: HealthRecordView['metric']; day: string;
  baseJson: string | null; baseExportedAt: string | null; baseReceivedAt: string | null;
  effectiveJson: string; overrideJson: string | null; deleted: number; revision: number; updatedAt: string | null;
}
interface ReceiptRow {
  changeId: string; recordKey: string; requestHash: string; action: HealthRecordCommand['action'];
  beforeStateJson: string | null; afterStateJson: string; reason: string; createdAt: string;
}
export class HealthRecordConflictError extends Error {
  readonly code = 'HEALTH_RECORD_CONFLICT';
  constructor(message = '记录已更新，请刷新后检查再提交。') { super(message); this.name = 'HealthRecordConflictError'; }
}
export class HealthRecordNotFoundError extends Error {
  readonly code = 'HEALTH_RECORD_NOT_FOUND';
  constructor() { super('找不到这条健康记录。'); this.name = 'HealthRecordNotFoundError'; }
}

// Range filters apply after merging. A correction keeps its saved measurement
// even if a later sync moves the underlying sample to another day.
const merged = `WITH records AS (
  SELECT b.record_key AS recordKey,
    CASE WHEN o.override_json IS NOT NULL THEN o.metric ELSE b.metric END AS metric,
    CASE WHEN o.override_json IS NOT NULL THEN o.day ELSE b.day END AS day,
    b.measurement_json AS baseJson, b.exported_at AS baseExportedAt, b.received_at AS baseReceivedAt,
    COALESCE(o.override_json, b.measurement_json) AS effectiveJson,
    o.override_json AS overrideJson, COALESCE(o.deleted, 0) AS deleted,
    COALESCE(o.revision, 0) AS revision, o.updated_at AS updatedAt
  FROM health_measurements b LEFT JOIN health_record_overrides o
    ON o.user_id = b.user_id AND o.record_key = b.record_key
  WHERE b.user_id = ?
  UNION ALL
  SELECT o.record_key AS recordKey, o.metric, o.day, NULL AS baseJson,
    NULL AS baseExportedAt, NULL AS baseReceivedAt, o.override_json AS effectiveJson,
    o.override_json AS overrideJson, o.deleted, o.revision, o.updated_at AS updatedAt
  FROM health_record_overrides o WHERE o.user_id = ? AND o.override_json IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM health_measurements b WHERE b.user_id = o.user_id AND b.record_key = o.record_key)
)`;
function view(row: RecordRow): HealthRecordView {
  return {
    recordKey: row.recordKey, metric: row.metric, day: row.day,
    base: row.baseJson === null ? null : { measurement: JSON.parse(row.baseJson) as HealthMeasurement, exportedAt: row.baseExportedAt!, receivedAt: row.baseReceivedAt! },
    effective: JSON.parse(row.effectiveJson) as HealthMeasurement,
    override: row.overrideJson === null ? null : JSON.parse(row.overrideJson) as HealthMeasurement,
    deleted: row.deleted === 1, revision: row.revision, updatedAt: row.updatedAt, manual: row.baseJson === null,
  };
}
export async function readHealthRecord(db: HealthRecordsDatabase, userId: string, recordKey: string): Promise<HealthRecordView | null> {
  const row = await db.prepare(merged + ' SELECT * FROM records WHERE recordKey = ?')
    .bind(userId, userId, recordKey).first<RecordRow>();
  return row ? view(row) : null;
}
export async function listHealthRecords(db: HealthRecordsDatabase, userId: string, selection: HealthRecordSelection) {
  const limit = Math.min(100, Math.max(1, selection.limit ?? 100));
  const filters = ['day >= ?', 'day <= ?'];
  const values: unknown[] = [userId, userId, selection.from, selection.to];
  if (selection.metric) { filters.push('metric = ?'); values.push(selection.metric); }
  if (!selection.includeDeleted) filters.push('deleted = 0');
  if (selection.cursor) {
    filters.push('(day < ? OR (day = ? AND recordKey > ?))');
    values.push(selection.cursor[0], selection.cursor[0], selection.cursor[1]);
  }
  const rows = await db.prepare(merged + ' SELECT * FROM records WHERE ' + filters.join(' AND ')
    + ' ORDER BY day DESC, recordKey ASC LIMIT ?').bind(...values, limit + 1).all<RecordRow>();
  const hasMore = rows.results.length > limit;
  const records = rows.results.slice(0, limit).map(view);
  const last = records.at(-1);
  return { records, hasMore, nextCursor: hasMore && last ? JSON.stringify([last.day, last.recordKey]) : null };
}
export async function readEffectiveHealthMeasurements(db: HealthRecordsDatabase, userId: string, from: string, to?: string): Promise<HealthMeasurement[]> {
  const suffix = to === undefined ? '' : ' AND day <= ?';
  const values = to === undefined ? [userId, userId, from] : [userId, userId, from, to];
  const rows = await db.prepare(merged + ' SELECT effectiveJson FROM records WHERE deleted = 0 AND day >= ?'
    + suffix + ' ORDER BY day ASC, recordKey ASC').bind(...values).all<{ effectiveJson: string }>();
  return rows.results.map((row) => JSON.parse(row.effectiveJson) as HealthMeasurement);
}
const receiptColumns = `change_id AS changeId, record_key AS recordKey, request_hash AS requestHash, action,
  before_state_json AS beforeStateJson, after_state_json AS afterStateJson, reason, created_at AS createdAt`;
function change(row: ReceiptRow): HealthRecordChangeView {
  return { changeId: row.changeId, recordKey: row.recordKey, action: row.action,
    before: row.beforeStateJson === null ? null : JSON.parse(row.beforeStateJson) as HealthRecordView,
    after: JSON.parse(row.afterStateJson) as HealthRecordView, reason: row.reason, createdAt: row.createdAt };
}
export async function readHealthRecordHistory(db: HealthRecordsDatabase, userId: string, recordKey: string): Promise<HealthRecordChangeView[]> {
  if (!await readHealthRecord(db, userId, recordKey)) throw new HealthRecordNotFoundError();
  const rows = await db.prepare('SELECT ' + receiptColumns + ' FROM health_record_changes WHERE user_id = ? AND record_key = ? ORDER BY target_revision DESC')
    .bind(userId, recordKey).all<ReceiptRow>();
  return rows.results.map(change);
}
async function receipt(db: HealthRecordsDatabase, userId: string, requestId: string) {
  return db.prepare('SELECT ' + receiptColumns + ' FROM health_record_changes WHERE user_id = ? AND change_id = ?')
    .bind(userId, requestId).first<ReceiptRow>();
}
async function hashCommand(command: HealthRecordCommand) {
  const canonical = JSON.stringify(command, (_key: string, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
    }
    return value;
  });
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}
async function replay(db: HealthRecordsDatabase, userId: string, row: ReceiptRow, requestHash: string) {
  if (row.requestHash !== requestHash) throw new HealthRecordConflictError('同一请求标识不能用于不同修改，请重新提交。');
  const record = await readHealthRecord(db, userId, row.recordKey);
  if (!record) throw new Error('Health record receipt has no record');
  return { record, replayed: true, changeId: row.changeId };
}

/** Original sync rows remain untouched. Receipt and overlay are committed atomically. */
export async function writeHealthRecord(db: HealthRecordsDatabase, userId: string, command: HealthRecordCommand, requestId: string, now = new Date().toISOString()) {
  const requestHash = await hashCommand(command);
  const prior = await receipt(db, userId, requestId);
  if (prior) return replay(db, userId, prior, requestHash);
  const recordKey = command.action === 'create' ? measurementKey(command.measurement) : command.recordKey;
  const before = await readHealthRecord(db, userId, recordKey);
  if (command.action === 'create' && before) throw new HealthRecordConflictError('该指标和日期已有记录，请更正或恢复已有记录。');
  if (command.action !== 'create' && !before) throw new HealthRecordNotFoundError();
  const expectedRevision = command.action === 'create' ? 0 : command.expectedRevision;
  const expectedBase = command.action === 'create' ? null : command.expectedBaseExportedAt;
  if (before && (before.revision !== expectedRevision || (before.base?.exportedAt ?? null) !== expectedBase)) throw new HealthRecordConflictError();
  if (command.action === 'reset' && !before?.base) throw new HealthRecordConflictError('手工补录没有同步原值，可更正数值或屏蔽记录。');
  const override = command.action === 'create' ? command.measurement
    : command.action === 'correct' ? { ...before!.effective, value: command.value }
    : command.action === 'reset' ? null : before!.override;
  const effective = override ?? before!.base!.measurement;
  const deleted = command.action === 'hide' ? true : command.action === 'restore' || command.action === 'reset' ? false : before?.deleted ?? false;
  const after: HealthRecordView = { recordKey, metric: effective.metric, day: measurementDay(effective),
    base: before?.base ?? null, effective, override, deleted, revision: expectedRevision + 1, updatedAt: now, manual: before?.base === null || command.action === 'create' };
  // The raw export version is monotonic in importHealth. Checking it as well as
  // the overlay revision prevents edits based on a stale sync snapshot.
  const condition = `COALESCE((SELECT revision FROM health_record_overrides WHERE user_id = ? AND record_key = ?), 0) = ?
    AND ((? IS NULL AND NOT EXISTS (SELECT 1 FROM health_measurements WHERE user_id = ? AND record_key = ?))
      OR EXISTS (SELECT 1 FROM health_measurements WHERE user_id = ? AND record_key = ? AND exported_at = ?))`;
  const createGuard = command.action === 'create'
    ? ' AND NOT EXISTS (SELECT 1 FROM health_record_overrides WHERE user_id = ? AND record_key = ?)' : '';
  const args: unknown[] = [userId, requestId, recordKey, requestHash, command.action, expectedRevision + 1,
    before ? JSON.stringify(before) : null, JSON.stringify(after), command.reason, now,
    userId, recordKey, expectedRevision, expectedBase, userId, recordKey, userId, recordKey, expectedBase];
  if (command.action === 'create') args.push(userId, recordKey);
  const result = await db.batch([
    db.prepare(`INSERT INTO health_record_changes (user_id, change_id, record_key, request_hash, action, target_revision,
      before_state_json, after_state_json, reason, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${condition}${createGuard}
      ON CONFLICT(user_id, change_id) DO NOTHING`).bind(...args),
    db.prepare(`INSERT INTO health_record_overrides (user_id, record_key, metric, day, override_json, deleted,
      revision, last_change_id, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM health_record_changes WHERE user_id = ? AND change_id = ? AND request_hash = ? AND target_revision = ?
      ) AND ${condition}${createGuard}
      ON CONFLICT(user_id, record_key) DO UPDATE SET metric = excluded.metric, day = excluded.day,
        override_json = excluded.override_json, deleted = excluded.deleted, revision = excluded.revision,
        last_change_id = excluded.last_change_id, updated_at = excluded.updated_at
      WHERE health_record_overrides.revision = ?`).bind(userId, recordKey, after.metric, after.day,
      override === null ? null : JSON.stringify(override), deleted ? 1 : 0, after.revision, requestId, now, now,
      userId, requestId, requestHash, after.revision,
      userId, recordKey, expectedRevision, expectedBase, userId, recordKey, userId, recordKey, expectedBase,
      ...(command.action === 'create' ? [userId, recordKey] : []), expectedRevision),
  ]);
  const saved = await receipt(db, userId, requestId);
  if (!saved) throw new HealthRecordConflictError();
  // A concurrent request can win with the same id after the first receipt read.
  if (saved.requestHash !== requestHash) throw new HealthRecordConflictError('同一请求标识不能用于不同修改，请重新提交。');
  const record = await readHealthRecord(db, userId, recordKey);
  if (!record || record.revision < after.revision) throw new Error('Health record change was not committed');
  return { record, replayed: result[0].meta.changes !== 1, changeId: requestId };
}
