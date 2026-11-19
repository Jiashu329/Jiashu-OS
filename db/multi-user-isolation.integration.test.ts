import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { parseSyncPayload, measurementKey } from '../lib/health.ts';
import { parseNutritionCreate } from '../lib/nutrition.ts';
import { parseNutritionTemplate, parseNutritionTemplatePreview } from '../lib/nutrition-templates.ts';
import { buildFinanceReview, parseFinanceReviewQuery } from '../lib/finance-review.ts';
import { AISettingsCryptoError, decryptAIKey } from '../lib/ai-settings-crypto.ts';
import { BACKUP_TABLE_NAMES } from '../lib/data-backup.ts';
import { readHealthRecord, readHealthRecordHistory, writeHealthRecord } from './health-records-store.ts';
import { HealthImportConflictError, previewHealthImport, writeHealthImport, listHealthImports, revertHealthImport } from './health-import-store.ts';
import { createSyncConnection, findSyncConnection, listSyncConnections, revokeSyncConnection } from './sync-connections.ts';
import { hashSyncToken } from '../app/api/sync/devices/tokens.ts';
import { NutritionConflictError, createNutritionEntry, readNutritionEntry, readNutritionHistory, readNutritionRangeSnapshot, replaceNutritionEntry } from './nutrition-store.ts';
import { createNutritionTemplate, readNutritionTemplate, previewStoredNutritionTemplate } from './nutrition-templates-store.ts';
import { readAISettings, saveAISettings, resolveUserAIConfiguration } from './ai-settings-store.ts';
import { consumeAIQuota, readAIQuota } from './ai-usage-store.ts';
import { readSiteAISettings, resolveSiteAIConfiguration } from './site-ai-settings-store.ts';
import { buildHealthAssistantContext } from '../lib/health-assistant-context.ts';
import { callHealthAssistant } from '../lib/ai-provider.ts';
import { writeWeeklyAction, readWeeklyAction } from './health-weekly-actions-store.ts';
import { writeFinanceMonthClose, readFinanceMonthCloseOperation } from './finance-month-close-store.ts';
import { BackupConflictError, exportDataBackup, previewDataRestore, restoreDataBackup } from './data-backup-store.ts';

const NOW = '2026-11-12T04:00:00.000Z';
const DAY = '2026-11-11';
const ID = '10000000-0000-4000-8000-000000000001';
const SECOND_ID = '10000000-0000-4000-8000-000000000002';
const OPERATION = '10000000-0000-4000-8000-000000000003';
const MASTER = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)));
interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ results: unknown[]; meta: { changes: number } }>;
  execute(): { results: unknown[]; meta: { changes: number } };
}
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  const db = { prepare(sql: string) {
    const query = sqlite.prepare(sql); let values: SQLInputValue[] = [];
    const statement: Statement = {
      bind(...parameters) { values = parameters as SQLInputValue[]; return statement; },
      async first<T>() { return (statement.execute().results[0] as T | undefined) ?? null; },
      async all<T>() { return { results: statement.execute().results as T[] }; },
      async run() { return statement.execute(); },
      execute() {
        const results = query.columns().length ? query.all(...values) : (query.run(...values), []);
        const changes = /^\s*(?:SELECT|WITH)\b/i.test(sql) ? 0 : Number(sqlite.prepare('SELECT changes() AS n').get()!.n);
        return { results, meta: { changes } };
      },
    }; return statement;
  }, async batch(statements: Statement[]) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  return { sqlite, db };
}
function health(value: number, source: string) {
  return parseSyncPayload({ version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt: NOW,
    measurements: [{ id: 'same-device-sample', metric: 'steps', value, unit: 'count', aggregation: 'daily', source,
      startDate: DAY + 'T00:00:00+08:00', endDate: DAY + 'T23:00:00+08:00' }] });
}
async function importFor(db: D1Database, owner: string, value: number, source: string) {
  const payload = health(value, source); const preview = await previewHealthImport(db, owner, payload);
  return writeHealthImport(db, owner, payload, null, { previewToken: preview.token, confirmSourceChanges: true }, NOW);
}
function nutrition(name: string) { return parseNutritionCreate({ date: DAY, meal: 'breakfast', name, portion: '一份', calories: '100', note: '' }, Date.parse(NOW)); }

