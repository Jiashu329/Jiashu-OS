export interface UserCoverDescriptor { mode: 'original' | 'url'; revision: number; url?: string }
export class UserCoverError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = 'INVALID_USER_COVER', status = 400) { super(message); this.name = 'UserCoverError'; this.code = code; this.status = status; }
}
function invalid(): never { throw new UserCoverError('请填写公开的 HTTPS 图片链接，不含账户密码、本机地址或非标准端口。'); }
/** A user URL is loaded by the browser; it never expands the server image-fetch allowlist. */
export function normalizeUserCoverUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return invalid();
  let url: URL; try { url = new URL(value); } catch { return invalid(); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !host.includes('.')
    || host.startsWith('[') || /^[0-9.]+$/.test(host) || !/^[a-z0-9.-]+$/.test(host)
    || host.endsWith('.') || host.split('.').some(part => !part || part.startsWith('-') || part.endsWith('-'))
    || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) return invalid();
  url.hash = '';
  if (url.href.length > 2000) return invalid();
  return url.href;
}
export function userCoverDescriptor(value: unknown, revision: number): UserCoverDescriptor {
  if (!Number.isSafeInteger(revision) || revision < 0) return invalid();
  if (value === null || value === undefined) return { mode: 'original', revision };
  return { mode: 'url', url: normalizeUserCoverUrl(value), revision };
}
