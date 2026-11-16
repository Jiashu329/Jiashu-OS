import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { withPageAccount } from './page-account.ts';

void test('server page owner precedes every application script and cannot inject HTML', () => {
  const result = withPageAccount('<!doctype html><html><head><script>window.first=true</script></head><body>content</body></html>', 'alice</script><script>alert(1)</script>');
  assert.ok(result.indexOf('__JIASHU_PAGE_OWNER__') < result.indexOf('window.first=true'));
  assert.ok(result.indexOf('JiashuAccountSession') < result.indexOf('window.first=true'));
  assert.ok(result.includes('\\u003c/script\\u003e'));
  assert.ok(result.includes('writable:false,configurable:false'));
  assert.equal(result.includes('<script>alert(1)</script>'), false);
  assert.throws(() => withPageAccount('<head></head>', ''), /Invalid page/);
});

void test('fresh authorized HTML bootstraps only its immutable public identity before application code', () => {
  const user = { userId: 'alice', email: 'alice@example.test', displayName: 'Alice </script><img src=x>&\u2028', isOwner: true, sessionToken: 'never-export-this-credential' };
  const result = withPageAccount('<html><head></head><body>private content</body></html>', user.userId, user);
  const binding = result.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert.ok(binding);
  const window: Record<string, unknown> = {};
  runInNewContext(binding, { window });
  const session = window.__JIASHU_PAGE_SESSION__ as Record<string, unknown>;
  assert.deepEqual(JSON.parse(JSON.stringify(session)), { userId: user.userId, email: user.email, displayName: user.displayName, isOwner: true });
  assert.equal(Object.isFrozen(session), true);
  assert.equal(Object.getOwnPropertyDescriptor(window, '__JIASHU_PAGE_SESSION__')?.writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(window, '__JIASHU_PAGE_SESSION__')?.configurable, false);
  assert.equal(result.includes('never-export-this-credential'), false);
  assert.equal(result.includes('</script><img'), false);
  assert.ok(result.indexOf('__JIASHU_PAGE_SESSION__') < result.indexOf('JiashuAccountSession'));
  assert.equal(withPageAccount('<head></head>', 'alice').includes("Object.defineProperty(window,'__JIASHU_PAGE_SESSION__'"), false);
  assert.throws(() => withPageAccount('<head></head>', 'bob', user), /Invalid page session/);
});

void test('every authenticated HTML route pins its SSR identity, including shortcut guides and admin pages', () => {
  function routes(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === 'api' ? [] : routes(path);
      return entry.name === 'route.ts' ? [path] : [];
    });
  }
  for (const file of routes(new URL('../app', import.meta.url).pathname)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('requireChatGPTUser') || !source.includes('text/html')) continue;
    assert.ok(source.includes('withPageAccount('), file + ' has no server identity binding');
    assert.match(source, /,\s*(?:pageUser|user)\.userId,\s*(?:pageUser|user)\)/, file + ' does not pass its authorized server identity');
  }
});