void test('same record keys and mutation identifiers remain independent in one shared database', async (t) => {
  const { db } = fixture(t); await importFor(db, 'alice', 9123, 'alice-private-watch'); await importFor(db, 'bob', 2345, 'bob-private-watch');
  const key = measurementKey(health(1, 'unused').measurements[0]);
  for (const [owner, expected] of [['alice', 9123], ['bob', 2345]] as const) {
    const record = (await readHealthRecord(db, owner, key))!; assert.equal(record.effective.value, expected);
    await writeHealthRecord(db, owner, { action: 'correct', recordKey: key, value: expected + 1,
      expectedRevision: 0, expectedBaseExportedAt: record.base!.exportedAt, reason: owner + '-private-reason' }, OPERATION, NOW);
  }
  assert.equal((await readHealthRecord(db, 'alice', key))!.effective.value, 9124);
  assert.equal((await readHealthRecord(db, 'bob', key))!.effective.value, 2346);
  const bobHistory = JSON.stringify(await readHealthRecordHistory(db, 'bob', key));
  assert.doesNotMatch(bobHistory, /alice-private|9123|9124/);
  assert.equal(await readHealthRecord(db, 'third-user', key), null);
});

void test('preview tokens and rollback batch IDs cannot cross the authenticated owner boundary', async (t) => {
  const { db } = fixture(t); const alice = await importFor(db, 'alice', 9123, 'alice-private-watch');
  const input = health(123, 'bob-watch'); const alicePreview = await previewHealthImport(db, 'alice', input);
  const bobPreview = await previewHealthImport(db, 'bob', input);
  assert.notEqual(bobPreview.token, alicePreview.token);
  assert.equal(bobPreview.examples[0].before, null);
  assert.equal(bobPreview.examples[0].oldSource, null);
  await assert.rejects(writeHealthImport(db, 'bob', input, null, { previewToken: alicePreview.token }, NOW), HealthImportConflictError);
  await assert.rejects(revertHealthImport(db, 'bob', alice.batchId, 'forged rollback', NOW), HealthImportConflictError);
  assert.deepEqual(await listHealthImports(db, 'bob'), []);
  assert.equal((await listHealthImports(db, 'alice')).length, 1);
  assert.equal((await readHealthRecord(db, 'alice', 'steps:' + DAY))!.effective.value, 9123);
});

void test('a connection hash is usable and revocable only by its owner even on the same physical device', async (t) => {
  const { db } = fixture(t); const tokenHash = await hashSyncToken('jso_sync_' + 'a'.repeat(43));
  const device = await createSyncConnection(db, 'alice', 'Alice private iPhone', tokenHash); assert.ok(device);
  assert.equal(await findSyncConnection(db, 'bob', tokenHash), null);
  assert.deepEqual(await listSyncConnections(db, 'bob'), []);
  assert.equal(await revokeSyncConnection(db, 'bob', device), false);
  await assert.rejects(writeHealthImport(db, 'bob', health(10, 'bob-watch'), device, {}, NOW), (error) => error instanceof HealthImportConflictError && error.code === 'SYNC_DEVICE_INVALID');
  assert.equal(await findSyncConnection(db, 'alice', tokenHash), device);
  assert.equal(await revokeSyncConnection(db, 'alice', device), true);
  assert.equal(await findSyncConnection(db, 'alice', tokenHash), null);
});

void test('global nutrition UUID collisions and template previews never return another user contents', async (t) => {
  const { db } = fixture(t); await createNutritionEntry(db, 'alice', nutrition('Alice-private-food'), ID, NOW);
  await assert.rejects(createNutritionEntry(db, 'bob', nutrition('Bob-food'), ID, NOW), (error) => {
    assert.ok(error instanceof NutritionConflictError); assert.doesNotMatch(error.message, /Alice-private-food/); return true;
  });
  assert.equal(await readNutritionEntry(db, 'bob', ID), null);
  assert.equal(await readNutritionHistory(db, 'bob', ID), null);
  assert.equal(await replaceNutritionEntry(db, 'bob', ID, nutrition('forged replacement'), 1, NOW), null);
  const definition = parseNutritionTemplate({ kind: 'food', name: 'Alice-private-template', note: '', baseServings: '1', totalWeight: null,
    components: [{ name: 'Alice-private-food', portion: '一份', calories: '100' }] });
  await createNutritionTemplate(db, 'alice', definition, SECOND_ID, NOW);
  assert.equal(await readNutritionTemplate(db, 'bob', SECOND_ID), null);
  assert.equal(await previewStoredNutritionTemplate(db, 'bob', SECOND_ID,
    parseNutritionTemplatePreview({ mode: 'servings', amount: '1', date: DAY, meal: 'breakfast', expectedRevision: 1 })), null);
  await assert.rejects(createNutritionTemplate(db, 'bob', definition, SECOND_ID, NOW), NutritionConflictError);
  assert.equal((await readNutritionEntry(db, 'alice', ID))!.name, 'Alice-private-food');
});

