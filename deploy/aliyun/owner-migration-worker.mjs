import { createHash, generateKeyPairSync, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migrationId = 'jiashu-owner-20261116-v1';
const sourceProjectId = 'appgprj_6af116465b5c8191ab7a2b62d4645f0f';
const sourceOwnerId = 'y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap';
const targetOwnerId = 'treefund-test-owner';
const sourceOrigin = 'https://jiashu-life-os-health.jiashuh329.chatgpt.site';
const directory = '/migration', databasePath = '/data/app.sqlite3';
const phase = process.argv[2];
const digest = value => createHash('sha256').update(value).digest('hex');
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const privatePath = directory + '/private-key.pem';
async function stdinJSON(maximumBytes) {
  let raw = '';
  for await (const part of process.stdin) { raw += part; if (Buffer.byteLength(raw) > maximumBytes) throw new Error(); }
  return JSON.parse(raw);
}
const readJSON = name => JSON.parse(readFileSync(directory + '/' + name, 'utf8'));
function writeJSON(name, value) {
  const temporary = directory + '/' + name + '.next';
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, directory + '/' + name);
}
function fingerprint(publicKey) { return digest(createPublicKey(publicKey).export({ format: 'der', type: 'spki' })); }
function inventory() {
  const db = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const counts = tables.map(({ name }) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error();
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map(column => column.name);
      const ownerColumn = columns.includes('user_id') ? 'user_id' : columns.includes('owner_id') ? 'owner_id' : columns.includes('owner_user_id') ? 'owner_user_id' : null;
      const total = db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n;
      const ownerRows = ownerColumn ? db.prepare(`SELECT COUNT(*) n FROM "${name}" WHERE "${ownerColumn}"=?`).get(targetOwnerId).n : null;
      return { table: name, total, ownerRows };
    });
    const administrator = db.prepare('SELECT id,status FROM local_users WHERE id=?').get(targetOwnerId);
    if (administrator?.status !== 'active') throw new Error();
    return { tables: counts, localUserCount: db.prepare('SELECT COUNT(*) n FROM local_users').get().n };
  } finally { db.close(); }
}
async function main() {
  if (!['prepare', 'fetch-plan', 'unseal-request', 'plan-envelope', 'apply-candidate', 'verify', 'cleanup'].includes(phase)) throw new Error();
  if (process.env.APP_OWNER_USER_ID !== targetOwnerId || process.env.SELFHOST_DB_PATH !== databasePath) throw new Error();
  if (phase === 'prepare') {
    if (!existsSync(privatePath)) {
      const keys = generateKeyPairSync('rsa', { modulusLength: 3072,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      writeFileSync(privatePath, keys.privateKey, { mode: 0o600, flag: 'wx' });
      writeFileSync(directory + '/public-key.pem', keys.publicKey, { mode: 0o600, flag: 'wx' });
    }
    const publicKey = createPublicKey(readFileSync(privatePath)).export({ type: 'spki', format: 'pem' });
    output({ ok: true, phase, migrationId, sourceProjectId, sourceOwnerId, targetOwnerId,
      keyFingerprint: fingerprint(publicKey), publicKey, inventory: inventory() });
    return;
  }
  const { decryptMigrationRequest, decryptOwnerMigrationEnvelope, planOwnerMigration, buildOwnerMigrationCandidate, verifyOwnerMigration } = await import('./owner-migration-import.ts');
  if (phase === 'unseal-request') {
    // This stdout is captured only by the private SSH-to-relay pipe. The workflow
    // must never stream it to its log or persist the resulting credentials.
    const request = decryptMigrationRequest(await stdinJSON(16000), readFileSync(privatePath, 'utf8'));
    process.stdout.write(JSON.stringify(request)); return;
  }
  async function planEnvelope(envelope) {
    const snapshot = decryptOwnerMigrationEnvelope(envelope, readFileSync(privatePath, 'utf8'));
    writeJSON('source-envelope.json', envelope); writeJSON('source-snapshot.json', snapshot);
    const plan = await planOwnerMigration({ snapshot, databasePath, masterKey: process.env.AI_SETTINGS_ENCRYPTION_KEY, workDirectory: directory });
    writeJSON('plan.json', plan); output({ ok: true, phase, plan });
  }
  if (phase === 'plan-envelope') { await planEnvelope(await stdinJSON(48 * 1024 * 1024)); return; }
  if (phase === 'fetch-plan') {
    let raw = '';
    for await (const part of process.stdin) { raw += part; if (Buffer.byteLength(raw) > 16000) throw new Error(); }
    const request = decryptMigrationRequest(JSON.parse(raw), readFileSync(privatePath, 'utf8'));
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(sourceOrigin + '/_migration/owner-export', { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'OAI-Sites-Authorization': 'Bearer ' + request.sourceBearer, Authorization: 'Bearer ' + request.transferSecret, 'Content-Type': 'application/json' }, body: '{}' });
      if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json')) { output({ ok: false, phase, code: 'SOURCE_EXPORT_NOT_READY', status: response.status }); process.exitCode = 1; return; }
      const chunks = []; let size = 0;
      for await (const part of response.body) { size += part.length; if (size > 48 * 1024 * 1024) throw new Error(); chunks.push(part); }
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await planEnvelope(envelope);
    } finally { clearTimeout(timeout); }
    return;
  }
  if (phase === 'apply-candidate') {
    const expectedPlanHash = process.argv[3];
    const recovery = readJSON('backup-receipt.json');
    if (!/^[a-f0-9]{64}$/.test(expectedPlanHash ?? '') || !/^[a-f0-9]{64}$/.test(recovery.sha256 ?? '') || recovery.bytes < 1) throw new Error();
    const receipt = await buildOwnerMigrationCandidate({ snapshot: readJSON('source-snapshot.json'), databasePath,
      candidatePath: directory + '/candidate.sqlite3', masterKey: process.env.AI_SETTINGS_ENCRYPTION_KEY, workDirectory: directory, expectedPlanHash });
    writeJSON('candidate-receipt.json', receipt); output({ ok: true, phase, receipt }); return;
  }
  if (phase === 'verify') {
    const receipt = readJSON('candidate-receipt.json');
    const snapshot = existsSync(directory + '/source-snapshot.json') ? readJSON('source-snapshot.json')
      : decryptOwnerMigrationEnvelope(readJSON('source-envelope.json'), readFileSync(privatePath, 'utf8'));
    const verification = verifyOwnerMigration({ snapshot, databasePath, masterKey: process.env.AI_SETTINGS_ENCRYPTION_KEY, workDirectory: directory });
    const db = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false });
    try {
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error();
      if (db.prepare('SELECT status FROM local_users WHERE id=?').get(targetOwnerId)?.status !== 'active') throw new Error();
      output({ ok: true, phase, migrationId, receipt, verification, inventory: inventory() });
    } finally { db.close(); }
    return;
  }
  if (phase === 'cleanup') {
    // Keep the encrypted source and recovery key private on the ECS host. Only
    // plaintext staging and duplicate candidate files are removed after verify.
    for (const name of ['source-snapshot.json', 'candidate.sqlite3', 'candidate.sqlite3-wal', 'candidate.sqlite3-shm']) rmSync(directory + '/' + name, { force: true });
    output({ ok: true, phase, migrationId });
  }
}
main().catch(error => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'MIGRATION_PHASE_FAILED';
  output({ ok: false, phase, code }); process.exitCode = 1;
});
