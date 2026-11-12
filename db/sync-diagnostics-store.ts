import { summarizeSyncMeasurements } from '../lib/sync-diagnostics.ts';
import type { SyncImportDiagnostic } from '../lib/sync-diagnostics.ts';
import type { HealthSyncPayload } from '../lib/health.ts';

export type SyncDiagnosticsDatabase = Pick<D1Database, 'prepare'>;

/** Place these statements immediately after the measurement INSERT in the
 * same D1 batch: SQLite changes() then gives that INSERT's exact update count.
 * A diagnostics failure rolls back measurements and the sync receipt too. */
export function syncDiagnosticStatements(db: SyncDiagnosticsDatabase, userId: string, payload: HealthSyncPayload, receivedAt: string, deviceId: string | null) {
  const summaries = summarizeSyncMeasurements(payload.measurements);
  const firstDay = summaries.length ? summaries.map((row) => row.firstDay).sort()[0] : null;
  const lastDay = summaries.length ? summaries.map((row) => row.lastDay).sort().at(-1)! : null;
  const guard = '(? IS NULL OR EXISTS (SELECT 1 FROM sync_devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL))';
  const update = ` ON CONFLICT(user_id, scope) DO UPDATE SET
    received_at = excluded.received_at, exported_at = excluded.exported_at,
    submitted_count = excluded.submitted_count, imported_count = excluded.imported_count,
    skipped_count = excluded.skipped_count, first_day = excluded.first_day, last_day = excluded.last_day`;
  const columns = '(user_id, scope, received_at, exported_at, submitted_count, imported_count, skipped_count, first_day, last_day)';
  const statements = [db.prepare(`INSERT INTO health_sync_diagnostics ${columns}
    SELECT ?, 'batch', ?, ?, ?, changes(), ? - changes(), ?, ? WHERE ${guard}${update}`)
    .bind(userId, receivedAt, payload.exportedAt, payload.measurements.length, payload.measurements.length,
      firstDay, lastDay, deviceId, deviceId, userId)];
  for (const row of summaries) {
    statements.push(db.prepare(`INSERT INTO health_sync_diagnostics ${columns}
      SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, ? WHERE ${guard}${update}`)
      .bind(userId, row.metric, receivedAt, payload.exportedAt, row.submittedCount,
        row.firstDay, row.lastDay, deviceId, deviceId, userId));
  }
  return statements;
}

export async function readSyncImportDiagnostics(db: SyncDiagnosticsDatabase, userId: string): Promise<SyncImportDiagnostic[]> {
  const rows = await db.prepare(`SELECT scope, received_at AS receivedAt, exported_at AS exportedAt,
    submitted_count AS submittedCount, imported_count AS importedCount, skipped_count AS skippedCount,
    first_day AS firstDay, last_day AS lastDay FROM health_sync_diagnostics WHERE user_id = ? ORDER BY scope`)
    .bind(userId).all<SyncImportDiagnostic>();
  return rows.results;
}