void test('AI configuration and encrypted credentials are owner bound and quota counters are independent', async (t) => {
  const { db, sqlite } = fixture(t);
  await saveAISettings(db, 'alice', { apiKey: 'sk-synthetic-alice-private', model: 'MiniMax-M3', region: 'cn', expectedRevision: 0 }, MASTER, NOW);
  assert.equal((await resolveUserAIConfiguration(db, 'bob', MASTER)).ready, false);
  assert.equal((await readAISettings(db, 'bob')).configured, false);
  await saveAISettings(db, 'bob', { apiKey: 'sk-synthetic-bob-private', model: 'MiniMax-M3', region: 'global', expectedRevision: 0 }, MASTER, NOW);
  const cipher = sqlite.prepare('SELECT key_ciphertext AS ciphertext,key_iv AS iv FROM ai_user_settings WHERE user_id=?').get('alice') as { ciphertext: string; iv: string };
  assert.equal(await decryptAIKey(MASTER, 'alice', cipher), 'sk-synthetic-alice-private');
  await assert.rejects(decryptAIKey(MASTER, 'bob', cipher), AISettingsCryptoError);
  for (let i = 0; i < 3; i++) assert.equal((await consumeAIQuota(db, 'alice', Date.parse(NOW))).allowed, true);
  assert.equal((await consumeAIQuota(db, 'alice', Date.parse(NOW))).allowed, false);
  assert.equal((await readAIQuota(db, 'bob', Date.parse(NOW))).remainingToday, 20);
  assert.equal((await consumeAIQuota(db, 'bob', Date.parse(NOW))).allowed, true);
  assert.doesNotMatch(JSON.stringify(await readAISettings(db, 'bob')), /sk-synthetic|ciphertext|keyIv/);
});

void test('shared MiniMax uses the bound creator key while each actor sends only their own nutrition and consumes their own quota', async (t) => {
  const { db, sqlite } = fixture(t);
  sqlite.prepare("INSERT INTO app_owner_identity (id,user_id,email,created_at) VALUES ('owner',?,?,?)").run('alice', 'creator@example.invalid', NOW);
  const runtime = { AI_SETTINGS_ENCRYPTION_KEY: MASTER };
  const sharedKey = 'sk-synthetic-shared-creator-private';
  await saveAISettings(db, 'alice', { apiKey: sharedKey, model: 'MiniMax-M3', region: 'cn', expectedRevision: 0 }, MASTER, NOW);
  // An older personal configuration must not override the creator's service.
  await saveAISettings(db, 'bob', { apiKey: 'sk-synthetic-ignored-member-private', model: 'MiniMax-M2.7', region: 'global', expectedRevision: 0 }, MASTER, NOW);
  await createNutritionEntry(db, 'alice', { ...nutrition('Alice-private-food'), caloriesTenth: 3210 }, ID, NOW);
  await createNutritionEntry(db, 'bob', { ...nutrition('Bob-private-food'), caloriesTenth: 7770 }, SECOND_ID, NOW);
  const outgoing: Array<{ authorization: string | null; body: string }> = [];
  for (const actor of ['alice', 'bob']) {
    const settings = await readSiteAISettings(db, runtime);
    const configuration = await resolveSiteAIConfiguration(db, runtime, settings.revision);
    const snapshot = await readNutritionRangeSnapshot(db, actor, { from: DAY, to: DAY });
    const selected = buildHealthAssistantContext({ measurements: [], nutrition: snapshot.entries, nutritionStatuses: snapshot.statuses,
      days: 1, from: DAY, to: DAY, now: Date.parse(NOW) });
    assert.equal((await consumeAIQuota(db, actor, Date.parse(NOW))).allowed, true);
    await callHealthAssistant(configuration, { question: '合成测试问题', context: selected.context }, { fetch: async (_url, options) => {
      outgoing.push({ authorization: new Headers(options?.headers).get('Authorization'), body: String(options?.body) });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '合成测试回答' } }] });
    } });
  }
  assert.deepEqual(outgoing.map((item) => item.authorization), ['Bearer ' + sharedKey, 'Bearer ' + sharedKey]);
  assert.match(outgoing[0].body, /321\.0/); assert.doesNotMatch(outgoing[0].body, /777\.0|Bob-private|ignored-member/);
  assert.match(outgoing[1].body, /777\.0/); assert.doesNotMatch(outgoing[1].body, /321\.0|Alice-private|shared-creator/);
  assert.equal((await readAIQuota(db, 'alice', Date.parse(NOW))).remainingToday, 19);
  assert.equal((await readAIQuota(db, 'bob', Date.parse(NOW))).remainingToday, 19);
  assert.equal((await readAIQuota(db, 'third-user', Date.parse(NOW))).remainingToday, 20);
  assert.doesNotMatch(JSON.stringify(await readSiteAISettings(db, runtime)), /sk-synthetic|ciphertext|keyIv|alice|bob/);
});

