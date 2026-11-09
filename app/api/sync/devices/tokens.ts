const SYNC_TOKEN_PATTERN = /^jso_sync_[A-Za-z0-9_-]{43}$/;

/** App-scoped write credential. It never grants platform or read access. */
export function createSyncToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return 'jso_sync_' + btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isSyncToken(value: unknown): value is string {
  return typeof value === 'string' && SYNC_TOKEN_PATTERN.test(value);
}

export async function hashSyncToken(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes].map((part) => part.toString(16).padStart(2, '0')).join('');
}
