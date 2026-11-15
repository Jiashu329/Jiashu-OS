/** TMDB and AI use the same server master key with distinct AES-GCM purposes. */
export class TMDBSettingsCryptoError extends Error {
  readonly code = 'TMDB_SETTINGS_ENCRYPTION_UNAVAILABLE';
  constructor() { super('封面服务密钥加密暂不可用，请重新填写 Token 或联系网站创建者。'); this.name = 'TMDBSettingsCryptoError'; }
}
export interface EncryptedTMDBToken { ciphertext: string; iv: string }
const encoder = new TextEncoder();
const purpose = 'jiashu-os:tmdb-settings:token:v1';
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function decode(value: unknown, maximumBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maximumBytes / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new TMDBSettingsCryptoError();
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (bytes.byteLength > maximumBytes || base64(bytes) !== value) throw new TMDBSettingsCryptoError();
  return bytes;
}
function masterBytes(master: unknown): Uint8Array<ArrayBuffer> {
  const bytes = decode(master, 32);
  if (bytes.byteLength !== 32) throw new TMDBSettingsCryptoError();
  return bytes;
}
function aad(ownerId: string): Uint8Array<ArrayBuffer> {
  if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 512) throw new TMDBSettingsCryptoError();
  return encoder.encode(JSON.stringify([purpose, ownerId]));
}
export function hasTMDBSettingsEncryptionKey(master?: string): boolean {
  try { return masterBytes(master).byteLength === 32; } catch { return false; }
}
export async function encryptTMDBToken(master: string, ownerId: string, token: string): Promise<EncryptedTMDBToken> {
  try {
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) throw new TMDBSettingsCryptoError();
    const key = await crypto.subtle.importKey('raw', masterBytes(master), { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(ownerId), tagLength: 128 }, key, encoder.encode(token));
    return { ciphertext: base64(new Uint8Array(ciphertext)), iv: base64(iv) };
  } catch { throw new TMDBSettingsCryptoError(); }
}
export async function decryptTMDBToken(master: string, ownerId: string, encrypted: EncryptedTMDBToken): Promise<string> {
  try {
    const key = await crypto.subtle.importKey('raw', masterBytes(master), { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const iv = decode(encrypted.iv, 12), ciphertext = decode(encrypted.ciphertext, 4096 + 16);
    if (iv.byteLength !== 12 || ciphertext.byteLength < 17) throw new TMDBSettingsCryptoError();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(ownerId), tagLength: 128 }, key, ciphertext);
    const token = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw new TMDBSettingsCryptoError();
    return token;
  } catch { throw new TMDBSettingsCryptoError(); }
}
