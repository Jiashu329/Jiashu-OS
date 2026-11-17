import { measurementDay, measurementKey, METRIC_INFO, type HealthMeasurement, type HealthMetric, type HealthSyncPayload } from '../lib/health.ts';
import { countSyncOutcome, syncPayloadSummary, type SyncAttemptSummary } from '../lib/sync-diagnostics.ts';
import { syncDiagnosticStatements } from './sync-diagnostics-store.ts';
import { readNativeHealthChannelPolicy, type NativeHealthChannelPolicy } from './native-health-channel-store.ts';

export type HealthImportDatabase = Pick<D1Database, 'prepare' | 'batch'>;
export interface ImportBase { recordKey: string; metric: HealthMetric; day: string; measurementJson: string; exportedAt: string; receivedAt: string }
interface Snapshot { recordKey: string; base: ImportBase | null; revision: number; overrideJson: string | null; deleted: number }
interface BatchRow { batchId: string; payloadHash: string; operationId: string; beforeJson: string; afterJson: string; receiptJson: string; createdAt: string; revertedAt: string | null; revertReason: string | null }
export interface HealthImportPreview {
  token: string; payloadHash: string; total: number; added: number; updated: number; skipped: number;
  sourceChanges: number; manualOverrides: number; from: string | null; to: string | null;
  sourceChangesAuthorized: boolean;
  metrics: string[]; examples: Array<{ recordKey: string; day: string; metric: string; action: string; before: number | null; after: number; oldSource: string | null; newSource: string | null; reason: string; manualOverride: boolean }>;
}
export class HealthImportConflictError extends Error {
  readonly code: string;
  constructor(code = 'HEALTH_IMPORT_STALE', message = '记录已变化，请重新预览后再导入。') { super(message); this.name = 'HealthImportConflictError'; this.code = code; }
}
export interface HealthImportOptions { previewToken?: string | null; confirmSourceChanges?: boolean }
const columns = `batch_id AS batchId, payload_hash AS payloadHash, operation_id AS operationId,
  before_json AS beforeJson, after_json AS afterJson, receipt_json AS receiptJson,
  created_at AS createdAt, reverted_at AS revertedAt, revert_reason AS revertReason`;
