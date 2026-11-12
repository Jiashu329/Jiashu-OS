import { env } from 'cloudflare:workers';
import { HealthImportConflictError, writeHealthImport, previewHealthImport, listHealthImports, revertHealthImport, type HealthImportOptions } from './health-import-store';
import { buildBodyComposition } from '../lib/body-composition';
import { readEffectiveHealthMeasurements } from './health-records-store';
import { listSyncAttempts, readSyncMetricStatus, recordSyncAttempt, type SyncAttemptInput } from './sync-attempts-store';
import {
  createSyncConnection,
  findSyncConnection,
  listSyncConnections,
  revokeSyncConnection,
  type SyncDeviceMetadata,
} from './sync-connections';
import {
  buildHealthSummary,
  shanghaiDay,
  type HealthMetric,
  type HealthSyncPayload,
} from '../lib/health';

function database(): D1Database {
  if (!env.DB) throw new Error('Health database is not configured');
  return env.DB;
}

export async function readSyncDiagnostics(userId: string) {
  return { attempts: await listSyncAttempts(database(), userId), metricStatus: await readSyncMetricStatus(database(), userId) };
}
export async function saveSyncAttempt(userId: string, input: SyncAttemptInput) {
  return recordSyncAttempt(database(), userId, input);
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
export async function readHealthRange(userId: string, from: string, to: string, metrics?: readonly HealthMetric[]) {
  const db = database();
  const [measurements, last] = await Promise.all([
    readEffectiveHealthMeasurements(db, userId, from, to, metrics),
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

export async function importHealth(userId: string, payload: HealthSyncPayload, deviceId: string | null = null, options: HealthImportOptions = {}) {
  try { return await writeHealthImport(database(), userId, payload, deviceId, options); }
  catch (error) {
    if (error instanceof HealthImportConflictError && error.code === 'SYNC_DEVICE_INVALID') throw new SyncDeviceInvalidError();
    throw error;
  }
}
export async function previewImport(userId: string, payload: HealthSyncPayload) {
  return previewHealthImport(database(), userId, payload);
}
export async function readImportHistory(userId: string) { return listHealthImports(database(), userId); }
export async function revertImport(userId: string, id: string, reason: string) { return revertHealthImport(database(), userId, id, reason); }

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

export async function exportHealth(userId: string,range?:{from:string;to:string}): Promise<HealthSyncPayload> {
  const data = range?await readHealthRange(userId,range.from,range.to):await readHealth(userId, 90);
  return {
    version: 1,
    source: 'apple-health-shortcuts',
    timezone: 'Asia/Shanghai',
    exportedAt: new Date().toISOString(),
    measurements: data.measurements,
  };
}
