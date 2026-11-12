export class AISettingsCryptoError extends Error {
  readonly code = 'AI_SETTINGS_CRYPTO_UNAVAILABLE';
  constructor() {
    super('AI密钥加密配置不可用，请检查服务器加密设置，或重新保存密钥。');
    this.name = 'AISettingsCryptoError';
  }
}

export interface EncryptedAIKey { ciphertext: string; iv: string }

const encoder = new TextEncoder();
const purpose = 'jiashu-os:ai-user-settings:key:v1';
const maximumCiphertextBytes = 4096 * 4 + 16;

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decode(value: unknown, maximumBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maximumBytes / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new AISettingsCryptoError();
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (bytes.byteLength > maximumBytes || base64(bytes) !== value) throw new AISettingsCryptoError();
  return bytes;
}

function masterBytes(master: unknown): Uint8Array<ArrayBuffer> {
  const bytes = decode(master, 32);
  if (bytes.byteLength !== 32) throw new AISettingsCryptoError();
  return bytes;
}

function additionalData(userId: unknown): Uint8Array<ArrayBuffer> {
  if (typeof userId !== 'string' || !userId) throw new AISettingsCryptoError();
  return encoder.encode(JSON.stringify([purpose, userId]));
}

export function hasAISettingsEncryptionKey(master?: string): boolean {
  try { return masterBytes(master).byteLength === 32; }
  catch { return false; }
}

export async function encryptAIKey(master: string, userId: string, apiKey: string): Promise<EncryptedAIKey> {
  try {
    if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096) throw new AISettingsCryptoError();
    const key = await crypto.subtle.importKey('raw', masterBytes(master), { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(userId), tagLength: 128 }, key, encoder.encode(apiKey));
    return { ciphertext: base64(new Uint8Array(encrypted)), iv: base64(iv) };
  } catch {
    throw new AISettingsCryptoError();
  }
}

export async function decryptAIKey(master: string, userId: string, encrypted: EncryptedAIKey): Promise<string> {
  try {
    const key = await crypto.subtle.importKey('raw', masterBytes(master), { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const iv = decode(encrypted.iv, 12);
    const ciphertext = decode(encrypted.ciphertext, maximumCiphertextBytes);
    if (iv.byteLength !== 12 || ciphertext.byteLength < 17) throw new AISettingsCryptoError();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: additionalData(userId), tagLength: 128 }, key, ciphertext);
    const apiKey = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    if (!apiKey || apiKey.length > 4096) throw new AISettingsCryptoError();
    return apiKey;
  } catch {
    throw new AISettingsCryptoError();
  }
}