async function digest(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map((part) => part.toString(16).padStart(2, '0')).join('');
}
async function snapshots(db: HealthImportDatabase, userId: string, keys: string[]): Promise<Snapshot[]> {
  const rows = await db.prepare(`SELECT j.value AS recordKey,
    b.metric, b.day, b.measurement_json AS measurementJson, b.exported_at AS exportedAt, b.received_at AS receivedAt,
    COALESCE(o.revision, 0) AS revision, o.override_json AS overrideJson, COALESCE(o.deleted, 0) AS deleted
    FROM json_each(?) j LEFT JOIN health_measurements b ON b.user_id = ? AND b.record_key = j.value
    LEFT JOIN health_record_overrides o ON o.user_id = ? AND o.record_key = j.value ORDER BY j.value`)
    .bind(JSON.stringify(keys), userId, userId).all<ImportBase & { revision: number; overrideJson: string | null; deleted: number }>();
  return rows.results.map((row) => ({ recordKey: row.recordKey,
    base: row.measurementJson === null ? null : { recordKey: row.recordKey, metric: row.metric, day: row.day, measurementJson: row.measurementJson, exportedAt: row.exportedAt, receivedAt: row.receivedAt },
    revision: row.revision, overrideJson: row.overrideJson, deleted: row.deleted }));
}
function channelRequired(): never {
  throw new HealthImportConflictError('HEALTH_SYNC_CHANNEL_REQUIRED', '此账号已选择 Apple 健康同步通道，请使用选定设备同步；其他导入通道已暂停。');
}
function channelChanged(): never {
  throw new HealthImportConflictError('HEALTH_SYNC_CHANNEL_CHANGED', '同步通道已变化，本次数据未写入，请读取最新通道设置后重试。');
}
function authorizeChannel(channel: NativeHealthChannelPolicy, deviceId: string | null) {
  if (channel.deviceId !== null && (channel.deviceId !== deviceId || !channel.live)) channelRequired();
}
async function unchangedChannel(db: HealthImportDatabase, userId: string, expected: NativeHealthChannelPolicy, deviceId: string | null) {
  const current = await readNativeHealthChannelPolicy(db, userId);
  if (current.revision !== expected.revision || current.deviceId !== expected.deviceId || current.live !== expected.live) channelChanged();
  authorizeChannel(current, deviceId);
}
async function plan(db: HealthImportDatabase, userId: string, payload: HealthSyncPayload, deviceId: string | null) {
  const channel = await readNativeHealthChannelPolicy(db, userId);
  authorizeChannel(channel, deviceId);
  const sourceChangesAuthorized = channel.deviceId !== null && channel.deviceId === deviceId && channel.live;
  let hash = await digest(payload);
  // The mobile adapter now retains source sleep timing. Retrying a report that
  // was already acknowledged before that additive metadata existed must keep
  // its original receipt, including a prior explicit batch rollback.
  if(payload.measurements.some((measurement)=>measurement.sleepTiming)){
    const legacyHash=await digest({...payload,measurements:payload.measurements.map((measurement)=>{const {sleepTiming: _timing,...legacy}=measurement;return legacy;})});
    if(await batchRow(db,userId,legacyHash))hash=legacyHash;
  }
  const state = await snapshots(db, userId, payload.measurements.map(measurementKey));
  const byKey = new Map(state.map((row) => [row.recordKey, row]));
  const days = payload.measurements.map(measurementDay).sort();
  const previewTokenInput = channel.revision === 0 ? [userId, hash, state] : [userId, hash, state, channel.revision, channel.deviceId];
  const preview: HealthImportPreview = { token: await digest(previewTokenInput), payloadHash: hash,
    total: payload.measurements.length, added: 0, updated: 0, skipped: 0, sourceChanges: 0, manualOverrides: 0,
    sourceChangesAuthorized,
    from: days[0] ?? null, to: days.at(-1) ?? null, metrics: [...new Set(payload.measurements.map((row) => METRIC_INFO[row.metric].label))], examples: [] };
  const writes: Array<Omit<ImportBase, 'receivedAt'>> = [];
  const changes: Array<{ before: ImportBase | null; after: Omit<ImportBase, 'receivedAt'> }> = [];
  const attemptSummary = syncPayloadSummary(payload);
  for (const measurement of payload.measurements) {
    const key = measurementKey(measurement), old = byKey.get(key)!;
    const prior = old.base ? JSON.parse(old.base.measurementJson) as HealthMeasurement : null;
    const newer = !old.base || payload.exportedAt > old.base.exportedAt;
    const same = old.base?.measurementJson === JSON.stringify(measurement);
    const action = !old.base ? '新增' : !newer ? '跳过旧批次' : same ? '未变化' : '更新';
    if (!old.base) preview.added++;
    else if (!newer || same) preview.skipped++;
    else preview.updated++;
    const sourceChange = newer && !!prior && (prior.source ?? null) !== (measurement.source ?? null);
    if (sourceChange) preview.sourceChanges++;
    const manual = old.overrideJson !== null || old.deleted === 1;
    countSyncOutcome(attemptSummary, measurement, !old.base ? 'added' : !newer ? (payload.exportedAt === old.base.exportedAt && same ? 'unchanged' : 'older') : same ? 'unchanged' : 'updated', manual);
    if (manual && newer) preview.manualOverrides++;
    if (newer) {
      const after = { recordKey: key, metric: measurement.metric, day: measurementDay(measurement), measurementJson: JSON.stringify(measurement), exportedAt: payload.exportedAt };
      // Every accepted export advances the raw version so an older source cannot
      // overwrite it. Only content changes need full snapshots for rollback.
      writes.push(after);
      if (!same) changes.push({ before: old.base, after });
    }
    // Prefer source changes, then regular examples; keep the response bounded.
    const example = { recordKey: key, day: measurementDay(measurement), metric: METRIC_INFO[measurement.metric].label, action,
      before: prior?.value ?? null, after: measurement.value, oldSource: prior?.source ?? null, newSource: measurement.source ?? null,
      reason: sourceChange ? sourceChangesAuthorized ? '已授权的 Apple 健康通道内来源更新' : '来源变化，需确认' : !newer ? '导出时间不晚于已保存批次' : same ? '数值与内容未变化，仅更新接收版本' : manual ? '保留已有手工更正／屏蔽状态' : '', manualOverride: manual };
    if (sourceChange) preview.examples.unshift(example); else preview.examples.push(example);
  }
  preview.examples = preview.examples.slice(0, 12);
  return { preview, state, writes, changes, hash, attemptSummary, channel };
}
function replaySummary(summary: SyncAttemptSummary, reverted: boolean): SyncAttemptSummary {
  return { ...summary, metrics: summary.metrics.map((metric) => ({ ...metric, added: 0, updated: 0, older: 0, unchanged: reverted ? 0 : metric.received })) };
}
export async function previewHealthImport(db: HealthImportDatabase, userId: string, payload: HealthSyncPayload, deviceId: string | null = null) {
  const prepared = await plan(db, userId, payload, deviceId);
  await unchangedChannel(db, userId, prepared.channel, deviceId);
  return prepared.preview;
}
// All compared values come from the server snapshot, never from client facts.
const snapshotGuard = `NOT EXISTS (SELECT 1 FROM json_each(?) s
  LEFT JOIN health_measurements b ON b.user_id = ? AND b.record_key = json_extract(s.value, '$.recordKey')
  LEFT JOIN health_record_overrides o ON o.user_id = ? AND o.record_key = json_extract(s.value, '$.recordKey')
  WHERE b.measurement_json IS NOT json_extract(s.value, '$.base.measurementJson')
    OR b.exported_at IS NOT json_extract(s.value, '$.base.exportedAt')
    OR b.received_at IS NOT json_extract(s.value, '$.base.receivedAt')
    OR COALESCE(o.revision, 0) != json_extract(s.value, '$.revision')
    OR o.override_json IS NOT json_extract(s.value, '$.overrideJson')
    OR COALESCE(o.deleted, 0) != json_extract(s.value, '$.deleted'))`;
