import { env } from 'cloudflare:workers';
import {
  buildHealthSummary,
  measurementDay,
  measurementKey,
  shanghaiDay,
  type HealthMeasurement,
  type HealthSyncPayload,
} from '../lib/health';

function database(): D1Database {
  if (!env.DB) throw new Error('Health database is not configured');
  return env.DB;
}

function fromDay(days: number): string {
  return shanghaiDay(new Date(Date.now() - (days - 1) * 86400000).toISOString());
}

export async function readHealth(userId: string, days: number) {
  const db = database();
  const [rows, last] = await Promise.all([
    db.prepare('SELECT measurement_json FROM health_measurements WHERE user_id = ? AND day >= ? ORDER BY day ASC, record_key ASC')
      .bind(userId, fromDay(days)).all<{ measurement_json: string }>(),
    db.prepare('SELECT MAX(received_at) AS received_at FROM health_syncs WHERE user_id = ?')
      .bind(userId).first<{ received_at: string | null }>(),
  ]);
  const measurements = rows.results.map((row) => JSON.parse(row.measurement_json) as HealthMeasurement);
  return {
    summary: buildHealthSummary(measurements),
    measurements,
    lastSync: last?.received_at ?? null,
  };
}

export class SyncDeviceInvalidError extends Error {
  constructor() {
    super('Sync device is no longer active');
    this.name = 'SyncDeviceInvalidError';
  }
}

export async function importHealth(userId: string, payload: HealthSyncPayload, deviceId: string | null = null) {
  const db = database();
  const receivedAt = new Date().toISOString();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload))))]
    .map((part) => part.toString(16).padStart(2, '0')).join('');
  const records = payload.measurements.map((measurement) => ({
    key: measurementKey(measurement),
    metric: measurement.metric,
    day: measurementDay(measurement),
    measurement: JSON.stringify(measurement),
  }));
  // One JSON-backed INSERT keeps a 1,000-record import within D1's statement
  // and bound-parameter limits. D1 batch applies this and the sync receipt atomically.
  const commands = [db.prepare(`
    INSERT INTO health_measurements
      (user_id, record_key, metric, day, measurement_json, exported_at, received_at)
    SELECT ?, json_extract(value, '$.key'), json_extract(value, '$.metric'),
      json_extract(value, '$.day'), json_extract(value, '$.measurement'), ?, ?
    FROM json_each(?) WHERE
      (? IS NULL OR EXISTS (
        SELECT 1 FROM sync_devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      ))
    ON CONFLICT(user_id, record_key) DO UPDATE SET
      metric = excluded.metric,
      day = excluded.day,
      measurement_json = excluded.measurement_json,
      exported_at = excluded.exported_at,
      received_at = excluded.received_at
    WHERE excluded.exported_at > health_measurements.exported_at
  `).bind(userId, payload.exportedAt, receivedAt, JSON.stringify(records), deviceId, deviceId, userId)];
  commands.push(db.prepare(`
    INSERT INTO health_syncs (user_id, payload_hash, exported_at, received_at, measurement_count)
    SELECT ?, ?, ?, ?, ? WHERE
      (? IS NULL OR EXISTS (
        SELECT 1 FROM sync_devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      ))
    ON CONFLICT(user_id, payload_hash) DO UPDATE SET received_at = excluded.received_at
  `).bind(userId, hash, payload.exportedAt, receivedAt, payload.measurements.length, deviceId, deviceId, userId));
  if (deviceId) {
    commands.push(db.prepare('UPDATE sync_devices SET last_used_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .bind(receivedAt, deviceId, userId));
  }
  const result = await db.batch(commands);
  if (deviceId && result[2].meta.changes !== 1) throw new SyncDeviceInvalidError();
  const imported = result[0].meta.changes ?? 0;
  return { ok: true, imported, skipped: payload.measurements.length - imported, lastSync: receivedAt };
}

export interface SyncDeviceMetadata {
  deviceId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export async function listSyncDevices(userId: string): Promise<SyncDeviceMetadata[]> {
  const result = await database().prepare(`
    SELECT id AS deviceId, label, created_at AS createdAt,
      last_used_at AS lastUsedAt, revoked_at AS revokedAt
    FROM sync_devices WHERE user_id = ?
    ORDER BY (revoked_at IS NULL) DESC, created_at DESC LIMIT 25
  `).bind(userId).all<SyncDeviceMetadata>();
  return result.results;
}

export async function createSyncDevice(userId: string, label: string, tokenHash: string): Promise<string | null> {
  const deviceId = crypto.randomUUID();
  const result = await database().prepare(`
    INSERT INTO sync_devices (id, user_id, label, token_hash, created_at)
    SELECT ?, ?, ?, ?, ? WHERE (
      SELECT COUNT(*) FROM sync_devices WHERE user_id = ? AND revoked_at IS NULL
    ) < 3
  `).bind(deviceId, userId, label, tokenHash, new Date().toISOString(), userId).run();
  return result.meta.changes === 1 ? deviceId : null;
}

export async function findSyncDevice(userId: string, tokenHash: string): Promise<string | null> {
  const row = await database().prepare(`
    SELECT id FROM sync_devices WHERE user_id = ? AND token_hash = ? AND revoked_at IS NULL LIMIT 1
  `).bind(userId, tokenHash).first<{ id: string }>();
  return row?.id ?? null;
}

export async function revokeSyncDevice(userId: string, deviceId: string): Promise<boolean> {
  const result = await database().prepare(`
    UPDATE sync_devices SET revoked_at = COALESCE(revoked_at, ?)
    WHERE id = ? AND user_id = ?
  `).bind(new Date().toISOString(), deviceId, userId).run();
  return result.meta.changes === 1;
}

export async function exportHealth(userId: string): Promise<HealthSyncPayload> {
  const data = await readHealth(userId, 90);
  return {
    version: 1,
    source: 'apple-health-shortcuts',
    timezone: 'Asia/Shanghai',
    exportedAt: new Date().toISOString(),
    measurements: data.measurements,
  };
}
