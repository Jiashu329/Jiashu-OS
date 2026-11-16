import { constants, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, privateDecrypt, randomBytes, createCipheriv } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

/** This administration-only module never prints or persists a plaintext export. */
export const migrationIdentity = Object.freeze({
  migrationId: 'jiashu-owner-20261116-v1',
  sourceProjectId: 'appgprj_6af116465b5c8191ab7a2b62d4645f0f',
  sourceOwnerId: 'y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap',
  targetOwnerId: 'treefund-test-owner',
});
type Cell = string | number | null;
type Row = Record<string, Cell>;
export interface OwnerMigrationHeader {
  format: 'jiashu-owner-migration-v1'; migrationId: string; sourceProjectId: string;
  sourceOwnerId: string; targetOwnerId: string; keyFingerprint: string;
}
export interface OwnerMigrationTable { name: string; columns: string[]; rows: Row[]; sha256: string }
export interface OwnerSnapshot { header: OwnerMigrationHeader; exportedAt: string; tables: OwnerMigrationTable[]; secrets: { aiKey: string | null; tmdbToken: string | null } }
export interface OwnerMigrationTablePlan { name: string; sourceRows: number; insert: number; skip: number; conflicts: number; sequenceRemaps: number }
export interface OwnerMigrationConflict { table: string; kind: string; count: number }
export interface OwnerMigrationPlan {
  migrationId: string; sourceDigest: string; targetFingerprint: string; tables: OwnerMigrationTablePlan[];
  conflicts: OwnerMigrationConflict[]; canApply: boolean; planHash: string;
}
export interface OwnerMigrationReceipt {
  migrationId: string; planHash: string; sourceDigest: string; targetBefore: string; targetAfter: string;
  tables: OwnerMigrationTablePlan[]; tableHashes: { name: string; rows: number; sha256: string }[]; verified: true;
}
export interface OwnerMigrationVerification { migrationId: string; sourceDigest: string; targetFingerprint: string; tables: { name: string; rows: number; sha256: string }[]; verified: true }
export interface OwnerMigrationOptions { snapshot: OwnerSnapshot; databasePath: string; masterKey: string; workDirectory: string }
export class OwnerMigrationError extends Error {
  readonly code: string;
  constructor(code: string) { super('Owner data migration could not be validated (' + code + ').'); this.name = 'OwnerMigrationError'; this.code = code; }
}
const fail = (code: string): never => { throw new OwnerMigrationError(code); };
const MAX_BYTES = 64 * 1024 * 1024, MAX_ROWS = 500_000;
const userTables = new Set([
  'health_measurements', 'health_syncs', 'health_import_batches', 'health_sync_attempts', 'sync_devices',
  'health_goal_settings', 'health_goal_versions', 'finance_accounts', 'finance_account_classifications',
  'finance_balance_entries', 'finance_balance_changes', 'finance_goal_plans', 'finance_runway_settings',
  'health_weight_plan_settings', 'health_weight_plan_cycles', 'health_weight_plan_operations', 'health_record_overrides',
  'health_record_changes', 'nutrition_entries', 'nutrition_goal_settings', 'nutrition_entry_history', 'nutrition_restore_operations',
  'nutrition_copy_operations', 'ai_usage_limits', 'ai_user_settings', 'nutrition_batches', 'nutrition_favorites',
  'nutrition_templates', 'nutrition_template_operations', 'nutrition_day_status', 'health_sync_diagnostics',
  'health_weekly_actions', 'finance_month_closes', 'notification_read_states', 'notification_preferences',
  'douban_connections', 'douban_items', 'douban_sync_runs', 'douban_import_receipts', 'douban_data_resets', 'douban_imdb_ratings_receipts',
]);
const familyTables = new Set(['family_book_members', 'family_book_member_operations', 'family_finance_commands', 'family_book_activity']);
const allowedTables = new Set([...userTables, ...familyTables, 'family_books', 'managed_foods', 'managed_food_versions', 'managed_food_operations', 'tmdb_settings']);
const identityColumns = new Set(['user_id', 'owner_id', 'owner_user_id', 'actor_user_id', 'created_by', 'bound_user_id']);
const sequencedTables = new Set(['finance_balance_entries', 'finance_balance_changes']);
const cryptoColumns: Record<string, [string, string]> = { ai_user_settings: ['key_ciphertext', 'key_iv'], tmdb_settings: ['token_ciphertext', 'token_iv'] };
const lex = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const quote = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';
const validIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('INVALID_FORMAT');
  return value as Record<string, unknown>;
}
function exact(value: unknown, names: string[]): Record<string, unknown> {
  const record = object(value);
  if (Object.keys(record).sort().join(',') !== names.slice().sort().join(',')) return fail('INVALID_FORMAT');
  return record;
}
function base64(value: unknown, maximum: number, size?: number): Buffer {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maximum / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return fail('INVALID_ENVELOPE');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > maximum || decoded.toString('base64') !== value || size !== undefined && decoded.length !== size) return fail('INVALID_ENVELOPE');
  return decoded;
}
function header(value: unknown, fingerprint: string, format: string): Record<string, unknown> {
  const input = exact(value, ['format', 'migrationId', 'sourceProjectId', 'sourceOwnerId', 'targetOwnerId', 'keyFingerprint']);
  const expected = { format, ...migrationIdentity, keyFingerprint: fingerprint };
  // Ordered canonical header bytes form the GCM associated data.
  if (JSON.stringify(input) !== JSON.stringify(expected)) return fail('HEADER_MISMATCH');
  return expected;
}
function decryptEnvelope(value: unknown, privateKeyPem: string, format: string): unknown {
  try {
    const envelope = exact(value, ['header', 'wrappedKey', 'iv', 'ciphertext']);
    const privateKey = createPrivateKey(privateKeyPem), publicKey = createPublicKey(privateKey);
    const bits = publicKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (publicKey.asymmetricKeyType !== 'rsa' || bits < 3072 || bits > 4096) return fail('INVALID_KEY');
    const fingerprint = digest(publicKey.export({ format: 'der', type: 'spki' }));
    const claims = header(envelope.header, fingerprint, format);
    const wrapped = base64(envelope.wrappedKey, bits / 8, bits / 8), iv = base64(envelope.iv, 12, 12);
    const encrypted = base64(envelope.ciphertext, MAX_BYTES + 16);
    if (encrypted.length < 17) return fail('INVALID_ENVELOPE');
    const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrapped);
    if (key.length !== 32) return fail('INVALID_ENVELOPE');
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(claims))); cipher.setAuthTag(encrypted.subarray(-16));
    const plaintext = Buffer.concat([cipher.update(encrypted.subarray(0, -16)), cipher.final()]);
    key.fill(0);
    try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(plaintext)); }
    finally { plaintext.fill(0); }
  } catch (error) { if (error instanceof OwnerMigrationError) throw error; return fail('DECRYPTION_FAILED'); }
}
export function decryptMigrationRequest(envelope: unknown, privateKeyPem: string): { sourceBearer: string; transferSecret: string } {
  const request = exact(decryptEnvelope(envelope, privateKeyPem, 'jiashu-migration-request-v1'), ['sourceBearer', 'transferSecret']);
  if (typeof request.sourceBearer !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(request.sourceBearer)
    || typeof request.transferSecret !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(request.transferSecret)) return fail('INVALID_REQUEST');
  return { sourceBearer: request.sourceBearer, transferSecret: request.transferSecret };
}
export function decryptOwnerMigrationEnvelope(envelope: unknown, privateKeyPem: string): OwnerSnapshot {
  const payload = decryptEnvelope(envelope, privateKeyPem, 'jiashu-owner-migration-v1');
  const validated = validateOwnerSnapshot(payload);
  if (JSON.stringify(validated.header) !== JSON.stringify(object(envelope).header)) return fail('HEADER_MISMATCH');
  return validated;
}
export function validateOwnerSnapshot(value: unknown): OwnerSnapshot {
  const snapshot = exact(value, ['header', 'exportedAt', 'tables', 'secrets']);
  const claims = object(snapshot.header);
  if (typeof claims.keyFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(claims.keyFingerprint)) return fail('HEADER_MISMATCH');
  header(claims, claims.keyFingerprint, 'jiashu-owner-migration-v1');
  if (typeof snapshot.exportedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.exportedAt)) || new Date(snapshot.exportedAt).toISOString() !== snapshot.exportedAt) return fail('INVALID_FORMAT');
  const secrets = exact(snapshot.secrets, ['aiKey', 'tmdbToken']);
  if (secrets.aiKey !== null && (typeof secrets.aiKey !== 'string' || !secrets.aiKey || secrets.aiKey.length > 4096)
    || secrets.tmdbToken !== null && (typeof secrets.tmdbToken !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(secrets.tmdbToken))) return fail('INVALID_SECRET');
  if (!Array.isArray(snapshot.tables) || snapshot.tables.length > 64) return fail('INVALID_FORMAT');
  let rowCount = 0, previous = '';
  for (const entry of snapshot.tables) {
    const table = exact(entry, ['name', 'columns', 'rows', 'sha256']);
    if (!validIdentifier(table.name) || !allowedTables.has(table.name) || lex(previous, table.name) >= 0) return fail('TABLE_NOT_ALLOWED');
    previous = table.name;
    if (!Array.isArray(table.columns) || table.columns.length === 0 || table.columns.length > 64 || table.columns.some(name => !validIdentifier(name))
      || [...new Set(table.columns)].sort(lex).join(',') !== table.columns.join(',') || !Array.isArray(table.rows)) return fail('INVALID_COLUMNS');
    let previousRow: string | undefined;
    for (const value of table.rows) {
      const row = object(value);
      if (Object.keys(row).join(',') !== table.columns.join(',') || Object.values(row).some(cell => cell !== null && typeof cell !== 'string' && !(typeof cell === 'number' && Number.isFinite(cell)))) return fail('INVALID_ROW');
      const serialized = JSON.stringify(row);
      if (previousRow !== undefined && lex(previousRow, serialized) >= 0) return fail('INVALID_ROW_ORDER');
      previousRow = serialized;
    }
    rowCount += table.rows.length;
    if (rowCount > MAX_ROWS || typeof table.sha256 !== 'string' || table.sha256 !== digest(JSON.stringify({ name: table.name, columns: table.columns, rows: table.rows }))) return fail('SOURCE_HASH_MISMATCH');
  }
  const result = snapshot as unknown as OwnerSnapshot;
  validateScope(result);
  return result;
}
function validateScope(snapshot: OwnerSnapshot): void {
  const books = new Set(snapshot.tables.find(table => table.name === 'family_books')?.rows.map(row => row.id) ?? []);
  const foods = new Set(snapshot.tables.find(table => table.name === 'managed_foods')?.rows.map(row => row.id) ?? []);
  for (const table of snapshot.tables) {
    const scopeColumn = userTables.has(table.name) ? 'user_id' : table.name === 'tmdb_settings' ? 'owner_id' : table.name === 'family_books' ? 'owner_user_id' : table.name === 'managed_foods' ? 'created_by' : null;
    if (scopeColumn && !table.columns.includes(scopeColumn)) return fail('OWNER_SCOPE_MISMATCH');
    for (const row of table.rows) {
      if (scopeColumn && row[scopeColumn] !== migrationIdentity.sourceOwnerId) return fail('OWNER_SCOPE_MISMATCH');
      if (familyTables.has(table.name) && !books.has(row.book_id)) return fail('OWNER_SCOPE_MISMATCH');
      if (['managed_food_versions', 'managed_food_operations'].includes(table.name) && !foods.has(row.item_id)) return fail('OWNER_SCOPE_MISMATCH');
      if (table.name === 'managed_food_operations' && row.actor_user_id !== migrationIdentity.sourceOwnerId) return fail('OWNER_SCOPE_MISMATCH');
    }
    const secretColumns = cryptoColumns[table.name];
    if (secretColumns) {
      if (table.rows.length > 1 || !secretColumns.every(column => table.columns.includes(column))) return fail('INVALID_SECRET');
      const row = table.rows[0], plaintext = table.name === 'ai_user_settings' ? snapshot.secrets.aiKey : snapshot.secrets.tmdbToken;
      if (!row && plaintext !== null || row && ((row[secretColumns[0]] === null) !== (row[secretColumns[1]] === null)
        || (row[secretColumns[0]] === null) !== (plaintext === null))) return fail('INVALID_SECRET');
    }
  }
  for (const [name, secret] of [['ai_user_settings', snapshot.secrets.aiKey], ['tmdb_settings', snapshot.secrets.tmdbToken]] as const) {
    if (secret !== null && !snapshot.tables.some(table => table.name === name && table.rows.length === 1)) return fail('INVALID_SECRET');
  }
}
function safePath(path: string): void { if (!isAbsolute(path) || path.includes('\0')) fail('INVALID_PATH'); }
function masterKey(value: string): Buffer { const bytes = base64(value, 32, 32); return bytes; }
function sourceDigest(snapshot: OwnerSnapshot, key: Buffer): string {
  // Bind the actual credential plaintext to the reviewed plan without exposing
  // an offline dictionary oracle for a human-chosen provider key.
  const secretBinding = createHmac('sha256', key).update('jiashu-owner-migration-secret-binding-v1\0').update(JSON.stringify(snapshot.secrets)).digest('hex');
  return digest(JSON.stringify({ ...migrationIdentity, tables: snapshot.tables.map(table => ({ name: table.name, sha256: table.sha256 })), secretBinding }));
}
function canonicalRows(rows: Row[], columns: string[]): Row[] {
  return rows.map(row => Object.fromEntries(columns.map(column => [column, row[column]]))).sort((left, right) => lex(JSON.stringify(left), JSON.stringify(right)));
}
function schemaObjects(db: DatabaseSync): Row[] { return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type,name").all() as Row[]; }
export function ownerMigrationDatabaseFingerprint(databasePath: string): string {
  safePath(databasePath);
  const db = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false });
  try { db.exec('PRAGMA busy_timeout=5000; BEGIN'); const result = fingerprint(db); db.exec('COMMIT'); return result; }
  catch (error) { if (error instanceof OwnerMigrationError) throw error; return fail('DATABASE_UNAVAILABLE'); }
  finally { db.close(); }
}
function fingerprint(db: DatabaseSync): string {
  const hash = createHash('sha256'); hash.update(JSON.stringify(schemaObjects(db)));
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[];
  for (const { name } of tables) {
    const columns = (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[]).map(column => column.name).sort(lex);
    const rows = canonicalRows(db.prepare(`SELECT * FROM ${quote(name)}`).all() as Row[], columns);
    hash.update(JSON.stringify({ name, columns, rows }));
  }
  return hash.digest('hex');
}
function targetSecret(table: string, row: Row, key: Buffer): string | null {
  const [ciphertext, iv] = cryptoColumns[table];
  if (row[ciphertext] === null && row[iv] === null) return null;
  try {
    const encrypted = base64(row[ciphertext], 16_400), nonce = base64(row[iv], 12, 12);
    if (encrypted.length < 17) return fail('TARGET_SECRET_UNAVAILABLE');
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    const purpose = table === 'ai_user_settings' ? 'jiashu-os:ai-user-settings:key:v1' : 'jiashu-os:tmdb-settings:token:v1';
    cipher.setAAD(Buffer.from(JSON.stringify([purpose, migrationIdentity.targetOwnerId]))); cipher.setAuthTag(encrypted.subarray(-16));
    return new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat([cipher.update(encrypted.subarray(0, -16)), cipher.final()]));
  } catch { return fail('TARGET_SECRET_UNAVAILABLE'); }
}
function encryptSecret(table: string, row: Row, snapshot: OwnerSnapshot, key: Buffer): Row {
  if (!cryptoColumns[table]) return row;
  const [ciphertext, iv] = cryptoColumns[table], plaintext = table === 'ai_user_settings' ? snapshot.secrets.aiKey : snapshot.secrets.tmdbToken;
  if (plaintext === null) return { ...row, [ciphertext]: null, [iv]: null };
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  const purpose = table === 'ai_user_settings' ? 'jiashu-os:ai-user-settings:key:v1' : 'jiashu-os:tmdb-settings:token:v1';
  cipher.setAAD(Buffer.from(JSON.stringify([purpose, migrationIdentity.targetOwnerId])));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { ...row, [ciphertext]: encrypted.toString('base64'), [iv]: nonce.toString('base64') };
}
function mapRow(row: Row): Row { return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, identityColumns.has(column) && value === migrationIdentity.sourceOwnerId ? migrationIdentity.targetOwnerId : value])); }
function equalRow(table: string, columns: string[], incoming: Row, existing: Row, snapshot: OwnerSnapshot, key: Buffer): boolean {
  const ignored = new Set([...(sequencedTables.has(table) ? ['sequence'] : []), ...(cryptoColumns[table] ?? [])]);
  if (columns.some(column => !ignored.has(column) && incoming[column] !== existing[column])) return false;
  if (cryptoColumns[table]) return targetSecret(table, existing, key) === (table === 'ai_user_settings' ? snapshot.secrets.aiKey : snapshot.secrets.tmdbToken);
  return true;
}
interface Column { name: string; pk: number; notnull: number; dflt_value: string | null }
function constraintKind(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/UNIQUE constraint|PRIMARY KEY constraint/.test(message)) return 'unique';
  if (/CHECK constraint/.test(message)) return 'check';
  if (/NOT NULL constraint/.test(message)) return 'not_null';
  if (/FOREIGN KEY constraint/.test(message)) return 'foreign_key';
  return fail('CANDIDATE_WRITE_FAILED');
}
function checkTargetSchema(db: DatabaseSync, snapshot: OwnerSnapshot): void {
  for (const table of snapshot.tables) {
    const columns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as unknown as Column[];
    if (!columns.length || table.columns.some(name => !columns.some(column => column.name === name))
      || columns.some(column => column.pk > 0 && !table.columns.includes(column.name))) fail('TARGET_SCHEMA_MISMATCH');
  }
  const owner = db.prepare('SELECT status FROM local_users WHERE id=?').get(migrationIdentity.targetOwnerId);
  if (!owner || owner.status !== 'active') fail('TARGET_OWNER_UNAVAILABLE');
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='_selfhost_migrations'").get()) fail('TARGET_LEDGER_MISSING');
}
function verifyRows(db: DatabaseSync, snapshot: OwnerSnapshot, key: Buffer): { name: string; rows: number; sha256: string }[] {
  return snapshot.tables.map(table => {
    const targetColumns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as unknown as Column[];
    const primary = sequencedTables.has(table.name) ? ['id'] : targetColumns.filter(column => column.pk > 0).sort((left, right) => left.pk - right.pk).map(column => column.name);
    if (!primary.length) fail('TARGET_SCHEMA_MISMATCH');
    const find = db.prepare(`SELECT * FROM ${quote(table.name)} WHERE ${primary.map(column => quote(column) + ' IS ?').join(' AND ')}`);
    const rows = table.rows.map(original => {
      const incoming = mapRow(original), actual = find.get(...primary.map(column => incoming[column] as SQLInputValue)) as Row | undefined;
      if (!actual || !equalRow(table.name, table.columns, incoming, actual, snapshot, key)) return fail('IMPORTED_ROW_MISMATCH');
      return actual;
    });
    const columns = targetColumns.map(column => column.name).sort(lex);
    return { name: table.name, rows: rows.length, sha256: digest(JSON.stringify({ name: table.name, columns, rows: canonicalRows(rows, columns) })) };
  });
}
export function verifyOwnerMigration(options: OwnerMigrationOptions): OwnerMigrationVerification {
  const snapshot = validateOwnerSnapshot(options.snapshot), key = masterKey(options.masterKey);
  safePath(options.databasePath);
  const db = new DatabaseSync(options.databasePath, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN'); checkTargetSchema(db, snapshot);
    const tables = verifyRows(db, snapshot, key), targetFingerprint = fingerprint(db);
    if (db.prepare('PRAGMA foreign_key_check').all().length) fail('CANDIDATE_INTEGRITY_FAILED');
    const integrity = db.prepare('PRAGMA integrity_check').all() as Record<string, unknown>[];
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') fail('CANDIDATE_INTEGRITY_FAILED');
    db.exec('COMMIT');
    return { migrationId: migrationIdentity.migrationId, sourceDigest: sourceDigest(snapshot, key), targetFingerprint, tables, verified: true };
  } catch (error) { if (error instanceof OwnerMigrationError) throw error; return fail('MIGRATION_VERIFICATION_FAILED'); }
  finally { key.fill(0); db.close(); }
}
async function simulate(options: OwnerMigrationOptions, candidatePath: string, reserved: () => void = () => {}): Promise<{ plan: OwnerMigrationPlan; targetAfter: string; tableHashes: { name: string; rows: number; sha256: string }[] }> {
  const snapshot = validateOwnerSnapshot(options.snapshot), key = masterKey(options.masterKey);
  safePath(options.databasePath); safePath(candidatePath);
  if (resolve(options.databasePath) === resolve(candidatePath) || existsSync(candidatePath)) fail('CANDIDATE_EXISTS');
  const source = new DatabaseSync(options.databasePath, { readOnly: true, allowExtension: false });
  let target: DatabaseSync | undefined;
  try {
    source.exec('PRAGMA busy_timeout=5000; BEGIN');
    const targetFingerprint = fingerprint(source); checkTargetSchema(source, snapshot);
    // Reserve the candidate without following a symlink or overwriting another
    // administrator's file before SQLite opens the destination.
    closeSync(openSync(candidatePath, 'wx', 0o600));
    reserved();
    await backup(source, candidatePath); chmodSync(candidatePath, 0o600); source.exec('COMMIT');
    target = new DatabaseSync(candidatePath, { allowExtension: false });
    target.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=OFF;');
    if (fingerprint(target) !== targetFingerprint) fail('TARGET_CHANGED');
    const beforeSchema = JSON.stringify(schemaObjects(target));
    const triggers = target.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all() as { name: string; sql: string }[];
    const tables: OwnerMigrationTablePlan[] = [], conflicts: OwnerMigrationConflict[] = [];
    const addConflict = (table: string, kind: string) => { const existing = conflicts.find(item => item.table === table && item.kind === kind); if (existing) existing.count++; else conflicts.push({ table, kind, count: 1 }); };
    target.exec('BEGIN IMMEDIATE');
    try {
      for (const trigger of triggers) target.exec(`DROP TRIGGER ${quote(trigger.name)}`);
      for (const table of snapshot.tables) {
        const stats: OwnerMigrationTablePlan = { name: table.name, sourceRows: table.rows.length, insert: 0, skip: 0, conflicts: 0, sequenceRemaps: 0 }; tables.push(stats);
        const columns = target.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as unknown as Column[];
        const primary = sequencedTables.has(table.name) ? ['id'] : columns.filter(column => column.pk > 0).sort((left, right) => left.pk - right.pk).map(column => column.name);
        if (!primary.length) fail('TARGET_SCHEMA_MISMATCH');
        const find = target.prepare(`SELECT * FROM ${quote(table.name)} WHERE ${primary.map(column => quote(column) + ' IS ?').join(' AND ')}`);
        // Sequence values are global, while the source is scoped to one user.
        // Allocate new local values in the original relative order and use the
        // globally unique business id for comparisons/idempotency.
        const rows = sequencedTables.has(table.name) ? table.rows.slice().sort((left, right) => Number(left.sequence) - Number(right.sequence)) : table.rows;
        for (const original of rows) {
          let incoming = mapRow(original);
          const existing = find.get(...primary.map(column => incoming[column] as SQLInputValue)) as Row | undefined;
          if (existing) {
            if (equalRow(table.name, table.columns, incoming, existing, snapshot, key)) stats.skip++;
            else { stats.conflicts++; addConflict(table.name, 'different_record'); }
            continue;
          }
          incoming = encryptSecret(table.name, incoming, snapshot, key);
          const insertColumns = table.columns.filter(column => !(sequencedTables.has(table.name) && column === 'sequence'));
          target.exec('SAVEPOINT owner_migration_row');
          try {
            target.prepare(`INSERT INTO ${quote(table.name)} (${insertColumns.map(quote).join(',')}) VALUES (${insertColumns.map(() => '?').join(',')})`).run(...insertColumns.map(column => incoming[column] as SQLInputValue));
            if (sequencedTables.has(table.name)) {
              const assigned = find.get(...primary.map(column => incoming[column] as SQLInputValue)) as Row;
              if (assigned.sequence !== original.sequence) stats.sequenceRemaps++;
            }
            stats.insert++; target.exec('RELEASE owner_migration_row');
          } catch (error) {
            target.exec('ROLLBACK TO owner_migration_row; RELEASE owner_migration_row');
            const kind = constraintKind(error); stats.conflicts++; addConflict(table.name, kind);
          }
        }
      }
      for (const trigger of triggers) target.exec(trigger.sql);
      if (JSON.stringify(schemaObjects(target)) !== beforeSchema) fail('TARGET_SCHEMA_CHANGED');
      const broken = target.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) addConflict('_validation', 'foreign_key');
      const integrity = target.prepare('PRAGMA integrity_check').all() as Record<string, unknown>[];
      if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') fail('CANDIDATE_INTEGRITY_FAILED');
      target.exec('COMMIT');
    } catch (error) { target.exec('ROLLBACK'); throw error; }
    target.exec('PRAGMA foreign_keys=ON;');
    const sourceHash = sourceDigest(snapshot, key), canApply = conflicts.length === 0;
    const planBase = { migrationId: migrationIdentity.migrationId, sourceDigest: sourceHash, targetFingerprint, tables, conflicts, canApply };
    const tableHashes = canApply ? verifyRows(target, snapshot, key) : [];
    return { plan: { ...planBase, planHash: digest(JSON.stringify(planBase)) }, targetAfter: fingerprint(target), tableHashes };
  } catch (error) {
    if (error instanceof OwnerMigrationError) throw error;
    return fail('MIGRATION_VALIDATION_FAILED');
  } finally { key.fill(0); target?.close(); source.close(); }
}
export async function planOwnerMigration(options: OwnerMigrationOptions): Promise<OwnerMigrationPlan> {
  safePath(options.workDirectory); mkdirSync(options.workDirectory, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(options.workDirectory, 'owner-plan-'));
  chmodSync(directory, 0o700);
  try { return (await simulate(options, join(directory, 'candidate.sqlite3'))).plan; }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
export async function buildOwnerMigrationCandidate(options: OwnerMigrationOptions & { candidatePath: string; expectedPlanHash: string }): Promise<OwnerMigrationReceipt> {
  safePath(options.candidatePath);
  if (!/^[a-f0-9]{64}$/.test(options.expectedPlanHash)) return fail('INVALID_PLAN_HASH');
  mkdirSync(dirname(options.candidatePath), { recursive: true, mode: 0o700 });
  if (existsSync(options.candidatePath)) return fail('CANDIDATE_EXISTS');
  let keep = false, reserved = false;
  try {
    const { plan, targetAfter, tableHashes } = await simulate(options, options.candidatePath, () => { reserved = true; });
    if (!plan.canApply) return fail('MIGRATION_CONFLICT');
    if (plan.planHash !== options.expectedPlanHash) return fail('TARGET_CHANGED');
    if (statSync(options.candidatePath).size < 1) return fail('CANDIDATE_INTEGRITY_FAILED');
    keep = true;
    return { migrationId: plan.migrationId, planHash: plan.planHash, sourceDigest: plan.sourceDigest,
      targetBefore: plan.targetFingerprint, targetAfter, tables: plan.tables, tableHashes, verified: true };
  } finally {
    if (!keep && reserved) for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(options.candidatePath + suffix, { force: true });
  }
}
