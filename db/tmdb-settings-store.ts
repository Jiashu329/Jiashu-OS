import { configuredAccessOwner, validAccessUserId } from '../lib/access-control.ts';
import { decryptTMDBToken, encryptTMDBToken, TMDBSettingsCryptoError } from '../lib/tmdb-settings-crypto.ts';
import type { TMDBSettingsInput } from '../lib/tmdb-settings.ts';

export type TMDBSettingsDatabase = Pick<D1Database, 'prepare'>;
export interface TMDBSettingsEnvironment { APP_OWNER_USER_ID?: string; AI_SETTINGS_ENCRYPTION_KEY?: string }
export interface TMDBSettingsMetadata {
  configured: boolean; revision: number; updatedAt: string | null;
  lastTestStatus: 'success' | 'failed' | null; lastTestAt: string | null;
}
export type TMDBConfiguration = { configured: false; revision: number } | { configured: true; token: string; revision: number };
interface SettingsRow { tokenCiphertext: string | null; tokenIv: string | null; revision: number; updatedAt: string; lastTestStatus: string | null; lastTestAt: string | null }
export class TMDBSettingsOwnerUnavailableError extends Error {
  readonly code = 'TMDB_SETTINGS_OWNER_UNAVAILABLE';
  constructor() { super('网站创建者身份暂未就绪，请稍后再试。'); this.name = 'TMDBSettingsOwnerUnavailableError'; }
}
export class TMDBSettingsConflictError extends Error {
  readonly code = 'TMDB_SETTINGS_CONFLICT';
  constructor() { super('封面服务设置已变化，请重新读取最新设置后重试。'); this.name = 'TMDBSettingsConflictError'; }
}
export class TMDBSettingsValidationError extends Error {
  readonly code = 'INVALID_TMDB_SETTINGS';
  constructor(message = '封面服务设置无效，请核对后重试。') { super(message); this.name = 'TMDBSettingsValidationError'; }
}
const columns = `token_ciphertext AS tokenCiphertext, token_iv AS tokenIv, revision, updated_at AS updatedAt,
  last_test_status AS lastTestStatus, last_test_at AS lastTestAt`;
