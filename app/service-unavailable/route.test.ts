import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { compileFunction } from 'node:vm';
import test from 'node:test';
import { safeAccountRetryPath } from '../../lib/account-retry.ts';

function handler() {
  const source = stripTypeScriptTypes(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  return compileFunction(source + '\nreturn GET;', ['safeAccountRetryPath', 'APP_BRAND_HEAD', 'APP_THEME_CSS'])(safeAccountRetryPath, '', '') as (request: Request) => Promise<Response>;
}

void test('the permission service failure page is a private-data-free retryable 503 without another auth read', async () => {
  const GET = handler();
  const response = await GET(new Request('https://site.example/service-unavailable?returnTo=' + encodeURIComponent('/health?days=30&note=<script>')));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Retry-After'), '3');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  const html = await response.text();
  assert.match(html, /暂时无法核对使用权限/);
  assert.match(html, /href="\/health\?days=30&amp;note=%3Cscript%3E"/);
  assert.doesNotMatch(html, /尚未获得使用权限|退出并更换账号|<script>|oai-authenticated|__JIASHU_PAGE_OWNER__/);
});

void test('untrusted retry destinations cannot leave the site or recurse into its auth and failure routes', async () => {
  const GET = handler();
  for (const path of ['https://evil.example', '//evil.example', '/service-unavailable', '/signin-with-chatgpt', '/api/data/backup', '/health/%2f%2fevil.example']) {
    const response = await GET(new Request('https://site.example/service-unavailable?returnTo=' + encodeURIComponent(path)));
    assert.equal(response.status, 503);
    assert.match(await response.text(), /href="\/">重试原页面/);
  }
});
