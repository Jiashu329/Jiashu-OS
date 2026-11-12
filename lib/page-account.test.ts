import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
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
  }
});
