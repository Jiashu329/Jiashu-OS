import { AISettingsCryptoError, decryptAIKey, encryptAIKey } from '../lib/ai-settings-crypto.ts';
import { readAIConfiguration } from '../lib/ai-provider.ts';
import type { AIConfiguration } from '../lib/ai-provider.ts';
import { normalizeTimestamp } from '../lib/health.ts';

export type AISettingsDatabase = Pick<D1Database, 'prepare'>;
export interface AISettingsMetadata {
  configured: boolean;
  model: string;
  region: 'cn' | 'global';
  revision: number;
  updatedAt: string | null;
  lastTestStatus: 'success' | 'failed' | null;
  lastTestAt: string | null;
}
export interface AISettingsInput {
  apiKey?: string;
  model: string;
  region: 'cn' | 'global';
  expectedRevision: number;
}
interface SettingsRow {
  keyCiphertext: string | null; keyIv: string | null; model: string; region: string; revision: number;
  createdAt: string; updatedAt: string; lastTestStatus: string | null; lastTestAt: string | null;
}
export class AISettingsConflictError extends Error {
  readonly code = 'AI_SETTINGS_CONFLICT';
  constructor() { super('AI设置已经变化，请刷新后核对最新设置再重试。'); this.name = 'AISettingsConflictError'; }
}
export class AISettingsValidationError extends Error {
  readonly code = 'INVALID_AI_SETTINGS';
  constructor(message = 'AI设置无效，请检查密钥、MiniMax模型名称和区域。') { super(message); this.name = 'AISettingsValidationError'; }
}

const defaultModel = 'MiniMax-M3';
const columns = `key_ciphertext AS keyCiphertext, key_iv AS keyIv, model, region, revision,
  created_at AS createdAt, updated_at AS updatedAt, last_test_status AS lastTestStatus, last_test_at AS lastTestAt`;

function validModel(model: unknown): model is string {
  return typeof model === 'string' && model.length <= 100 && /^MiniMax-[A-Za-z0-9][A-Za-z0-9._-]*$/i.test(model);
}
function metadata(row: SettingsRow | null): AISettingsMetadata {
  return {
    configured: Boolean(row && (row.keyCiphertext !== null || row.keyIv !== null)),
    model: row && validModel(row.model) ? row.model : defaultModel,
    region: row?.region === 'global' ? 'global' : 'cn', revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt ?? null,
    lastTestStatus: row?.lastTestStatus === 'success' || row?.lastTestStatus === 'failed' ? row.lastTestStatus : null,
    lastTestAt: row?.lastTestAt ?? null,
  };
}
function revision(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new AISettingsValidationError('请先读取当前AI设置版本，再保存或清除。');
  }
}
function owner(userId: string) {
  if (typeof userId !== 'string' || !userId) throw new AISettingsValidationError('请先登录后管理自己的AI设置。');
}
function timestamp(value: string) {
  const normalized = normalizeTimestamp(value);
  if (!normalized) throw new AISettingsValidationError('AI设置更新时间无效，请刷新后重试。');
  return normalized;
}
async function readRow(db: AISettingsDatabase, userId: string): Promise<SettingsRow | null> {
  owner(userId);
  return db.prepare(`SELECT ${columns} FROM ai_user_settings WHERE user_id = ?`).bind(userId).first<SettingsRow>();
}
function requireVersion(row: SettingsRow | null, expectedRevision: number) {
  revision(expectedRevision);
  if ((row?.revision ?? 0) !== expectedRevision) throw new AISettingsConflictError();
}
async function storedKey(row: SettingsRow, master: string | undefined, userId: string): Promise<string> {
  if (!master || typeof row.keyCiphertext !== 'string' || typeof row.keyIv !== 'string') throw new AISettingsCryptoError();
  return decryptAIKey(master, userId, { ciphertext: row.keyCiphertext, iv: row.keyIv });
}

export async function readAISettings(db: AISettingsDatabase, userId: string): Promise<AISettingsMetadata> {
  return metadata(await readRow(db, userId));
}

