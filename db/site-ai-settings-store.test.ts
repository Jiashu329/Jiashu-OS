import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { AISettingsCryptoError } from '../lib/ai-settings-crypto.ts';
import { callHealthAssistant } from '../lib/ai-provider.ts';
import { AISettingsConflictError, clearAISettings, readAISettings, saveAISettings } from './ai-settings-store.ts';
import type { AISettingsDatabase } from './ai-settings-store.ts';
import { readSiteAISettings, readSiteAISettingsOwner, resolveSiteAIConfiguration, SiteAISettingsUnavailableError } from './site-ai-settings-store.ts';

const master = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)));
const ownerKey = 'sk-synthetic-site-owner-key';
const memberKey = 'sk-synthetic-member-key';
const now = '2026-11-12T03:00:00.000Z';

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE ai_user_settings (
    user_id TEXT PRIMARY KEY NOT NULL, key_ciphertext TEXT, key_iv TEXT,
    model TEXT NOT NULL, region TEXT NOT NULL, revision INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_test_status TEXT, last_test_at TEXT);
    CREATE TABLE app_owner_identity (id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL,email TEXT NOT NULL,created_at TEXT NOT NULL);`);
  t.after(() => sqlite.close());
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let beforeRead: (() => void) | null = null;
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql); const logged = { sql, values: [] as unknown[] }; queries.push(logged);
      let values: SQLInputValue[] = [];
      const bound = {
        bind(...parameters: unknown[]) { values = parameters as SQLInputValue[]; logged.values = [...parameters]; return bound; },
        async first<T>() {
          if (/FROM ai_user_settings/.test(sql)) { const action = beforeRead; beforeRead = null; action?.(); }
          return (statement.get(...values) as T | undefined) ?? null;
        },
      };
      return bound;
    },
  } as unknown as AISettingsDatabase;
  return { sqlite, db, queries,
    bindOwner(id = 'owner') { sqlite.prepare("INSERT INTO app_owner_identity VALUES ('owner', ?, 'owner@example.test', ?)").run(id, now); },
    beforeSettingsRead(action: () => void) { beforeRead = action; },
  };
}

async function save(db: AISettingsDatabase, userId = 'owner', key = ownerKey, expectedRevision = 0) {
  return saveAISettings(db, userId, { apiKey: key, model: 'MiniMax-M3', region: 'cn', expectedRevision }, master, now);
}

async function assertUsesOwner(db: AISettingsDatabase, config: Parameters<typeof resolveSiteAIConfiguration>[1]) {
  const configuration = await resolveSiteAIConfiguration(db, config);
  assert.equal(configuration.ready, true);
  await callHealthAssistant(configuration, { question: 'Synthetic test', context: {} }, { fetch: async (_url, options) => {
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer ' + ownerKey);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] });
  } });
  for (const secret of [ownerKey, memberKey, master]) assert.ok(!JSON.stringify(configuration).includes(secret));
}

void test('explicit configured owner takes precedence and shared reads never inspect a member or establish ownership', async (t) => {
  const f = fixture(t); f.bindOwner('different-bound-owner');
  await save(f.db); await save(f.db, 'member', memberKey);
  f.queries.length = 0;
  const config = { APP_OWNER_USER_ID: ' owner ', AI_SETTINGS_ENCRYPTION_KEY: master };
  assert.equal(await readSiteAISettingsOwner(f.db, config), 'owner');
  assert.deepEqual(await readSiteAISettings(f.db, config), await readAISettings(f.db, 'owner'));
  await assertUsesOwner(f.db, config);
  assert.ok(f.queries.every((query) => !/app_owner_identity/.test(query.sql)));
  assert.ok(f.queries.every((query) => !query.values.includes('member')));
  assert.ok(f.queries.every((query) => query.sql.startsWith('SELECT')));
  assert.equal(f.sqlite.prepare("SELECT user_id FROM app_owner_identity WHERE id='owner'").get()?.user_id, 'different-bound-owner');
});

void test('an already bound owner supplies shared AI even when members have no key or have different private keys', async (t) => {
  const f = fixture(t); f.bindOwner(); await save(f.db);
  assert.equal((await readAISettings(f.db, 'member')).configured, false);
  await assertUsesOwner(f.db, { AI_SETTINGS_ENCRYPTION_KEY: master });
  await save(f.db, 'member', memberKey);
  await assertUsesOwner(f.db, { AI_SETTINGS_ENCRYPTION_KEY: master });
  assert.equal(await readSiteAISettingsOwner(f.db, {}), 'owner');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_owner_identity').get()?.n, 1);
});

void test('missing or invalid established owners fail closed without choosing the first saved key, email, or member', async (t) => {
  const f = fixture(t); await save(f.db, 'member', memberKey); f.queries.length = 0;
  for (const operation of [readSiteAISettingsOwner, readSiteAISettings, resolveSiteAIConfiguration]) {
    await assert.rejects(operation(f.db, {}), (error: unknown) => error instanceof SiteAISettingsUnavailableError && error.code === 'SITE_AI_NOT_CONFIGURED');
  }
  assert.ok(f.queries.every((query) => /WHERE id = 'owner'/.test(query.sql)));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_owner_identity').get()?.n, 0);
  f.bindOwner(' invalid ');
  await assert.rejects(readSiteAISettingsOwner(f.db, {}), SiteAISettingsUnavailableError);
  f.sqlite.prepare("UPDATE app_owner_identity SET user_id=? WHERE id='owner'").run('invalid\nidentity');
  await assert.rejects(readSiteAISettingsOwner(f.db, {}), SiteAISettingsUnavailableError);
});

void test('unconfigured or cleared owner keys return shared setup copy and never fall back to a member or environment provider key', async (t) => {
  const f = fixture(t); f.bindOwner(); await save(f.db, 'member', memberKey);
  const config = { AI_SETTINGS_ENCRYPTION_KEY: master, MINIMAX_API_KEY: memberKey };
  const empty = await resolveSiteAIConfiguration(f.db, config);
  assert.equal(empty.ready, false); assert.equal(empty.message, '全站MiniMax尚未就绪，请联系网站创建者。');
  assert.equal((await readSiteAISettings(f.db, config)).configured, false);
  await save(f.db); await clearAISettings(f.db, 'owner', 1, now);
  const cleared = await resolveSiteAIConfiguration(f.db, config, 2);
  assert.equal(cleared.ready, false); assert.equal(cleared.message, empty.message);
  assert.equal((await readSiteAISettings(f.db, config)).revision, 2);
  assert.ok(!JSON.stringify([empty, cleared]).includes(memberKey));
});

void test('shared AI keeps the original encrypted owner identity and propagates crypto failures without credential fallback', async (t) => {
  const f = fixture(t); f.bindOwner(); await save(f.db); await save(f.db, 'member', memberKey);
  await assert.rejects(resolveSiteAIConfiguration(f.db, {}), AISettingsCryptoError);
  await assert.rejects(resolveSiteAIConfiguration(f.db, { AI_SETTINGS_ENCRYPTION_KEY: 'invalid-master' }), AISettingsCryptoError);
  f.sqlite.prepare("UPDATE ai_user_settings SET key_ciphertext=(SELECT key_ciphertext FROM ai_user_settings WHERE user_id='member'), key_iv=(SELECT key_iv FROM ai_user_settings WHERE user_id='member') WHERE user_id='owner'").run();
  await assert.rejects(resolveSiteAIConfiguration(f.db, { AI_SETTINGS_ENCRYPTION_KEY: master }), AISettingsCryptoError);
});

void test('shared metadata has the existing safe structure and version changes still reject a stale resolution', async (t) => {
  const f = fixture(t); await save(f.db);
  const config = { APP_OWNER_USER_ID: 'owner', AI_SETTINGS_ENCRYPTION_KEY: master };
  const metadata = await readSiteAISettings(f.db, config);
  assert.deepEqual(Object.keys(metadata).sort(), ['configured','lastTestAt','lastTestStatus','model','region','revision','updatedAt']);
  f.beforeSettingsRead(() => f.sqlite.prepare("UPDATE ai_user_settings SET revision=revision+1 WHERE user_id='owner'").run());
  await assert.rejects(resolveSiteAIConfiguration(f.db, config, metadata.revision), AISettingsConflictError);
  await assertUsesOwner(f.db, config);
  const serialized = JSON.stringify({ metadata, queries: f.queries, rows: f.sqlite.prepare('SELECT * FROM ai_user_settings').all() });
  for (const secret of [ownerKey, memberKey, master]) assert.ok(!serialized.includes(secret));
});
