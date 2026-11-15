/** Retry links never lead to another origin, an API or an authentication loop. */
export function safeAccountRetryPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 2000
    || value.includes('\\') || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return '/';
  let url: URL;
  try { url = new URL(value, 'https://app.local'); } catch { return '/'; }
  if (url.origin !== 'https://app.local' || /%(?:2f|5c)/i.test(url.pathname)) return '/';
  const exact = ['/', '/account', '/notifications', '/data', '/backup', '/connect-steps', '/connect-sleep', '/connect-weight', '/sync-guide'];
  const groups = ['/health', '/life', '/finance', '/settings', '/sync'];
  if (!exact.includes(url.pathname) && !groups.some(path => url.pathname === path || url.pathname.startsWith(path + '/'))) return '/';
  return url.pathname + url.search + url.hash;
}
