import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { AppleActivityValidationError, parseAppleActivityPayload } from '../lib/apple-health-activity.ts';
import { SQLiteD1Database } from '../selfhost/database.ts';
import { AppleActivityDeviceError, readAppleActivity, writeAppleActivity } from './apple-health-activity-store.ts';
import { selectNativeHealthChannel } from './native-health-channel-store.ts';

const DAY = '2026-11-21';
const EXPORTED = '2026-11-21T12:00:00.000Z';
const SYNCED = '2026-11-21T13:00:00.000Z';
const DEVICE = 'a'.repeat(64);
const REPLACEMENT = 'b'.repeat(64);
const OTHER_DEVICE = 'c'.repeat(64);

function payload() {
  return {
    version: 1,
    exportedAt: EXPORTED,
    vitals: [{ day: DAY, heartRate: { average: 78, min: 54, max: 121 },
      restingHeartRate: { value: 62, measuredAt: '2026-11-21T08:14:00+08:00' },
      oxygenSaturation: { latest: 97, average: 96.5, min: 96, max: 97, count: 2, measuredAt: '2026-11-21T08:32:00+08:00' } }],
    workouts: [{ id: '12345678-1234-4321-a123-123456789abc', activityType: 37,
      startDate: '2026-11-20T16:20:00Z', endDate: '2026-11-20T17:20:00Z', durationSeconds: 3300, distanceMeters: 7000 }],
  };
}

function fixture(t: TestContext) {
  const db = new SQLiteD1Database(':memory:');
  t.after(() => db.close());
  db.transaction(() => {
    for (const name of ['0001_neat_zzzax', '0036_native_health_channels', '0038_apple_health_activity']) {
      db.executeMigrationSQL(readFileSync(new URL(`../drizzle/${name}.sql`, import.meta.url), 'utf8'));
    }
  });
  return db;
}

void test('accepts Shanghai calendar days, percent points and a workout with paused time', () => {
  const parsed = parseAppleActivityPayload(payload());
  assert.equal(parsed.vitals[0].oxygenSaturation?.measuredAt, '2026-11-21T00:32:00.000Z');
  assert.equal(parsed.vitals[0].oxygenSaturation?.latest, 97);
  assert.equal(parsed.workouts[0].startDate, '2026-11-20T16:20:00.000Z');
  assert.equal(parsed.workouts[0].durationSeconds, 3300);
  assert.equal(Object.hasOwn(parsed.workouts[0], 'energyKcal'), false);
});

void test('rejects malformed groups, future measurements and duplicate dates or workout IDs', () => {
  const input = payload();
  const vital = input.vitals[0], workout = input.workouts[0];
  for (const candidate of [
    { ...input, sleepScore: 85 },
    { ...input, vitals: [vital, vital] },
    { ...input, workouts: [workout, workout] },
    { ...input, vitals: [{ day: DAY }] },
    { ...input, vitals: [{ ...vital, day: '2026-11-20' }] },
    { ...input, vitals: [{ ...vital, heartRate: { average: 100, min: 72, max: 90 } }] },
    { ...input, vitals: [{ ...vital, oxygenSaturation: { ...vital.oxygenSaturation, count: 0 } }] },
    { ...input, vitals: [{ ...vital, oxygenSaturation: { ...vital.oxygenSaturation, latest: 101 } }] },
    { ...input, vitals: [{ ...vital, restingHeartRate: { value: 50, measuredAt: '2026-11-21T12:00:01Z' } }] },
    { ...input, workouts: [{ ...workout, endDate: '2026-11-20T16:00:00Z' }] },
    { ...input, workouts: [{ ...workout, durationSeconds: 3650 }] },
  ]) assert.throws(() => parseAppleActivityPayload(candidate), AppleActivityValidationError);
});

void test('native activity writes are owner-scoped and updated per metric or workout ID, including replays', async t => {
  const db = fixture(t);
  await selectNativeHealthChannel(db, 'owner', { deviceTokenHash: DEVICE, label: 'iPhone', expectedRevision: 0 }, SYNCED);
  await selectNativeHealthChannel(db, 'other owner', { deviceTokenHash: OTHER_DEVICE, label: 'Other iPhone', expectedRevision: 0 }, SYNCED);
  const input = payload();
  const parsed = parseAppleActivityPayload(input);
  await assert.rejects(writeAppleActivity(db, 'other owner', DEVICE, parsed), AppleActivityDeviceError);
  assert.deepEqual(await writeAppleActivity(db, 'owner', DEVICE, parsed, SYNCED), { received: 4, updated: 4, syncedAt: SYNCED });
  assert.deepEqual(await writeAppleActivity(db, 'owner', DEVICE, parsed, SYNCED), { received: 4, updated: 0, syncedAt: SYNCED });
  const replacement = parseAppleActivityPayload({ ...input, exportedAt: SYNCED, vitals: [{ day: DAY, heartRate: { average: 83, min: 70, max: 92 } }],
    workouts: [{ ...input.workouts[0], energyKcal: 700 }] });
  assert.equal((await writeAppleActivity(db, 'owner', DEVICE, replacement)).updated, 2);
  assert.equal((await writeAppleActivity(db, 'owner', DEVICE, parsed)).updated, 0);
  const saved = await readAppleActivity(db, 'owner', DAY, DAY);
  assert.deepEqual(saved.vitals, [{ ...parsed.vitals[0], heartRate: replacement.vitals[0].heartRate }]);
  assert.deepEqual(saved.workouts, replacement.workouts);
  assert.deepEqual((await readAppleActivity(db, 'owner', '2026-11-20', '2026-11-20')).workouts, []);
  assert.deepEqual(await readAppleActivity(db, 'other owner', DAY, DAY), { from: DAY, to: DAY, vitals: [], workouts: [] });
});

void test('a moved daily device cannot write, even when the change occurs at the transaction boundary', async t => {
  const db = fixture(t);
  const parsed = parseAppleActivityPayload(payload());
  await assert.rejects(writeAppleActivity(db, 'owner', DEVICE, parsed), AppleActivityDeviceError);
  await selectNativeHealthChannel(db, 'owner', { deviceTokenHash: DEVICE, label: 'Old iPhone', expectedRevision: 0 }, SYNCED);
  const changed = {
    prepare: db.prepare.bind(db),
    async batch<T>(statements: D1PreparedStatement[]) {
      await selectNativeHealthChannel(db, 'owner', { deviceTokenHash: REPLACEMENT, label: 'New iPhone', expectedRevision: 1 }, SYNCED);
      return db.batch<T>(statements);
    },
  };
  await assert.rejects(writeAppleActivity(changed, 'owner', DEVICE, parsed), AppleActivityDeviceError);
  assert.deepEqual((await readAppleActivity(db, 'owner', DAY, DAY)).vitals, []);
  assert.equal((await writeAppleActivity(db, 'owner', REPLACEMENT, parsed)).updated, 4);
});
