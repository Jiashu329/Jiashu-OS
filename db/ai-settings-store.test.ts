import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { AISettingsCryptoError, decryptAIKey } from '../lib/ai-settings-crypto.ts';
import { callHealthAssistant } from '../lib/ai-provider.ts';
import {
  AISettingsConflictError, AISettingsValidationError, clearAISettings, readAISettings,
  recordAISettingsTest, resolveUserAIConfiguration, saveAISettings,
} from './ai-settings-store.ts';
import type { AISettingsDatabase, AISettingsInput } from './ai-settings-store.ts';

const master = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)));
const aliceKey = 'sk-synthetic-alice-private';
const bobKey = 'sk-synthetic-bob-private';
const NOW = '2026-11-11T03:00:00.000Z';
const LATER = '2026-11-11T03:01:00.000Z';
const settings = (expectedRevision = 0, apiKey: string | undefined = aliceKey): AISettingsInput => ({ apiKey, model: 'MiniMax-M3', region: 'cn', expectedRevision });

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE ai_user_settings (
    user_id TEXT PRIMARY KEY NOT NULL, key_ciphertext TEXT, key_iv TEXT,
    model TEXT NOT NULL, region TEXT NOT NULL, revision INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_test_status TEXT, last_test_at TEXT
  )`);
  t.after(() => sqlite.close());
  const calls: Array<{ sql: string; parameters: unknown[] }> = [];
  function client(): AISettingsDatabase {
    return {
      prepare(sql: string) {
        const statement = sqlite.prepare(sql);
        let values: SQLInputValue[] = [];
        const bound = {
          bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; calls.push({ sql, parameters: [...parameters] }); return bound; },
          async first<T>() {
            await Promise.resolve();
            return (statement.get(...values) as T | undefined) ?? null;
          },
        };
        return bound;
      },
    } as unknown as AISettingsDatabase;
  }
  function encrypted(userId: string) {
    const row = sqlite.prepare('SELECT key_ciphertext, key_iv FROM ai_user_settings WHERE user_id = ?').get(userId)!;
    return { ciphertext: row.key_ciphertext as string, iv: row.key_iv as string };
  }
  return { db: client(), anotherWorker: client(), sqlite, calls, encrypted };
}

void test('absent settings return safe defaults and never fall back to another user key', async (t) => {
  const { db } = fixture(t);
  assert.deepEqual(await readAISettings(db, 'bob'), { configured: false, model: 'MiniMax-M3', region: 'cn', revision: 0, updatedAt: null, lastTestStatus: null, lastTestAt: null });
  await saveAISettings(db, 'alice', settings(), master, NOW);
  const bob = await resolveUserAIConfiguration(db, 'bob');
  assert.equal(bob.ready, false);
  assert.equal((await readAISettings(db, 'bob')).configured, false);
  assert.ok(!JSON.stringify(bob).includes(aliceKey));
});

void test('saving stores ciphertext only and both public metadata and provider configuration hide secrets', async (t) => {
  const { db, sqlite, calls, encrypted } = fixture(t);
  const saved = await saveAISettings(db, 'alice', settings(), master, NOW);
  assert.deepEqual(saved, { configured: true, model: 'MiniMax-M3', region: 'cn', revision: 1, updatedAt: NOW, lastTestStatus: null, lastTestAt: null });
  assert.deepEqual(await readAISettings(db, 'alice'), saved);
  assert.equal(await decryptAIKey(master, 'alice', encrypted('alice')), aliceKey);
  for (const serialized of [JSON.stringify(saved), JSON.stringify(calls), JSON.stringify(sqlite.prepare('SELECT * FROM ai_user_settings').all())]) {
    assert.ok(!serialized.includes(aliceKey));
    assert.ok(!serialized.includes(master));
  }
  assert.deepEqual(Object.keys(saved).sort(), ['configured', 'lastTestAt', 'lastTestStatus', 'model', 'region', 'revision', 'updatedAt']);
  const configuration = await resolveUserAIConfiguration(db, 'alice', master);
  assert.equal(configuration.ready, true);
  assert.ok(!JSON.stringify(configuration).includes(aliceKey));
  await callHealthAssistant(configuration, { question: '连接测试', context: {} }, { fetch: async (_url, options) => {
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer ' + aliceKey);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '连接正常。' } }] });
  } });
});

void test('blank or omitted keys retain the existing key, re-encrypt and reset test status', async (t) => {
  const { db, encrypted } = fixture(t);
  await saveAISettings(db, 'alice', settings(), master, NOW);
  const firstIv = encrypted('alice').iv;
  await recordAISettingsTest(db, 'alice', 1, true, LATER);
  const saved = await saveAISettings(db, 'alice', { ...settings(1, '  '), model: 'MiniMax-M3.1-flash', region: 'global' }, master, LATER);
  assert.equal(saved.revision, 2);
  assert.equal(saved.region, 'global');
  assert.equal(saved.model, 'MiniMax-M3.1-flash');
  assert.equal(saved.lastTestStatus, null);
  assert.equal(saved.lastTestAt, null);
  assert.notEqual(encrypted('alice').iv, firstIv);
  assert.equal(await decryptAIKey(master, 'alice', encrypted('alice')), aliceKey);
  await saveAISettings(db, 'alice', { model: 'MiniMax-M3', region: 'cn', expectedRevision: 2 }, master, LATER);
  assert.equal(await decryptAIKey(master, 'alice', encrypted('alice')), aliceKey);
  await assert.rejects(() => saveAISettings(db, 'bob', { model: 'MiniMax-M3', region: 'cn', expectedRevision: 0 }, master, NOW), AISettingsValidationError);
});

void test('a new key repairs damaged encryption without depending on the previous ciphertext', async (t) => {
  const { db, sqlite, encrypted } = fixture(t);
  await saveAISettings(db, 'alice', settings(), master, NOW);
  sqlite.prepare("UPDATE ai_user_settings SET key_ciphertext = 'invalid-base64' WHERE user_id = ?").run('alice');
  await assert.rejects(() => resolveUserAIConfiguration(db, 'alice', master), AISettingsCryptoError);
  await assert.rejects(() => saveAISettings(db, 'alice', { model: 'MiniMax-M3', region: 'cn', expectedRevision: 1 }, master, LATER), AISettingsCryptoError);
  assert.equal((await readAISettings(db, 'alice')).revision, 1);
  const repaired = await saveAISettings(db, 'alice', settings(1, bobKey), master, LATER);
  assert.equal(repaired.revision, 2);
  assert.equal(await decryptAIKey(master, 'alice', encrypted('alice')), bobKey);
});

void test('owner-bound encryption and owner filters isolate settings and clearing', async (t) => {
  const { db, sqlite, encrypted } = fixture(t);
  await Promise.all([saveAISettings(db, 'alice', settings(), master, NOW), saveAISettings(db, 'bob', settings(0, bobKey), master, NOW)]);
  assert.equal(await decryptAIKey(master, 'bob', encrypted('bob')), bobKey);
  const alice = encrypted('alice');
  sqlite.prepare('UPDATE ai_user_settings SET key_ciphertext = ?, key_iv = ? WHERE user_id = ?').run(alice.ciphertext, alice.iv, 'bob');
  await assert.rejects(() => resolveUserAIConfiguration(db, 'bob', master), AISettingsCryptoError);
  await clearAISettings(db, 'bob', 1, LATER);
  assert.equal((await readAISettings(db, 'bob')).configured, false);
  assert.equal((await resolveUserAIConfiguration(db, 'alice', master)).ready, true);
});

void test('concurrent first inserts and updates admit one winner per selected revision', async (t) => {
  const { db, anotherWorker, encrypted } = fixture(t);
  const initial = await Promise.allSettled([
    saveAISettings(db, 'alice', settings(), master, NOW), saveAISettings(anotherWorker, 'alice', settings(0, bobKey), master, NOW),
  ]);
  assert.equal(initial.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(initial.some((result) => result.status === 'rejected' && result.reason instanceof AISettingsConflictError));
  assert.equal((await readAISettings(db, 'alice')).revision, 1);
  const updates = await Promise.allSettled([
    saveAISettings(db, 'alice', settings(1, aliceKey), master, LATER), saveAISettings(anotherWorker, 'alice', settings(1, bobKey), master, LATER),
  ]);
  assert.equal(updates.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(updates.some((result) => result.status === 'rejected' && result.reason instanceof AISettingsConflictError));
  assert.equal((await readAISettings(db, 'alice')).revision, 2);
  assert.ok([aliceKey, bobKey].includes(await decryptAIKey(master, 'alice', encrypted('alice'))));
});

void test('clear keeps a revisioned tombstone and rejects stale saves, clears and test receipts', async (t) => {
  const { db, sqlite } = fixture(t);
  await saveAISettings(db, 'alice', settings(), master, NOW);
  await recordAISettingsTest(db, 'alice', 1, true, LATER);
  const cleared = await clearAISettings(db, 'alice', 1, LATER);
  assert.deepEqual(cleared, { configured: false, model: 'MiniMax-M3', region: 'cn', revision: 2, updatedAt: LATER, lastTestStatus: null, lastTestAt: null });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM ai_user_settings WHERE user_id=?').get('alice')?.total, 1);
  const row = sqlite.prepare('SELECT key_ciphertext, key_iv FROM ai_user_settings WHERE user_id=?').get('alice')!;
  assert.equal(row.key_ciphertext, null);
  assert.equal(row.key_iv, null);
  await assert.rejects(() => saveAISettings(db, 'alice', settings(1), master, LATER), AISettingsConflictError);
  await assert.rejects(() => clearAISettings(db, 'alice', 1, LATER), AISettingsConflictError);
  await assert.rejects(() => recordAISettingsTest(db, 'alice', 1, false, LATER), AISettingsConflictError);
  await assert.rejects(() => recordAISettingsTest(db, 'alice', 2, true, LATER), AISettingsConflictError);
  await assert.rejects(() => saveAISettings(db, 'alice', { model: 'MiniMax-M3', region: 'cn', expectedRevision: 2 }, master, LATER), AISettingsValidationError);
  assert.equal((await resolveUserAIConfiguration(db, 'alice')).ready, false);
  assert.equal((await saveAISettings(db, 'alice', settings(2), master, LATER)).revision, 3);
});

void test('clearing absent settings creates a tombstone that blocks an in-flight first save', async (t) => {
  const { db, sqlite } = fixture(t);
  const cleared = await clearAISettings(db, 'alice', 0, NOW);
  assert.equal(cleared.revision, 1);
  assert.equal(cleared.configured, false);
  await assert.rejects(() => saveAISettings(db, 'alice', settings(), master, LATER), AISettingsConflictError);
  await assert.rejects(() => clearAISettings(db, 'alice', 0, LATER), AISettingsConflictError);
  await saveAISettings(db, 'alice', settings(1), master, LATER);
  assert.equal(sqlite.prepare('SELECT created_at FROM ai_user_settings WHERE user_id=?').get('alice')?.created_at, NOW);
});

void test('test status is version-bound, does not increment revision, and resets after a new save', async (t) => {
  const { db } = fixture(t);
  await saveAISettings(db, 'alice', settings(), master, NOW);
  const tested = await recordAISettingsTest(db, 'alice', 1, false, LATER);
  assert.equal(tested.revision, 1);
  assert.equal(tested.updatedAt, NOW);
  assert.equal(tested.lastTestStatus, 'failed');
  assert.equal(tested.lastTestAt, LATER);
  assert.equal((await resolveUserAIConfiguration(db, 'alice', master, 1)).ready, true);
  await saveAISettings(db, 'alice', settings(1, bobKey), master, LATER);
  await assert.rejects(() => recordAISettingsTest(db, 'alice', 1, true, LATER), AISettingsConflictError);
  await assert.rejects(() => resolveUserAIConfiguration(db, 'alice', undefined, 1), AISettingsConflictError);
  assert.equal((await readAISettings(db, 'alice')).lastTestStatus, null);
  await assert.rejects(() => resolveUserAIConfiguration(db, 'bob', undefined, 1), AISettingsConflictError);
  assert.equal((await resolveUserAIConfiguration(db, 'bob', undefined, 0)).ready, false);
});

void test('missing or invalid master keys fail safely while clearing remains available', async (t) => {
  const { db } = fixture(t);
  await saveAISettings(db, 'alice', settings(), master, NOW);
  await assert.rejects(() => resolveUserAIConfiguration(db, 'alice'), AISettingsCryptoError);
  await assert.rejects(() => resolveUserAIConfiguration(db, 'alice', 'PRIVATE_INVALID_MASTER'), AISettingsCryptoError);
  await assert.rejects(() => saveAISettings(db, 'alice', settings(1, ' '), 'PRIVATE_INVALID_MASTER', LATER), AISettingsCryptoError);
  const cleared = await clearAISettings(db, 'alice', 1, LATER);
  assert.equal(cleared.configured, false);
});

void test('validation rejects credential-like models and malformed revisions without persisting or echoing input', async (t) => {
  const { db, sqlite } = fixture(t);
  const invalid = [
    { ...settings(), model: aliceKey }, { ...settings(0, 'MiniMax-M3'), model: 'MiniMax-M3' },
    { ...settings(), model: 'MiniMax-' + aliceKey },
    { ...settings(), apiKey: 'bad key with spaces' }, { ...settings(), model: 'other-provider' },
    { ...settings(), region: 'PRIVATE_BAD_REGION' as 'cn' },
    ...[-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER].map((expectedRevision) => ({ ...settings(), expectedRevision })),
  ];
  for (const input of invalid) await assert.rejects(() => saveAISettings(db, 'alice', input, master, NOW), (error: unknown) => {
    assert.ok(error instanceof AISettingsValidationError);
    assert.ok(!String(error).includes(aliceKey));
    assert.ok(!String(error).includes('PRIVATE_BAD_REGION'));
    assert.equal(error.code, 'INVALID_AI_SETTINGS');
    return true;
  });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM ai_user_settings').get()?.total, 0);
});