async function batchRow(db: HealthImportDatabase, userId: string, id: string) {
  return db.prepare('SELECT ' + columns + ' FROM health_import_batches WHERE user_id = ? AND batch_id = ?').bind(userId, id).first<BatchRow>();
}
const channelGuard = `COALESCE((SELECT revision FROM native_health_channels WHERE user_id=?),0)=?
  AND (SELECT device_id FROM native_health_channels WHERE user_id=?) IS ?`;
export async function writeHealthImport(db: HealthImportDatabase, userId: string, payload: HealthSyncPayload, deviceId: string | null, options: HealthImportOptions = {}, now = new Date().toISOString()) {
  const prepared = await plan(db, userId, payload, deviceId);
  const prior = await batchRow(db, userId, prepared.hash);
  if (prior) {
    await unchangedChannel(db, userId, prepared.channel, deviceId);
    return { ...JSON.parse(prior.receiptJson), replayed: true, reverted: prior.revertedAt !== null,
      attemptSummary: replaySummary(prepared.attemptSummary, prior.revertedAt !== null) };
  }
  if (!deviceId && options.previewToken !== prepared.preview.token) throw new HealthImportConflictError(options.previewToken ? 'HEALTH_IMPORT_STALE' : 'HEALTH_IMPORT_PREVIEW_REQUIRED', '请先查看本次变更预览，再确认导入。');
  if (options.previewToken && options.previewToken !== prepared.preview.token) throw new HealthImportConflictError();
  if (prepared.preview.sourceChanges && !prepared.preview.sourceChangesAuthorized && (!options.previewToken || options.confirmSourceChanges !== true)) {
    throw new HealthImportConflictError('HEALTH_IMPORT_SOURCE_CONFIRMATION', '本次导入将切换已有记录的来源，请查看预览并明确确认。');
  }
  const operation = crypto.randomUUID();
  const writes = prepared.writes.map((row) => ({ ...row, receivedAt: now }));
  const after = prepared.changes.map((row) => ({ ...row.after, receivedAt: now }));
  const before = prepared.changes.map((row) => ({ recordKey: row.after.recordKey, base: row.before }));
  const receipt = { ok: true, batchId: prepared.hash, imported: prepared.preview.added + prepared.preview.updated,
    skipped: prepared.preview.skipped, lastSync: now, summary: { from: prepared.preview.from, to: prepared.preview.to, metrics: prepared.preview.metrics,
      sourceChanges: prepared.preview.sourceChanges, manualOverrides: prepared.preview.manualOverrides }, canRevert: after.length > 0 };
  const deviceGuard = `(? IS NULL OR EXISTS (SELECT 1 FROM sync_devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL))`;
  const receiptGuard = `EXISTS (SELECT 1 FROM health_import_batches WHERE user_id = ? AND batch_id = ? AND operation_id = ? AND reverted_at IS NULL)`;
  const commands = [db.prepare(`INSERT INTO health_import_batches
    (user_id,batch_id,payload_hash,operation_id,before_json,after_json,receipt_json,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${snapshotGuard} AND ${deviceGuard} AND ${channelGuard}
    ON CONFLICT(user_id,batch_id) DO NOTHING`)
    .bind(userId, prepared.hash, prepared.hash, operation, JSON.stringify(before), JSON.stringify(after), JSON.stringify(receipt), now,
      JSON.stringify(prepared.state), userId, userId, deviceId, deviceId, userId,
      userId, prepared.channel.revision, userId, prepared.channel.deviceId),
  db.prepare(`INSERT INTO health_measurements (user_id,record_key,metric,day,measurement_json,exported_at,received_at)
    SELECT ?,json_extract(value,'$.recordKey'),json_extract(value,'$.metric'),json_extract(value,'$.day'),
      json_extract(value,'$.measurementJson'),json_extract(value,'$.exportedAt'),json_extract(value,'$.receivedAt')
    FROM json_each(?) WHERE ${receiptGuard}
    ON CONFLICT(user_id,record_key) DO UPDATE SET metric=excluded.metric,day=excluded.day,measurement_json=excluded.measurement_json,
      exported_at=excluded.exported_at,received_at=excluded.received_at`)
    .bind(userId, JSON.stringify(writes), userId, prepared.hash, operation),
  ...syncDiagnosticStatements(db, userId, payload, now, { batchId: prepared.hash, operationId: operation,
    importedCount: receipt.imported, skippedCount: receipt.skipped }),
  db.prepare(`INSERT INTO health_syncs (user_id,payload_hash,exported_at,received_at,measurement_count)
    SELECT ?,?,?,?,? WHERE ${receiptGuard} ON CONFLICT(user_id,payload_hash) DO UPDATE SET received_at=excluded.received_at`)
    .bind(userId, prepared.hash, payload.exportedAt, now, payload.measurements.length, userId, prepared.hash, operation)];
  if (deviceId) commands.push(db.prepare(`UPDATE sync_devices SET last_used_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL AND ${receiptGuard}`).bind(now, deviceId, userId, userId, prepared.hash, operation));
  await db.batch(commands);
  const saved = await batchRow(db, userId, prepared.hash);
  if (!saved) {
    await unchangedChannel(db, userId, prepared.channel, deviceId);
    if (deviceId && !await db.prepare('SELECT id FROM sync_devices WHERE id=? AND user_id=? AND revoked_at IS NULL').bind(deviceId, userId).first()) throw new HealthImportConflictError('SYNC_DEVICE_INVALID', '同步连接已撤销。');
    throw new HealthImportConflictError();
  }
  if (saved.operationId !== operation) await unchangedChannel(db, userId, prepared.channel, deviceId);
  return { ...JSON.parse(saved.receiptJson), replayed: saved.operationId !== operation, reverted: saved.revertedAt !== null,
    attemptSummary: saved.operationId === operation ? prepared.attemptSummary : replaySummary(prepared.attemptSummary, saved.revertedAt !== null) };
}
export async function listHealthImports(db: HealthImportDatabase, userId: string) {
  const rows = await db.prepare('SELECT ' + columns + ' FROM health_import_batches WHERE user_id=? ORDER BY created_at DESC, batch_id DESC LIMIT 20').bind(userId).all<BatchRow>();
  return rows.results.map((row) => ({ ...JSON.parse(row.receiptJson), batchId: row.batchId, createdAt: row.createdAt, revertedAt: row.revertedAt, revertReason: row.revertReason }));
}
export async function revertHealthImport(db: HealthImportDatabase, userId: string, id: string, reason: string, now = new Date().toISOString()) {
  const channel = await readNativeHealthChannelPolicy(db, userId);
  // Manual record correction remains available. Raw batch rollback must not
  // compete with an explicitly selected automatic ingestion channel.
  if (channel.deviceId !== null) channelRequired();
  const prior = await batchRow(db, userId, id);
  if (!prior) throw new HealthImportConflictError('HEALTH_IMPORT_NOT_FOUND', '找不到这次导入。');
  if (prior.revertedAt) {
    await unchangedChannel(db, userId, channel, null);
    return { ok: true, replayed: true, revertedAt: prior.revertedAt };
  }
  const after = JSON.parse(prior.afterJson) as ImportBase[];
  if (!after.length) throw new HealthImportConflictError('HEALTH_IMPORT_NOT_REVERSIBLE', '这次导入没有修改原始记录，无需回退。');
  const before = JSON.parse(prior.beforeJson) as Array<{ recordKey: string; base: ImportBase | null }>;
  const revertId = crypto.randomUUID();
  const guard = `NOT EXISTS (SELECT 1 FROM json_each(?) a LEFT JOIN health_measurements b
    ON b.user_id=? AND b.record_key=json_extract(a.value,'$.recordKey')
    WHERE b.measurement_json IS NOT json_extract(a.value,'$.measurementJson') OR b.exported_at IS NOT json_extract(a.value,'$.exportedAt')
      OR b.received_at IS NOT json_extract(a.value,'$.receivedAt'))
    AND NOT EXISTS (SELECT 1 FROM json_each(?) p JOIN health_record_overrides o
      ON o.user_id=? AND o.record_key=json_extract(p.value,'$.recordKey')
      WHERE json_extract(p.value,'$.base') IS NULL)`;
  const ownsRevert = `EXISTS (SELECT 1 FROM health_import_batches WHERE user_id=? AND batch_id=? AND revert_id=?)`;
  const result = await db.batch([
    db.prepare(`UPDATE health_import_batches SET reverted_at=?,revert_reason=?,revert_id=? WHERE user_id=? AND batch_id=? AND reverted_at IS NULL AND ${guard} AND ${channelGuard}`)
      .bind(now, reason, revertId, userId, id, prior.afterJson, userId, prior.beforeJson, userId, userId, channel.revision, userId, channel.deviceId),
    db.prepare(`DELETE FROM health_measurements WHERE user_id=? AND record_key IN (SELECT json_extract(value,'$.recordKey') FROM json_each(?) WHERE json_extract(value,'$.base') IS NULL) AND ${ownsRevert}`)
      .bind(userId, prior.beforeJson, userId, id, revertId),
    db.prepare(`INSERT INTO health_measurements (user_id,record_key,metric,day,measurement_json,exported_at,received_at)
      SELECT ?,json_extract(value,'$.recordKey'),json_extract(value,'$.metric'),json_extract(value,'$.day'),json_extract(value,'$.measurementJson'),json_extract(value,'$.exportedAt'),json_extract(value,'$.receivedAt')
      FROM json_each(?) WHERE ${ownsRevert} ON CONFLICT(user_id,record_key) DO UPDATE SET metric=excluded.metric,day=excluded.day,
      measurement_json=excluded.measurement_json,exported_at=excluded.exported_at,received_at=excluded.received_at`)
      .bind(userId, JSON.stringify(before.filter((row) => row.base).map((row) => row.base)), userId, id, revertId),
  ]);
  if (result[0].meta.changes !== 1) {
    await unchangedChannel(db, userId, channel, null);
    const saved = await batchRow(db, userId, id);
    if (saved?.revertedAt) return { ok: true, replayed: true, revertedAt: saved.revertedAt };
    throw new HealthImportConflictError('HEALTH_IMPORT_REVERT_CONFLICT', '这些原始记录已有后续同步，或本批新增记录已有手工修改，不能直接回退整批。请到记录管理逐条核对。');
  }
  return { ok: true, replayed: false, revertedAt: now };
}