function metadata(row: SettingsRow | null): TMDBSettingsMetadata {
  return { configured: Boolean(row && (row.tokenCiphertext !== null || row.tokenIv !== null)), revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt ?? null, lastTestStatus: row?.lastTestStatus === 'success' || row?.lastTestStatus === 'failed' ? row.lastTestStatus : null,
    lastTestAt: row?.lastTestAt ?? null };
}
function validate(ownerId: string, expectedRevision?: number) {
  if (!validAccessUserId(ownerId)) throw new TMDBSettingsValidationError();
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER)) throw new TMDBSettingsValidationError();
}
function timestamp(now: string): string { const date = new Date(now); if (!Number.isFinite(date.getTime())) throw new TMDBSettingsValidationError(); return date.toISOString(); }
function requireVersion(row: SettingsRow | null, expectedRevision: number) { if ((row?.revision ?? 0) !== expectedRevision) throw new TMDBSettingsConflictError(); }
async function row(db: TMDBSettingsDatabase, ownerId: string): Promise<SettingsRow | null> {
  validate(ownerId);
  return db.prepare(`SELECT ${columns} FROM tmdb_settings WHERE owner_id = ?`).bind(ownerId).first<SettingsRow>();
}
async function storedToken(value: SettingsRow, master: string | undefined, ownerId: string): Promise<string> {
  if (!master || typeof value.tokenCiphertext !== 'string' || typeof value.tokenIv !== 'string') throw new TMDBSettingsCryptoError();
  return decryptTMDBToken(master, ownerId, { ciphertext: value.tokenCiphertext, iv: value.tokenIv });
}
/** Read an existing owner identity. This module never initializes one from a visitor. */
export async function readTMDBSettingsOwner(db: TMDBSettingsDatabase, env: TMDBSettingsEnvironment): Promise<string> {
  const explicit = configuredAccessOwner(env.APP_OWNER_USER_ID);
  if (explicit) return explicit;
  const existing = await db.prepare("SELECT user_id AS userId FROM app_owner_identity WHERE id = 'owner'").first<{ userId: string }>();
  if (!existing || !validAccessUserId(existing.userId)) throw new TMDBSettingsOwnerUnavailableError();
  return existing.userId;
}
export async function readTMDBSettings(db: TMDBSettingsDatabase, ownerId: string): Promise<TMDBSettingsMetadata> { return metadata(await row(db, ownerId)); }
export async function saveTMDBSettings(db: TMDBSettingsDatabase, ownerId: string, input: TMDBSettingsInput, master: string, now = new Date().toISOString()): Promise<TMDBSettingsMetadata> {
  validate(ownerId, input.expectedRevision);
  const current = await row(db, ownerId); requireVersion(current, input.expectedRevision);
  if (input.token !== undefined && typeof input.token !== 'string') throw new TMDBSettingsValidationError();
  let token = input.token?.trim() ?? '';
  if (!token) {
    if (!current || (current.tokenCiphertext === null && current.tokenIv === null)) throw new TMDBSettingsValidationError('首次配置请填写 API Read Access Token；留空只会保留已有 Token。');
    token = await storedToken(current, master, ownerId);
  }
  if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw new TMDBSettingsValidationError();
  const encrypted = await encryptTMDBToken(master, ownerId, token), updatedAt = timestamp(now);
  const saved = input.expectedRevision === 0
    ? await db.prepare(`INSERT INTO tmdb_settings (owner_id, token_ciphertext, token_iv, revision, created_at, updated_at, last_test_status, last_test_at)
      VALUES (?, ?, ?, 1, ?, ?, NULL, NULL) ON CONFLICT(owner_id) DO NOTHING RETURNING ${columns}`)
      .bind(ownerId, encrypted.ciphertext, encrypted.iv, updatedAt, updatedAt).first<SettingsRow>()
    : await db.prepare(`UPDATE tmdb_settings SET token_ciphertext = ?, token_iv = ?, revision = revision + 1,
      updated_at = ?, last_test_status = NULL, last_test_at = NULL WHERE owner_id = ? AND revision = ? RETURNING ${columns}`)
      .bind(encrypted.ciphertext, encrypted.iv, updatedAt, ownerId, input.expectedRevision).first<SettingsRow>();
  if (!saved) throw new TMDBSettingsConflictError();
  return metadata(saved);
}
/** Retain a revision tombstone so an in-flight save cannot resurrect a cleared Token. */
export async function clearTMDBSettings(db: TMDBSettingsDatabase, ownerId: string, expectedRevision: number, now = new Date().toISOString()): Promise<TMDBSettingsMetadata> {
  validate(ownerId, expectedRevision); const updatedAt = timestamp(now);
  const cleared = expectedRevision === 0
    ? await db.prepare(`INSERT INTO tmdb_settings (owner_id, token_ciphertext, token_iv, revision, created_at, updated_at, last_test_status, last_test_at)
      VALUES (?, NULL, NULL, 1, ?, ?, NULL, NULL) ON CONFLICT(owner_id) DO NOTHING RETURNING ${columns}`)
      .bind(ownerId, updatedAt, updatedAt).first<SettingsRow>()
    : await db.prepare(`UPDATE tmdb_settings SET token_ciphertext = NULL, token_iv = NULL, revision = revision + 1,
      updated_at = ?, last_test_status = NULL, last_test_at = NULL WHERE owner_id = ? AND revision = ? RETURNING ${columns}`)
      .bind(updatedAt, ownerId, expectedRevision).first<SettingsRow>();
  if (!cleared) throw new TMDBSettingsConflictError(); return metadata(cleared);
}
export async function recordTMDBSettingsTest(db: TMDBSettingsDatabase, ownerId: string, expectedRevision: number, success: boolean, now = new Date().toISOString()): Promise<TMDBSettingsMetadata> {
  validate(ownerId, expectedRevision); if (typeof success !== 'boolean') throw new TMDBSettingsValidationError();
  const saved = await db.prepare(`UPDATE tmdb_settings SET last_test_status = ?, last_test_at = ?
    WHERE owner_id = ? AND revision = ? AND token_ciphertext IS NOT NULL AND token_iv IS NOT NULL RETURNING ${columns}`)
    .bind(success ? 'success' : 'failed', timestamp(now), ownerId, expectedRevision).first<SettingsRow>();
  if (!saved) throw new TMDBSettingsConflictError(); return metadata(saved);
}
/** Server-only credential resolution; token is non-enumerable to prevent accidental JSON exposure. */
export async function resolveTMDBConfiguration(db: TMDBSettingsDatabase, env: TMDBSettingsEnvironment, expectedRevision?: number): Promise<TMDBConfiguration> {
  const ownerId = await readTMDBSettingsOwner(db, env); validate(ownerId, expectedRevision);
  const value = await row(db, ownerId);
  if (expectedRevision !== undefined) requireVersion(value, expectedRevision);
  if (!value || (value.tokenCiphertext === null && value.tokenIv === null)) return Object.freeze({ configured: false, revision: value?.revision ?? 0 });
  const token = await storedToken(value, env.AI_SETTINGS_ENCRYPTION_KEY, ownerId);
  return Object.freeze(Object.defineProperty({ configured: true as const, revision: value.revision }, 'token', { value: token, enumerable: false })) as TMDBConfiguration;
}
