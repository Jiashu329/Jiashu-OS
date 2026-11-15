import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInThisContext } from 'node:vm';
import test from 'node:test';

function fixture(local: boolean, identity: { email: string } | null) {
  const source = stripTypeScriptTypes(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const factory = runInThisContext('(function(env,getChatGPTIdentity,chatGPTSignInPath,chatGPTSignOutPath,APP_BRAND_HEAD){' + source + ';return GET;})') as (...bindings: unknown[]) => () => Promise<Response>;
  return factory({ SELFHOST_AUTH_PROVIDER: local ? 'local' : undefined }, async () => identity, () => '/signin-with-chatgpt', () => '/signout-with-chatgpt', '');
}

void test('local access denial offers email login and administrator activation guidance while Sites retains ChatGPT copy', async () => {
  const localAnonymous = await fixture(true, null)();
  assert.equal(localAnonymous.status, 403); assert.equal(localAnonymous.headers.get('Referrer-Policy'), 'same-origin');
  const localAnonymousHtml = await localAnonymous.text();
  assert.match(localAnonymousHtml, /使用邮箱和密码登录/); assert.match(localAnonymousHtml, /需要开通账户或重设密码时，请联系管理员/); assert.doesNotMatch(localAnonymousHtml, /ChatGPT/);
  const localDenied = await fixture(true, { email: '<img src=x>@example.com' })();
  const localDeniedHtml = await localDenied.text();
  assert.match(localDeniedHtml, /确认账户已开通并启用/); assert.match(localDeniedHtml, /&lt;img src=x&gt;@example.com/); assert.doesNotMatch(localDeniedHtml, /<img/);
  const sitesAnonymous = await fixture(false, null)(); assert.match(await sitesAnonymous.text(), /使用 ChatGPT 登录/); assert.equal(sitesAnonymous.headers.get('Referrer-Policy'), 'no-referrer');
  const sitesDenied = await fixture(false, { email: 'member@example.com' })(); assert.match(await sitesDenied.text(), /将这个邮箱加入使用名单/);
});
