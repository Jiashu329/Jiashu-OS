import assert from 'node:assert/strict';
import { createCipheriv, createHash, createPublicKey, generateKeyPairSync, publicEncrypt, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { migrateDatabase } from './migrations.ts';
import { decryptAIKey, encryptAIKey } from '../lib/ai-settings-crypto.ts';
import { decryptTMDBToken, encryptTMDBToken } from '../lib/tmdb-settings-crypto.ts';
import { buildOwnerMigrationCandidate, decryptMigrationRequest, decryptOwnerMigrationEnvelope, planOwnerMigration, verifyOwnerMigration } from './owner-migration-import.ts';

const SOURCE = 'y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap';
const TARGET = 'treefund-test-owner', OTHER = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-11-16T08:00:00.000Z', HASH = 'e'.repeat(64);
const MASTER = Buffer.alloc(32, 3).toString('base64'), OLD_MASTER = Buffer.alloc(32, 4).toString('base64');
const keys = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const fingerprint = createHash('sha256').update(createPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
const header = { format: 'jiashu-owner-migration-v1', migrationId: 'jiashu-owner-20261116-v1', sourceProjectId: 'appgprj_6af116465b5c8191ab7a2b62d4645f0f', sourceOwnerId: SOURCE, targetOwnerId: TARGET, keyFingerprint: fingerprint };
type Cell = string | number | null;
type Row = Record<string, Cell>;
interface Table { name: string; columns: string[]; rows: Row[]; sha256: string }
interface Payload { header: typeof header; exportedAt: string; tables: Table[]; secrets: { aiKey: string | null; tmdbToken: string | null } }

function table(name: string, input: Row[]): Table {
  assert.ok(input.length);
  const columns = Object.keys(input[0]).sort();
  const rows = input.map(row => Object.fromEntries(columns.map(column => [column, row[column]])) as Row)
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  const value = { name, columns, rows };
  return { ...value, sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}
function payload(tables: Table[], secrets: Payload['secrets'] = { aiKey: null, tmdbToken: null }): Payload {
  return { header: { ...header }, exportedAt: new Date().toISOString(), tables: [...tables].sort((a, b) => a.name < b.name ? -1 : 1), secrets };
}
function sealRaw(value: unknown, envelopeHeader: Record<string, string>) {
  const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(envelopeHeader)));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return { header: envelopeHeader, wrappedKey: publicEncrypt({ key: keys.publicKey, oaepHash: 'sha256' }, key).toString('base64'), iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function seal(value: Payload, envelopeHeader = value.header) { return sealRaw(value, envelopeHeader); }
const snapshot = (value: Payload) => decryptOwnerMigrationEnvelope(seal(value), keys.privateKey);
const measurement = (userId: string, recordKey = 'source-record', content = 'private fixture content'): Row => ({ user_id: userId, record_key: recordKey, metric: 'steps', day: '2026-11-15', measurement_json: JSON.stringify({ count: 4000, note: content }), exported_at: NOW, received_at: NOW });
const query = (db: DatabaseSync, sql: string) => db.prepare(sql).all().map(row => ({ ...row }));

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'owner-migration-import-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'target.sqlite3'), sourcePath = join(directory, 'source.sqlite3');
  await migrateDatabase({ path: databasePath, directory: resolve('drizzle') });
  await migrateDatabase({ path: sourcePath, directory: resolve('drizzle') });
  const target = new DatabaseSync(databasePath), source = new DatabaseSync(sourcePath);
  t.after(() => { target.close(); source.close(); });
  const user = target.prepare('INSERT INTO local_users(id,email,password_hash,status,revision,created_at,updated_at) VALUES(?,?,?,\'active\',1,?,?)');
  user.run(TARGET, 'admin@treefund.asia', 'existing-target-password-hash', NOW, NOW);
  user.run(OTHER, 'other@example.test', 'existing-other-password-hash', NOW, NOW);
  target.prepare('INSERT INTO app_owner_identity(id,user_id,email,created_at) VALUES(\'owner\',?,?,?)').run(TARGET, 'admin@treefund.asia', NOW);
  target.prepare('INSERT INTO health_measurements VALUES(?,?,?,?,?,?,?)').run(...Object.values(measurement(OTHER, 'other-record', 'other user untouched')));
  const auth = query(target, 'SELECT * FROM local_users ORDER BY id'), ledger = query(target, 'SELECT * FROM _selfhost_migrations ORDER BY idx');
  const options = (value: Payload, path = databasePath) => ({ snapshot: snapshot(value), databasePath: path, masterKey: MASTER, workDirectory: directory });
  const selected = (name: string) => table(name, query(source, `SELECT * FROM "${name}"`) as Row[]);
  return { directory, databasePath, sourcePath, target, source, auth, ledger, options, selected };
}

void test('credential request envelopes are destination bound and cannot be confused with data exports', () => {
  const request = { sourceBearer: 'synthetic-private-site-bearer-token', transferSecret: 's'.repeat(43) };
  const requestHeader = { ...header, format: 'jiashu-migration-request-v1' };
  const encrypted = sealRaw(request, requestHeader);
  assert.deepEqual(decryptMigrationRequest(encrypted, keys.privateKey), request);
  assert.throws(() => decryptOwnerMigrationEnvelope(encrypted, keys.privateKey));
  assert.throws(() => decryptMigrationRequest(seal(payload([])), keys.privateKey));
  assert.throws(() => decryptMigrationRequest(sealRaw({ ...request, transferSecret: 'invalid\nsecret' }, requestHeader), keys.privateKey));
  assert.throws(() => decryptMigrationRequest(sealRaw({ ...request, extra: true }, requestHeader), keys.privateKey));
});

void test('sealed export binds destination key, all header fields, AES-GCM authentication and source table hashes', async t => {
  const f = await fixture(t), value = payload([table('health_measurements', [measurement(SOURCE)])]);
  assert.equal(snapshot(value).tables[0].rows.length, 1);
  const tampered = seal(value); const alteredCiphertext = Buffer.from(tampered.ciphertext, 'base64'); alteredCiphertext[4] ^= 1; tampered.ciphertext = alteredCiphertext.toString('base64');
  assert.throws(() => decryptOwnerMigrationEnvelope(tampered, keys.privateKey));
  assert.throws(() => decryptOwnerMigrationEnvelope({ ...seal(value), header: { ...header, targetOwnerId: OTHER } }, keys.privateKey));
  const wrongKey = generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  assert.throws(() => decryptOwnerMigrationEnvelope(seal(value), wrongKey.privateKey));
  const badDigest = structuredClone(value); badDigest.tables[0].sha256 = '0'.repeat(64);
  await assert.rejects(async () => planOwnerMigration(f.options(badDigest)));
  assert.equal(query(f.target, 'SELECT COUNT(*) n FROM health_measurements')[0].n, 1);
});

void test('other-owner records, auth tables and unknown columns are rejected before importing anything', async t => {
  const f = await fixture(t);
  for (const value of [
    payload([table('health_measurements', [measurement(OTHER)])]),
    payload([table('local_users', [{ id: TARGET, email: 'attacker@example.test' }])]),
    payload([table('health_measurements', [{ ...measurement(SOURCE), unexpected_private_column: 'invalid' }])]),
  ]) await assert.rejects(async () => planOwnerMigration(f.options(value)));
  assert.deepEqual(query(f.target, 'SELECT * FROM local_users ORDER BY id'), f.auth);
});

void test('candidate imports only source owner, preserves other target users and authentication ledger, and is repeatable', async t => {
  const f = await fixture(t), value = payload([table('health_measurements', [measurement(SOURCE)])]), options = f.options(value);
  const before = readFileSync(f.databasePath), plan = await planOwnerMigration(options);
  assert.equal(plan.canApply, true); assert.match(plan.planHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(plan.tables.map(row => [row.name, row.sourceRows, row.insert, row.skip]), [['health_measurements', 1, 1, 0]]);
  assert.doesNotMatch(JSON.stringify(plan), /private fixture content|existing-target-password-hash|measurement_json/);
  assert.deepEqual(readFileSync(f.databasePath), before, 'Dry run leaves target database bytes unchanged.');
  const candidatePath = join(f.directory, 'candidate.sqlite3');
  const receipt = await buildOwnerMigrationCandidate({ ...options, candidatePath, expectedPlanHash: plan.planHash });
  assert.equal(receipt.verified, true); assert.equal(receipt.planHash, plan.planHash);
  assert.equal(statSync(candidatePath).mode & 0o777, 0o600);
  const candidate = new DatabaseSync(candidatePath); t.after(() => candidate.close());
  assert.deepEqual(query(candidate, 'SELECT * FROM local_users ORDER BY id'), f.auth);
  assert.deepEqual(query(candidate, 'SELECT * FROM _selfhost_migrations ORDER BY idx'), f.ledger);
  assert.equal(query(candidate, "SELECT COUNT(*) n FROM health_measurements WHERE user_id='" + TARGET + "'")[0].n, 1);
  assert.equal(query(candidate, "SELECT COUNT(*) n FROM health_measurements WHERE user_id='" + SOURCE + "'")[0].n, 0);
  assert.equal(query(candidate, "SELECT measurement_json FROM health_measurements WHERE user_id='" + OTHER + "'")[0].measurement_json, JSON.stringify({ count: 4000, note: 'other user untouched' }));
  assert.equal(query(candidate, 'PRAGMA integrity_check')[0].integrity_check, 'ok');
  assert.deepEqual(query(candidate, 'PRAGMA foreign_key_check'), []);
  const again = await planOwnerMigration({ ...options, databasePath: candidatePath });
  assert.equal(again.canApply, true); assert.equal(again.tables[0].insert, 0); assert.equal(again.tables[0].skip, 1);
  const verified = verifyOwnerMigration({ ...options, databasePath: candidatePath });
  assert.equal(verified.verified, true); assert.deepEqual(verified.tables, receipt.tableHashes);
  candidate.prepare('UPDATE health_measurements SET measurement_json=\'{}\' WHERE user_id=?').run(TARGET);
  assert.throws(() => verifyOwnerMigration({ ...options, databasePath: candidatePath }));
  assert.deepEqual(readFileSync(f.databasePath), before, 'Candidate construction never writes source target file.');
});

void test('conflicting content blocks apply without overwriting records and changed target invalidates a reviewed plan', async t => {
  const f = await fixture(t), value = payload([table('health_measurements', [measurement(SOURCE)])]);
  f.target.prepare('INSERT INTO health_measurements VALUES(?,?,?,?,?,?,?)').run(...Object.values(measurement(TARGET, 'source-record', 'new target content')));
  const options = f.options(value), plan = await planOwnerMigration(options);
  assert.equal(plan.canApply, false); assert.ok(plan.conflicts.length > 0);
  assert.doesNotMatch(JSON.stringify(plan), /new target content|private fixture content/);
  const candidatePath = join(f.directory, 'conflict.sqlite3');
  await assert.rejects(buildOwnerMigrationCandidate({ ...options, candidatePath, expectedPlanHash: plan.planHash }));
  assert.equal(existsSync(candidatePath), false);
  f.target.prepare('DELETE FROM health_measurements WHERE user_id=?').run(TARGET);
  const reviewed = await planOwnerMigration(options);
  f.target.prepare('UPDATE local_users SET revision=revision+1 WHERE id=?').run(TARGET);
  await assert.rejects(buildOwnerMigrationCandidate({ ...options, candidatePath, expectedPlanHash: reviewed.planHash }));
  assert.equal(existsSync(candidatePath), false);
});

void test('raw nutrition import preserves captured history and completed-day revision while restoring mutation triggers', async t => {
  const f = await fixture(t);
  f.source.prepare('INSERT INTO nutrition_entries(id,user_id,date,meal,name,portion,note,calories_tenth,creation_hash,revision,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('22222222-2222-4222-8222-222222222222', SOURCE, '2026-11-15', 'breakfast', 'synthetic oats', 'one bowl', '', 1234, HASH, 3, NOW, NOW, null);
  f.source.prepare('UPDATE nutrition_day_status SET complete=1,revision=27,meals_json=? WHERE user_id=?').run('{"breakfast":true}', SOURCE);
  f.source.prepare('UPDATE nutrition_entry_history SET action=\'baseline\',after_json=? WHERE user_id=?').run('{"history":"preserve exactly"}', SOURCE);
  const value = payload(['nutrition_entries', 'nutrition_entry_history', 'nutrition_day_status'].map(f.selected));
  const options = f.options(value), plan = await planOwnerMigration(options), candidatePath = join(f.directory, 'nutrition.sqlite3');
  await buildOwnerMigrationCandidate({ ...options, candidatePath, expectedPlanHash: plan.planHash });
  const candidate = new DatabaseSync(candidatePath); t.after(() => candidate.close());
  const day = query(candidate, 'SELECT * FROM nutrition_day_status')[0];
  assert.equal(day.user_id, TARGET); assert.equal(day.complete, 1); assert.equal(day.revision, 27); assert.equal(day.meals_json, '{"breakfast":true}');
  assert.equal(query(candidate, 'SELECT COUNT(*) n FROM nutrition_entry_history')[0].n, 1);
  assert.equal(query(candidate, 'SELECT after_json FROM nutrition_entry_history')[0].after_json, '{"history":"preserve exactly"}');
  const triggers = query(candidate, "SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name");
  assert.deepEqual(triggers, query(f.target, "SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name"));
  candidate.prepare('UPDATE nutrition_entries SET note=\'updated\',revision=revision+1 WHERE user_id=?').run(TARGET);
  assert.equal(query(candidate, 'SELECT revision FROM nutrition_day_status')[0].revision, 28);
  assert.equal(query(candidate, 'SELECT COUNT(*) n FROM nutrition_entry_history')[0].n, 2);
});

void test('AI and TMDB credentials are rebound to target master and owner without revealing secrets in plans', async t => {
  const f = await fixture(t), aiKey = 'synthetic-owner-private-ai-key', tmdbToken = 'synthetic-owner-private-tmdb-token';
  const ai = await encryptAIKey(OLD_MASTER, SOURCE, aiKey), tmdb = await encryptTMDBToken(OLD_MASTER, SOURCE, tmdbToken);
  f.source.prepare('INSERT INTO ai_user_settings(user_id,key_ciphertext,key_iv,model,region,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(SOURCE, ai.ciphertext, ai.iv, 'MiniMax-M2.1', 'china', 8, NOW, NOW);
  f.source.prepare('INSERT INTO tmdb_settings(owner_id,token_ciphertext,token_iv,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(SOURCE, tmdb.ciphertext, tmdb.iv, 5, NOW, NOW);
  const value = payload(['ai_user_settings', 'tmdb_settings'].map(f.selected), { aiKey, tmdbToken });
  const options = f.options(value), plan = await planOwnerMigration(options), candidatePath = join(f.directory, 'settings.sqlite3');
  assert.doesNotMatch(JSON.stringify(plan), /synthetic-owner-private|key_ciphertext|token_ciphertext/);
  const receipt = await buildOwnerMigrationCandidate({ ...options, candidatePath, expectedPlanHash: plan.planHash });
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic-owner-private/);
  const candidate = new DatabaseSync(candidatePath); t.after(() => candidate.close());
  const migratedAI = query(candidate, 'SELECT * FROM ai_user_settings')[0], migratedTMDB = query(candidate, 'SELECT * FROM tmdb_settings')[0];
  assert.notEqual(migratedAI.key_ciphertext, ai.ciphertext); assert.notEqual(migratedTMDB.token_ciphertext, tmdb.ciphertext);
  assert.equal(await decryptAIKey(MASTER, TARGET, { ciphertext: String(migratedAI.key_ciphertext), iv: String(migratedAI.key_iv) }), aiKey);
  assert.equal(await decryptTMDBToken(MASTER, TARGET, { ciphertext: String(migratedTMDB.token_ciphertext), iv: String(migratedTMDB.token_iv) }), tmdbToken);
  await assert.rejects(decryptAIKey(OLD_MASTER, SOURCE, { ciphertext: String(migratedAI.key_ciphertext), iv: String(migratedAI.key_iv) }));
  const again = await planOwnerMigration({ ...options, databasePath: candidatePath });
  assert.equal(again.canApply, true); assert.equal(again.tables.reduce((sum, row) => sum + row.skip, 0), 2);
  const changedSecrets = payload(value.tables, { aiKey: 'different-synthetic-private-ai-key', tmdbToken });
  const changedOptions = f.options(changedSecrets), changedPlan = await planOwnerMigration(changedOptions);
  assert.notEqual(changedPlan.sourceDigest, plan.sourceDigest); assert.notEqual(changedPlan.planHash, plan.planHash);
  const unexpectedPath = join(f.directory, 'changed-secret.sqlite3');
  await assert.rejects(buildOwnerMigrationCandidate({ ...changedOptions, candidatePath: unexpectedPath, expectedPlanHash: plan.planHash }));
  assert.equal(existsSync(unexpectedPath), false, 'A reviewed plan cannot be reused for changed credential plaintext.');
});

void test('finance business IDs survive global sequence collisions and opaque request hashes remain untouched', async t => {
  const f = await fixture(t);
  f.target.prepare('INSERT INTO finance_balance_entries(sequence,id,user_id,account_id,amount_minor,as_of_date,note,created_at) VALUES(?,?,?,?,?,?,?,?)').run(20, 'other-entry', OTHER, 'other-account', '10', '2026-11-15', '', NOW);
  f.source.prepare('INSERT INTO finance_balance_entries(sequence,id,user_id,account_id,amount_minor,as_of_date,note,created_at) VALUES(?,?,?,?,?,?,?,?)').run(20, 'owner-entry', SOURCE, 'owner-account', '9007199254740993', '2026-11-15', 'source history', NOW);
  f.source.prepare('INSERT INTO finance_balance_changes(sequence,id,user_id,account_id,entry_id,revision,action,amount_minor,as_of_date,note,reason,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(20, 'owner-correction', SOURCE, 'owner-account', 'owner-entry', 1, 'correct', '12', '2026-11-15', '', 'source correction', HASH, NOW);
  const value = payload(['finance_balance_entries', 'finance_balance_changes'].map(f.selected));
  const options = f.options(value), plan = await planOwnerMigration(options), candidatePath = join(f.directory, 'finance.sqlite3');
  assert.equal(plan.canApply, true); assert.ok(plan.tables.some(row => row.sequenceRemaps > 0));
  await buildOwnerMigrationCandidate({ ...options, candidatePath, expectedPlanHash: plan.planHash });
  const candidate = new DatabaseSync(candidatePath); t.after(() => candidate.close());
  assert.equal(query(candidate, "SELECT amount_minor FROM finance_balance_entries WHERE id='other-entry'")[0].amount_minor, '10');
  const entry = query(candidate, "SELECT * FROM finance_balance_entries WHERE id='owner-entry'")[0];
  assert.equal(entry.user_id, TARGET); assert.equal(entry.amount_minor, '9007199254740993'); assert.notEqual(entry.sequence, 20);
  assert.equal(query(candidate, 'SELECT request_hash FROM finance_balance_changes')[0].request_hash, HASH);
  const again = await planOwnerMigration({ ...options, databasePath: candidatePath });
  assert.equal(again.canApply, true); assert.equal(again.tables.reduce((sum, row) => sum + row.insert, 0), 0);
});

void test('family relationships must belong to exported owner books and preserve unrelated historical actor identity', async t => {
  const f = await fixture(t);
  f.source.prepare('INSERT INTO family_books(id,owner_user_id,owner_email,owner_name,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('owner-book', SOURCE, 'owner@example.test', 'Owner', 'Family', NOW, NOW);
  f.source.prepare('INSERT INTO family_book_activity(id,book_id,actor_user_id,actor_name,action,target_id,target_name,created_at) VALUES(?,?,?,?,?,?,?,?)').run('activity', 'owner-book', 'old-shared-member', 'Member', 'created', null, null, NOW);
  const value = payload(['family_books', 'family_book_activity'].map(f.selected)), options = f.options(value);
  const plan = await planOwnerMigration(options), candidatePath = join(f.directory, 'family.sqlite3');
  assert.equal(plan.canApply, true);
  await buildOwnerMigrationCandidate({ ...options, candidatePath, expectedPlanHash: plan.planHash });
  const candidate = new DatabaseSync(candidatePath); t.after(() => candidate.close());
  assert.equal(query(candidate, 'SELECT owner_user_id FROM family_books')[0].owner_user_id, TARGET);
  assert.equal(query(candidate, 'SELECT actor_user_id FROM family_book_activity')[0].actor_user_id, 'old-shared-member');
  assert.equal(query(candidate, 'SELECT COUNT(*) n FROM app_access_grants')[0].n, 0);
  const invalid = payload([table('family_book_activity', [{ id: 'outsider', book_id: 'other-book', actor_user_id: SOURCE, actor_name: 'Owner', action: 'created', target_id: null, target_name: null, created_at: NOW }])]);
  await assert.rejects(async () => planOwnerMigration(f.options(invalid)));
});
