import { env } from 'cloudflare:workers';
import { buildBodyComposition } from '../lib/body-composition';
import { readEffectiveHealthMeasurements } from './health-records-store';
import {
  createSyncConnection,
  findSyncConnection,
  listSyncConnections,
  revokeSyncConnection,
  type SyncDeviceMetadata,
} from './sync-connections';
import {
  buildHealthSummary,
  measurementDay,
  measurementKey,
  shanghaiDay,
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
  const [measurements, last] = await Promise.all([
    readEffectiveHealthMeasurements(db, userId, fromDay(days)),
    db.prepare('SELECT MAX(received_at) AS received_at FROM health_syncs WHERE user_id = ?')
      .bind(userId).first<{ received_at: string | null }>(),
  ]);
  return {
    summary: buildHealthSummary(measurements),
    bodyComposition: buildBodyComposition(measurements),
    measurements,
    lastSync: last?.received_at ?? null,
  };
}

/** Inclusive Shanghai calendar-day range for selected historical health reviews. */
export async function readHealthRange(userId: string, from: string, to: string) {
  const db = database();
  const [measurements, last] = await Promise.all([
    readEffectiveHealthMeasurements(db, userId, from, to),
    db.prepare('SELECT MAX(received_at) AS received_at FROM health_syncs WHERE user_id = ?')
      .bind(userId).first<{ received_at: string | null }>(),
  ]);
  return {
    summary: buildHealthSummary(measurements),
    bodyComposition: buildBodyComposition(measurements),
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

export type { SyncDeviceMetadata } from './sync-connections';

export async function listSyncDevices(userId: string): Promise<SyncDeviceMetadata[]> {
  return listSyncConnections(database(), userId);
}

export async function createSyncDevice(userId: string, label: string, tokenHash: string): Promise<string | null> {
  return createSyncConnection(database(), userId, label, tokenHash);
}

export async function findSyncDevice(userId: string, tokenHash: string): Promise<string | null> {
  return findSyncConnection(database(), userId, tokenHash);
}

export async function revokeSyncDevice(userId: string, deviceId: string): Promise<boolean> {
  return revokeSyncConnection(database(), userId, deviceId);
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
