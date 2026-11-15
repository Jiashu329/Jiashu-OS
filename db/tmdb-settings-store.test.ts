import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { encryptAIKey } from '../lib/ai-settings-crypto.ts';
import { decryptTMDBToken, encryptTMDBToken, TMDBSettingsCryptoError } from '../lib/tmdb-settings-crypto.ts';
import { clearTMDBSettings, readTMDBSettings, readTMDBSettingsOwner, recordTMDBSettingsTest, resolveTMDBConfiguration,
  saveTMDBSettings, TMDBSettingsConflictError, TMDBSettingsOwnerUnavailableError, TMDBSettingsValidationError } from './tmdb-settings-store.ts';
import type { TMDBSettingsDatabase } from './tmdb-settings-store.ts';
const MASTER = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const TOKEN = 'synthetic-tmdb-private-token';
const NOW = '2026-11-15T01:00:00.000Z';
const env = { APP_OWNER_USER_ID: 'owner', AI_SETTINGS_ENCRYPTION_KEY: MASTER };
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  t.after(() => sqlite.close());
  const writes: unknown[] = [];
  const db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
    const bound = { bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; writes.push(parameters); return bound; },
      async first<T>() { await Promise.resolve(); return (statement.get(...values) as T | undefined) ?? null; } };
    return bound;
  } } as unknown as TMDBSettingsDatabase;
  return { sqlite, db, writes };
}
test('owner resolution reads established identity without bootstrapping a visitor', async t => {
  const f = fixture(t);
  await assert.rejects(readTMDBSettingsOwner(f.db, {}), TMDBSettingsOwnerUnavailableError);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_owner_identity').get()?.n, 0);
  f.sqlite.prepare("INSERT INTO app_owner_identity (id,user_id,email,created_at) VALUES ('owner','established','owner@example.test',?)").run(NOW);
  assert.equal(await readTMDBSettingsOwner(f.db, {}), 'established');
  assert.equal(await readTMDBSettingsOwner(f.db, env), 'owner');
});
test('only encrypted token is stored; shared resolver uses owner and is safe to serialize', async t => {
  const f = fixture(t);
  assert.deepEqual(await resolveTMDBConfiguration(f.db, env), { configured: false, revision: 0 });
  const saved = await saveTMDBSettings(f.db, 'owner', { token: TOKEN, expectedRevision: 0 }, MASTER, NOW);
  assert.equal(saved.configured, true); assert.equal(saved.revision, 1);
  await saveTMDBSettings(f.db, 'visitor', { token: 'synthetic-other-owner-token', expectedRevision: 0 }, MASTER, NOW);
  const config = await resolveTMDBConfiguration(f.db, env);
  assert.equal(config.configured, true);
  if (config.configured) assert.equal(config.token, TOKEN);
  for (const value of [saved, await readTMDBSettings(f.db, 'owner'), config, f.writes, f.sqlite.prepare('SELECT * FROM tmdb_settings').all()]) {
    assert.ok(!JSON.stringify(value).includes(TOKEN)); assert.ok(!JSON.stringify(value).includes(MASTER));
  }
  assert.deepEqual(await resolveTMDBConfiguration(f.db, { ...env, APP_OWNER_USER_ID: 'new-owner' }), { configured: false, revision: 0 });
});
test('TMDB AAD rejects copied owner credentials and AI ciphertext under the same master key', async () => {
  const encrypted = await encryptTMDBToken(MASTER, 'owner', TOKEN), again = await encryptTMDBToken(MASTER, 'owner', TOKEN);
  assert.notEqual(encrypted.iv, again.iv);
  assert.equal(await decryptTMDBToken(MASTER, 'owner', encrypted), TOKEN);
  await assert.rejects(decryptTMDBToken(MASTER, 'other-owner', encrypted), TMDBSettingsCryptoError);
  await assert.rejects(decryptTMDBToken(MASTER, 'owner', await encryptAIKey(MASTER, 'owner', TOKEN)), TMDBSettingsCryptoError);
  await assert.rejects(decryptTMDBToken('invalid-master', 'owner', encrypted), error => {
    assert.ok(error instanceof TMDBSettingsCryptoError); assert.ok(!JSON.stringify(error).includes(TOKEN)); return true;
  });
});
test('blank keeps the saved token and clear tombstone blocks stale resurrection and stale tests', async t => {
  const f = fixture(t);
  await assert.rejects(saveTMDBSettings(f.db, 'owner', { token: '', expectedRevision: 0 }, MASTER), TMDBSettingsValidationError);
  await saveTMDBSettings(f.db, 'owner', { token: TOKEN, expectedRevision: 0 }, MASTER, NOW);
  await recordTMDBSettingsTest(f.db, 'owner', 1, true, NOW);
  const kept = await saveTMDBSettings(f.db, 'owner', { token: '  ', expectedRevision: 1 }, MASTER, NOW);
  assert.equal(kept.revision, 2); assert.equal(kept.lastTestStatus, null);
  const resolved = await resolveTMDBConfiguration(f.db, env); assert.equal(resolved.configured && resolved.token, TOKEN);
  const cleared = await clearTMDBSettings(f.db, 'owner', 2, NOW);
  assert.equal(cleared.configured, false); assert.equal(cleared.revision, 3);
  await assert.rejects(saveTMDBSettings(f.db, 'owner', { token: TOKEN, expectedRevision: 2 }, MASTER), TMDBSettingsConflictError);
  await assert.rejects(recordTMDBSettingsTest(f.db, 'owner', 2, true), TMDBSettingsConflictError);
  await assert.rejects(resolveTMDBConfiguration(f.db, env, 2), TMDBSettingsConflictError);
  assert.deepEqual(await resolveTMDBConfiguration(f.db, { APP_OWNER_USER_ID: 'owner' }), { configured: false, revision: 3 });
});
test('concurrent first saves have one winner and a secret can still be deleted without an encryption key', async t => {
  const f = fixture(t), results = await Promise.allSettled([
    saveTMDBSettings(f.db, 'owner', { token: TOKEN, expectedRevision: 0 }, MASTER),
    saveTMDBSettings(f.db, 'owner', { token: 'synthetic-competing-token', expectedRevision: 0 }, MASTER),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const lost = results.find(r => r.status === 'rejected'); assert.ok(lost?.status === 'rejected' && lost.reason instanceof TMDBSettingsConflictError);
  await assert.rejects(resolveTMDBConfiguration(f.db, { APP_OWNER_USER_ID: 'owner' }), TMDBSettingsCryptoError);
  assert.equal((await clearTMDBSettings(f.db, 'owner', 1)).configured, false);
});