/** Each write is an atomic owner/revision comparison, including the first insert. */
export async function saveAISettings(db: AISettingsDatabase, userId: string, input: AISettingsInput, master: string, now = new Date().toISOString()): Promise<AISettingsMetadata> {
  owner(userId);
  revision(input.expectedRevision);
  const updatedAt = timestamp(now);
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!validModel(model) || (input.region !== 'cn' && input.region !== 'global')
    || (input.apiKey !== undefined && typeof input.apiKey !== 'string')) throw new AISettingsValidationError();
  const current = await readRow(db, userId);
  requireVersion(current, input.expectedRevision);
  let apiKey = input.apiKey?.trim() ?? '';
  if (!apiKey) {
    if (!current || (current.keyCiphertext === null && current.keyIv === null)) {
      throw new AISettingsValidationError('请填写MiniMax API密钥；留空只能保留已保存的密钥。');
    }
    apiKey = await storedKey(current, master, userId);
  }
  const configuration = readAIConfiguration({ AI_PROVIDER: 'minimax', MINIMAX_API_KEY: apiKey, MINIMAX_MODEL: model, MINIMAX_REGION: input.region });
  if (!configuration.ready || model.includes(apiKey)) throw new AISettingsValidationError();
  const encrypted = await encryptAIKey(master, userId, apiKey);
  const saved = input.expectedRevision === 0
    ? await db.prepare(`INSERT INTO ai_user_settings
      (user_id, key_ciphertext, key_iv, model, region, revision, created_at, updated_at, last_test_status, last_test_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL) ON CONFLICT(user_id) DO NOTHING RETURNING ${columns}`)
      .bind(userId, encrypted.ciphertext, encrypted.iv, model, input.region, updatedAt, updatedAt).first<SettingsRow>()
    : await db.prepare(`UPDATE ai_user_settings SET key_ciphertext = ?, key_iv = ?, model = ?, region = ?,
      revision = revision + 1, updated_at = ?, last_test_status = NULL, last_test_at = NULL
      WHERE user_id = ? AND revision = ? RETURNING ${columns}`)
      .bind(encrypted.ciphertext, encrypted.iv, model, input.region, updatedAt, userId, input.expectedRevision).first<SettingsRow>();
  if (!saved) throw new AISettingsConflictError();
  return metadata(saved);
}

/** Keep a tombstone so a stale in-flight save cannot resurrect a cleared key. */
export async function clearAISettings(db: AISettingsDatabase, userId: string, expectedRevision: number, now = new Date().toISOString()): Promise<AISettingsMetadata> {
  owner(userId);
  revision(expectedRevision);
  const updatedAt = timestamp(now);
  const cleared = expectedRevision === 0
    ? await db.prepare(`INSERT INTO ai_user_settings
      (user_id, key_ciphertext, key_iv, model, region, revision, created_at, updated_at, last_test_status, last_test_at)
      VALUES (?, NULL, NULL, ?, 'cn', 1, ?, ?, NULL, NULL) ON CONFLICT(user_id) DO NOTHING RETURNING ${columns}`)
      .bind(userId, defaultModel, updatedAt, updatedAt).first<SettingsRow>()
    : await db.prepare(`UPDATE ai_user_settings SET key_ciphertext = NULL, key_iv = NULL,
      revision = revision + 1, updated_at = ?, last_test_status = NULL, last_test_at = NULL
      WHERE user_id = ? AND revision = ? RETURNING ${columns}`)
      .bind(updatedAt, userId, expectedRevision).first<SettingsRow>();
  if (!cleared) throw new AISettingsConflictError();
  return metadata(cleared);
}

export async function recordAISettingsTest(db: AISettingsDatabase, userId: string, expectedRevision: number, success: boolean, now = new Date().toISOString()): Promise<AISettingsMetadata> {
  owner(userId);
  revision(expectedRevision);
  if (typeof success !== 'boolean') throw new AISettingsValidationError();
  const testedAt = timestamp(now);
  const saved = await db.prepare(`UPDATE ai_user_settings SET last_test_status = ?, last_test_at = ?
    WHERE user_id = ? AND revision = ? AND key_ciphertext IS NOT NULL AND key_iv IS NOT NULL RETURNING ${columns}`)
    .bind(success ? 'success' : 'failed', testedAt, userId, expectedRevision).first<SettingsRow>();
  if (!saved) throw new AISettingsConflictError();
  return metadata(saved);
}

/** Resolve only this user's encrypted key. Environment-wide provider keys are never read. */
export async function resolveUserAIConfiguration(db: AISettingsDatabase, userId: string, master?: string, expectedRevision?: number): Promise<AIConfiguration> {
  const row = await readRow(db, userId);
  if (expectedRevision !== undefined) requireVersion(row, expectedRevision);
  const safe = metadata(row);
  if (!row || (row.keyCiphertext === null && row.keyIv === null)) {
    return readAIConfiguration({ AI_PROVIDER: 'minimax', MINIMAX_MODEL: safe.model, MINIMAX_REGION: safe.region });
  }
  const apiKey = await storedKey(row, master, userId);
  return readAIConfiguration({ AI_PROVIDER: 'minimax', MINIMAX_API_KEY: apiKey, MINIMAX_MODEL: safe.model, MINIMAX_REGION: safe.region });
}
