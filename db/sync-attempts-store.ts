import { emptySyncSummary, SYNC_FAILURES, SYNC_METRICS, type SyncAttemptStatus, type SyncAttemptSummary, type SyncFailureCode } from '../lib/sync-diagnostics.ts';
import type { HealthMetric } from '../lib/health.ts';

export type SyncAttemptsDatabase = Pick<D1Database, 'prepare' | 'batch'>;
export interface SyncAttemptInput {
  channel: 'manual' | 'device'; deviceId?: string | null; status: SyncAttemptStatus;
  batchId?: string | null; errorCode?: SyncFailureCode | null; summary?: SyncAttemptSummary;
}
export interface SyncAttemptView {
  attemptId: string; createdAt: string; channel: 'manual' | 'device'; deviceLabel: string | null;
  status: SyncAttemptStatus; batchId: string | null; errorCode: SyncFailureCode | null; summary: SyncAttemptSummary;
  guidance: string | null;
}
interface AttemptRow extends Omit<SyncAttemptView, 'summary' | 'guidance'> { summaryJson: string }
const columns = `attempt_id AS attemptId, created_at AS createdAt, channel, device_label AS deviceLabel,
  CASE WHEN a.status <> 'failed' AND EXISTS (SELECT 1 FROM health_import_batches b
    WHERE b.user_id=a.user_id AND b.batch_id=a.batch_id AND b.reverted_at IS NOT NULL)
    THEN 'reverted' ELSE a.status END AS status,
  batch_id AS batchId, error_code AS errorCode, summary_json AS summaryJson`;

export async function recordSyncAttempt(db: SyncAttemptsDatabase, userId: string, input: SyncAttemptInput, now = new Date().toISOString(), attemptId = crypto.randomUUID()) {
  const device = input.deviceId ? await db.prepare('SELECT label FROM sync_devices WHERE user_id=? AND id=?').bind(userId, input.deviceId).first<{ label: string }>() : null;
  await db.batch([
    db.prepare(`INSERT INTO health_sync_attempts (user_id,attempt_id,created_at,channel,device_label,status,batch_id,error_code,summary_json)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(userId, attemptId, now, input.channel, device?.label ?? null, input.status, input.batchId ?? null, input.errorCode ?? null, JSON.stringify(input.summary ?? emptySyncSummary())),
    db.prepare(`DELETE FROM health_sync_attempts WHERE user_id=? AND attempt_id NOT IN
      (SELECT attempt_id FROM health_sync_attempts WHERE user_id=? ORDER BY created_at DESC,attempt_id DESC LIMIT 100)`).bind(userId, userId),
  ]);
  return attemptId;
}
async function loadSyncAttempts(db: SyncAttemptsDatabase, userId: string, limit: 30 | 100): Promise<SyncAttemptView[]> {
  const rows = await db.prepare('SELECT ' + columns + ' FROM health_sync_attempts a WHERE a.user_id=? ORDER BY a.created_at DESC,a.attempt_id DESC LIMIT ?').bind(userId, limit).all<AttemptRow>();
  return rows.results.map(({ summaryJson, ...row }) => ({ ...row, summary: JSON.parse(summaryJson) as SyncAttemptSummary,
    guidance: row.errorCode && Object.hasOwn(SYNC_FAILURES, row.errorCode) ? SYNC_FAILURES[row.errorCode] : null }));
}
export async function listSyncAttempts(db: SyncAttemptsDatabase, userId: string): Promise<SyncAttemptView[]> { return loadSyncAttempts(db, userId, 30); }
export interface SyncMetricStatus {
  metric: HealthMetric; lastRecordDate: string | null; lastReceivedAt: string | null;
  lastAttemptAt: string | null; lastAttemptStatus: SyncAttemptStatus | null; lastErrorCode: SyncFailureCode | null;
}
export async function readSyncMetricStatus(db: SyncAttemptsDatabase, userId: string): Promise<SyncMetricStatus[]> {
  const rows = await db.prepare(`SELECT metric, MAX(day) AS day FROM health_measurements WHERE user_id=? GROUP BY metric`).bind(userId).all<{ metric: HealthMetric; day: string }>();
  const attempts = await loadSyncAttempts(db, userId, 100);
  return SYNC_METRICS.map((metric) => {
    const mentioned = attempts.filter((attempt) => attempt.summary.metrics.some((row) => row.metric === metric));
    const received = mentioned.find((attempt) => !['failed','empty','reverted'].includes(attempt.status) && attempt.summary.metrics.some((row) => row.metric === metric && row.received > 0));
    const last = mentioned[0];
    return { metric, lastRecordDate: rows.results.find((row) => row.metric === metric)?.day ?? null,
      lastReceivedAt: received?.createdAt ?? null, lastAttemptAt: last?.createdAt ?? null,
      lastAttemptStatus: last?.status ?? null, lastErrorCode: last?.errorCode ?? null };
  });
}
