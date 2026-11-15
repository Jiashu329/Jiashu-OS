/* oxlint-disable no-control-regex -- Password validation intentionally rejects NUL and line breaks. */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const PREFIX = 'scrypt-v1', N = 32768, R = 8, P = 1, BYTES = 64;
function decode(value: string, size: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const result = Buffer.from(value, 'base64url');
  return result.length === size && result.toString('base64url') === value ? result : null;
}
function parsed(value: unknown): { salt: Buffer; hash: Buffer } | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  const parts = value.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX || parts[1] !== String(N) || parts[2] !== String(R) || parts[3] !== String(P)) return null;
  const salt = decode(parts[4], 16), hash = decode(parts[5], BYTES);
  return salt && hash ? { salt, hash } : null;
}
export const isValidPasswordHash = (value: unknown): value is string => parsed(value) !== null;
export function validSelfhostPassword(value: unknown): value is string {
  return typeof value === 'string' && Array.from(value).length >= 12 && Array.from(value).length <= 256
    && Buffer.byteLength(value) <= 1024 && !/[\u0000\r\n]/.test(value);
}
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, BYTES, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string): Promise<string> {
  if (!validSelfhostPassword(password)) throw new Error('Password must contain 12–256 characters without NUL or line breaks.');
  const salt = randomBytes(16), hash = await derive(password, salt);
  return [PREFIX, N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}
export async function verifyPassword(password: unknown, encoded: string): Promise<boolean> {
  const value = parsed(encoded);
  if (!value || !validSelfhostPassword(password)) return false;
  return timingSafeEqual(await derive(password, value.salt), value.hash);
}
