import { APPLE_VITAL_METRICS, type AppleActivityPayload, type AppleVitalDay, type AppleVitalMetric, type AppleWorkout } from '../lib/apple-health-activity.ts';
import type { AppleActivityDaily, AppleActivityRange, AppleWorkoutSummary } from '../lib/apple-activity-supplements.ts';
import { shanghaiDay } from '../lib/health.ts';

type Database = Pick<D1Database, 'prepare' | 'batch'>;

export class AppleActivityDeviceError extends Error {
  constructor() {
    super('请使用此账号当前选定的 iPhone 同步心率、血氧和训练记录。');
    this.name = 'AppleActivityDeviceError';
  }
}

// The same account, selected device, and unrevoked credential must match
// inside the write transaction, including when the phone changes mid-request.
const isCurrentDevice = `EXISTS(
  SELECT 1 FROM native_health_channels c
  JOIN sync_devices d ON d.user_id=c.user_id AND d.id=c.device_id
  WHERE c.user_id=? AND d.token_hash=? AND d.revoked_at IS NULL
)`;

export async function writeAppleActivity(db: Database, userId: string, tokenHash: string, payload: AppleActivityPayload, syncedAt = new Date().toISOString()) {
  const vitals = payload.vitals.flatMap(day => APPLE_VITAL_METRICS.flatMap(metric => {
    const value = day[metric];
    return value === undefined ? [] : [{ day: day.day, metric, value }];
  }));
  const workouts = payload.workouts.map(workout => ({ day: shanghaiDay(workout.startDate), workout }));
  const [device, savedVitals, savedWorkouts] = await db.batch<{ allowed: number }>([
    db.prepare(`SELECT ${isCurrentDevice} AS allowed`).bind(userId, tokenHash),
    db.prepare(`INSERT INTO health_apple_vitals(user_id, day, metric, value_json, exported_at, received_at)
      SELECT ?, json_extract(j.value, '$.day'), json_extract(j.value, '$.metric'), json_extract(j.value, '$.value'), ?, ?
      FROM json_each(?) j WHERE ${isCurrentDevice}
      ON CONFLICT(user_id, day, metric) DO UPDATE SET value_json=excluded.value_json,
        exported_at=excluded.exported_at, received_at=excluded.received_at
      WHERE excluded.exported_at > health_apple_vitals.exported_at`)
      .bind(userId, payload.exportedAt, syncedAt, JSON.stringify(vitals), userId, tokenHash),
    db.prepare(`INSERT INTO health_apple_workouts(user_id, workout_id, day, start_date, workout_json, exported_at, received_at)
      SELECT ?, json_extract(j.value, '$.workout.id'), json_extract(j.value, '$.day'),
        json_extract(j.value, '$.workout.startDate'), json_extract(j.value, '$.workout'), ?, ?
      FROM json_each(?) j WHERE ${isCurrentDevice}
      ON CONFLICT(user_id, workout_id) DO UPDATE SET day=excluded.day, start_date=excluded.start_date,
        workout_json=excluded.workout_json, exported_at=excluded.exported_at, received_at=excluded.received_at
      WHERE excluded.exported_at > health_apple_workouts.exported_at`)
      .bind(userId, payload.exportedAt, syncedAt, JSON.stringify(workouts), userId, tokenHash),
  ]);
  if (device.results[0]?.allowed !== 1) throw new AppleActivityDeviceError();
  return { received: vitals.length + workouts.length, updated: savedVitals.meta.changes + savedWorkouts.meta.changes, syncedAt };
}

interface VitalRow { day: string; metric: AppleVitalMetric; data: string }

function combineVitals(rows: VitalRow[]): AppleVitalDay[] {
  const days = new Map<string, AppleVitalDay>();
  for (const row of rows) {
    const day = days.get(row.day) ?? { day: row.day };
    day[row.metric] = JSON.parse(row.data);
    days.set(row.day, day);
  }
  return [...days.values()];
}

export async function readAppleActivity(db: Database, userId: string, from: string, to: string) {
  const [vitalRows, workoutRows] = await db.batch<VitalRow>([
    db.prepare(`SELECT day, metric, value_json AS data FROM health_apple_vitals
      WHERE user_id=? AND day BETWEEN ? AND ? ORDER BY day, metric`).bind(userId, from, to),
    db.prepare(`SELECT workout_json AS data FROM health_apple_workouts
      WHERE user_id=? AND day BETWEEN ? AND ? ORDER BY start_date DESC, workout_id`).bind(userId, from, to),
  ]);
  return { from, to, vitals: combineVitals(vitalRows.results), workouts: workoutRows.results.map(row => JSON.parse(row.data) as AppleWorkout) };
}

/** Reduce synced workouts in SQLite so overview reads never transfer individual sessions. */
export async function readAppleActivityDaily(db: Database, userId: string, vitalsRange: AppleActivityRange,
  workoutRange = vitalsRange): Promise<AppleActivityDaily> {
  const { results } = await db.prepare(`SELECT day, metric, value_json AS data FROM health_apple_vitals
    WHERE user_id=? AND day BETWEEN ? AND ?
    UNION ALL
    SELECT day, 'workouts' AS metric, json_object('count', COUNT(*), 'durationSeconds', SUM(json_extract(workout_json, '$.durationSeconds'))) AS data
    FROM health_apple_workouts WHERE user_id=? AND day BETWEEN ? AND ? GROUP BY day ORDER BY day, metric`)
    .bind(userId, vitalsRange.from, vitalsRange.to, userId, workoutRange.from, workoutRange.to)
    .all<VitalRow | { day: string; metric: 'workouts'; data: string }>();
  return {
    vitals: combineVitals(results.filter(row => row.metric !== 'workouts')),
    workouts: results.filter(row => row.metric === 'workouts')
      .map(row => ({ day: row.day, ...(JSON.parse(row.data) as AppleWorkoutSummary) })),
  };
}
