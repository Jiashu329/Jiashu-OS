import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { clearNativeHealthChannel, NativeHealthChannelError, readNativeHealthChannel, selectNativeHealthChannel,
  type NativeHealthChannelDatabase } from './native-health-channel-store.ts';
import { BACKUP_TABLE_NAMES } from '../lib/data-backup.ts';

const NOW = '2026-11-17T08:00:00.000Z', HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64), HASH_C = 'c'.repeat(64);
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  for (const file of ['0001_neat_zzzax.sql', '0036_native_health_channels.sql']) sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  let race: (() => void) | undefined;
  const db = { prepare(sql: string) {
    const query = sqlite.prepare(sql); let args: SQLInputValue[] = [];
    const statement = { bind(...values: unknown[]) { args = values as SQLInputValue[]; return statement; },
      async first<T>() { return query.get(...args) as T ?? null; },
      async all<T>() { return { results: query.all(...args) as T[] }; },
      async run() { return { meta: { changes: Number(query.run(...args).changes) } }; } };
    return statement;
  }, async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const callback = race; race = undefined; callback?.();
    sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as NativeHealthChannelDatabase;
  return { sqlite, db, race(callback: () => void) { race = callback; } };
}
function error(code: string) { return (failure: unknown) => failure instanceof NativeHealthChannelError && failure.code === code; }

void test('selection is server-owned, scoped to the existing owner, hash-only, and an exact retry changes no revision or credential', async t => {
  const f = fixture(t);
  assert.deepEqual(await readNativeHealthChannel(f.db, 'alice', HASH_A), { revision: 0, deviceId: null, label: null, updatedAt: null, isCurrentDevice: false });
  const selected = await selectNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_A, label: 'Alice iPhone', expectedRevision: 0 }, NOW);
  assert.equal(selected.revision, 1); assert.ok(selected.deviceId); assert.equal(selected.label, 'Alice iPhone'); assert.equal(selected.isCurrentDevice, true);
  const retried = await selectNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_A, label: 'Alice iPhone', expectedRevision: 0 }, '2026-11-17T09:00:00.000Z');
  assert.deepEqual(retried, selected);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_devices').get()!.n, 1);
  const safe = await readNativeHealthChannel(f.db, 'alice'); assert.equal(safe.isCurrentDevice, false); assert.equal(safe.deviceId, selected.deviceId);
  assert.doesNotMatch(JSON.stringify(safe), /token|hash|aaaaa/);
  assert.equal((await readNativeHealthChannel(f.db, 'bob', HASH_A)).deviceId, null);
  await assert.rejects(selectNativeHealthChannel(f.db, 'bob', { deviceTokenHash: HASH_A, label: 'Bob', expectedRevision: 0 }, NOW), error('NATIVE_HEALTH_CHANNEL_DEVICE_INVALID'));
  assert.equal((await readNativeHealthChannel(f.db, 'bob')).revision, 0);
});

void test('changing the selected device is CAS-protected and revokes only the old selected native connection', async t => {
  const f = fixture(t);
  f.sqlite.prepare('INSERT INTO sync_devices VALUES (?,?,?,?,?,?,?)').run('legacy', 'alice', 'Legacy shortcut', 'legacy-hash', NOW, null, null);
  const first = await selectNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_A, label: 'Old iPhone', expectedRevision: 0 }, NOW);
  await assert.rejects(selectNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_B, label: 'New iPhone', expectedRevision: 0 }, NOW), error('NATIVE_HEALTH_CHANNEL_STALE'));
  const next = await selectNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_B, label: 'New iPhone', expectedRevision: 1 }, NOW);
  assert.equal(next.revision, 2); assert.notEqual(next.deviceId, first.deviceId); assert.equal(next.isCurrentDevice, true);
  assert.equal((await readNativeHealthChannel(f.db, 'alice', HASH_A)).isCurrentDevice, false);
  assert.equal(f.sqlite.prepare('SELECT revoked_at FROM sync_devices WHERE id=?').get(first.deviceId)?.revoked_at, NOW);
  assert.equal(f.sqlite.prepare('SELECT revoked_at FROM sync_devices WHERE id=?').get('legacy')?.revoked_at, null);
  await assert.rejects(selectNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_A, label: 'Old iPhone', expectedRevision: 2 }, NOW), error('NATIVE_HEALTH_CHANNEL_DEVICE_INVALID'));
});