void test('weekly actions and identical month-close operation IDs belong to independent user scopes', async (t) => {
  const { db } = fixture(t);
  for (const owner of ['alice', 'bob']) {
    await writeWeeklyAction(db, owner, { weekStart: '2026-11-09', text: owner + '-private-action', status: 'planned', feedback: '', expectedRevision: 0 }, NOW);
    const report = buildFinanceReview([], [], parseFinanceReviewQuery(new URLSearchParams({ ledger: 'personal', currency: 'CNY', month: '2026-10' }), Date.parse(NOW)));
    await writeFinanceMonthClose(db, owner, { report, expectedVersion: 0, operationId: OPERATION, requestHash: 'a'.repeat(64), reason: owner + '-private-close' }, NOW);
  }
  assert.equal((await readWeeklyAction(db, 'alice', '2026-11-09'))!.text, 'alice-private-action');
  assert.equal((await readWeeklyAction(db, 'bob', '2026-11-09'))!.text, 'bob-private-action');
  assert.equal((await readFinanceMonthCloseOperation(db, 'bob', OPERATION))!.reason, 'bob-private-close');
  assert.equal(await readFinanceMonthCloseOperation(db, 'third-user', OPERATION), null);
});

void test('complete backups expose only their owner and foreign global-ID previews reveal no stored content', async (t) => {
  const { db, sqlite } = fixture(t); await importFor(db, 'alice', 9123, 'Alice-private-watch'); await importFor(db, 'bob', 2345, 'Bob-private-watch');
  await createNutritionEntry(db, 'alice', nutrition('Alice-private-food'), ID, NOW);
  await createNutritionEntry(db, 'bob', nutrition('Bob-private-food'), SECOND_ID, NOW);
  for (const [owner, label] of [['alice', 'Alice'], ['bob', 'Bob']] as const) {
    sqlite.prepare(`INSERT INTO douban_items
      (user_id,profile_id,domain,subject_id,kind,title,url,rating,marked_date,comment,source,observed_at,created_at,updated_at)
      VALUES (?,'same-profile','book','1000000','book',?,'https://book.douban.com/subject/1000000/',5,?,?,'import',?,?,?)`)
      .run(owner, label + '-private-douban', DAY, label + '-private-douban-comment', NOW, NOW, NOW);
  }
  await saveAISettings(db, 'alice', { apiKey: 'sk-synthetic-alice-private', model: 'MiniMax-M3', region: 'cn', expectedRevision: 0 }, MASTER, NOW);
  const alice = await exportDataBackup(db, 'alice', NOW); const bob = await exportDataBackup(db, 'bob', NOW);
  assert.equal(Object.keys(bob.tables).length, 34); assert.equal(BACKUP_TABLE_NAMES.length, 34);
  for (const [backup, label] of [[alice, 'Alice'], [bob, 'Bob']] as const) {
    assert.deepEqual(Object.keys(backup.tables).sort(), [...BACKUP_TABLE_NAMES].sort());
    assert.equal(backup.tables.douban_items.length, 1);
    assert.equal(backup.tables.douban_items[0].title, label + '-private-douban');
    assert.equal(backup.tables.douban_items[0].comment, label + '-private-douban-comment');
    for (const excluded of ['douban_connections', 'douban_sync_runs', 'douban_import_receipts']) {
      assert.equal(Object.hasOwn(backup.tables, excluded), false);
    }
  }
  assert.doesNotMatch(JSON.stringify(bob), /Alice-private|sk-synthetic|key_ciphertext|token_hash/);
  assert.doesNotMatch(JSON.stringify(alice), /Bob-private|sk-synthetic|key_ciphertext|token_hash/);
  const forged = structuredClone(bob); const oldId = String(forged.tables.nutrition_entries[0].id);
  forged.tables.nutrition_entries[0].id = ID;
  for (const row of forged.tables.nutrition_entry_history) if (row.entry_id === oldId) row.entry_id = ID;
  // The file is attacker supplied. Rebind its own historical snapshots too;
  // any private values in the resulting preview must therefore come from DB.
  for (const row of forged.tables.nutrition_entry_history) for (const column of ['before_json', 'after_json']) if (typeof row[column] === 'string') {
    const snapshot = JSON.parse(String(row[column])); snapshot.id = ID; row[column] = JSON.stringify(snapshot);
  }
  const preview = await previewDataRestore(db, 'bob', forged);
  assert.equal(preview.canRestore, false);
  assert.doesNotMatch(JSON.stringify(preview), /Alice-private|9123|sk-synthetic/);
  await assert.rejects(restoreDataBackup(db, 'bob', forged, preview.previewHash), BackupConflictError);
  assert.deepEqual(await exportDataBackup(db, 'alice', NOW), alice);
  assert.deepEqual(await exportDataBackup(db, 'bob', NOW), bob);
});