void test('clear requires the selected device, keeps a revision tombstone and safely retries without resurrecting its key', async t => {
  const f = fixture(t), selected = await selectNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_A, label: 'iPhone', expectedRevision: 0 }, NOW);
  await assert.rejects(clearNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_B, expectedRevision: 1 }, NOW), error('NATIVE_HEALTH_CHANNEL_NOT_CURRENT'));
  await assert.rejects(clearNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_A, expectedRevision: 0 }, NOW), error('NATIVE_HEALTH_CHANNEL_STALE'));
  const cleared = await clearNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_A, expectedRevision: 1 }, NOW);
  assert.deepEqual(cleared, { revision: 2, deviceId: null, label: null, updatedAt: NOW, isCurrentDevice: false });
  assert.deepEqual(await clearNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_A, expectedRevision: 1 }, NOW), cleared);
  assert.equal(f.sqlite.prepare('SELECT revoked_at FROM sync_devices WHERE id=?').get(selected.deviceId)?.revoked_at, NOW);
  await assert.rejects(selectNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_A, label: 'iPhone', expectedRevision: 2 }, NOW), error('NATIVE_HEALTH_CHANNEL_DEVICE_INVALID'));
  const next = await selectNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_B, label: 'iPhone reconnected', expectedRevision: 2 }, NOW);
  assert.equal(next.revision, 3); assert.equal(next.isCurrentDevice, true);
  await assert.rejects(clearNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_A, expectedRevision: 3 }, NOW), error('NATIVE_HEALTH_CHANNEL_NOT_CURRENT'));
});

void test('a revoked current credential cannot be restored by retrying selection', async t => {
  const f = fixture(t), selected = await selectNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_A, label: 'iPhone', expectedRevision: 0 }, NOW);
  f.sqlite.prepare('UPDATE sync_devices SET revoked_at=? WHERE id=?').run(NOW, selected.deviceId);
  assert.equal((await readNativeHealthChannel(f.db, 'alice', HASH_A)).isCurrentDevice, false);
  await assert.rejects(selectNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_A, label: 'iPhone', expectedRevision: 1 }, NOW), error('NATIVE_HEALTH_CHANNEL_DEVICE_INVALID'));
  assert.equal(f.sqlite.prepare('SELECT revoked_at FROM sync_devices WHERE id=?').get(selected.deviceId)?.revoked_at, NOW);
});

void test('a concurrent channel selection rejects an obsolete switch without creating an orphan device', async t => {
  const f = fixture(t), first = await selectNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_A, label: 'A', expectedRevision: 0 }, NOW);
  f.race(() => {
    f.sqlite.prepare('INSERT INTO sync_devices VALUES (?,?,?,?,?,?,?)').run('race-winner', 'alice', 'C', HASH_C, NOW, null, null);
    f.sqlite.prepare('UPDATE native_health_channels SET device_id=?,last_device_id=?,revision=2 WHERE user_id=?').run('race-winner', 'race-winner', 'alice');
    f.sqlite.prepare('UPDATE sync_devices SET revoked_at=? WHERE id=?').run(NOW, first.deviceId);
  });
  await assert.rejects(selectNativeHealthChannel(f.db, 'alice', { deviceTokenHash: HASH_B, label: 'B', expectedRevision: 1 }, NOW), error('NATIVE_HEALTH_CHANNEL_STALE'));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_devices WHERE token_hash=?').get(HASH_B)?.n, 0);
  assert.equal((await readNativeHealthChannel(f.db, 'alice', HASH_C)).isCurrentDevice, true);
});

void test('channel controls are not portable business data and invalid input never creates a connection', async t => {
  const f = fixture(t);
  assert.equal((BACKUP_TABLE_NAMES as readonly string[]).includes('native_health_channels'), false);
  for (const input of [
    { deviceTokenHash: 'jso_sync_plaintext', label: 'iPhone', expectedRevision: 0 },
    { deviceTokenHash: HASH_A, label: '', expectedRevision: 0 },
    { deviceTokenHash: HASH_A, label: 'x'.repeat(41), expectedRevision: 0 },
    { deviceTokenHash: HASH_A, label: 'iPhone\nforged', expectedRevision: 0 },
    { deviceTokenHash: HASH_A, label: 'iPhone', expectedRevision: Number.MAX_SAFE_INTEGER },
  ]) await assert.rejects(selectNativeHealthChannel(f.db, 'alice', input, NOW), error('NATIVE_HEALTH_CHANNEL_INVALID'));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_devices').get()!.n, 0);
});
