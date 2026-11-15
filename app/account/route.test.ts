import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInThisContext } from 'node:vm';
import test from 'node:test';

void test('account route requires ChatGPT authentication except for the empty signed-out receipt and binds authenticated HTML', async () => {
  const source = stripTypeScriptTypes(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), { mode: 'strip' }).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  let user: { userId: string } | null = { userId: 'alice' }; const required: string[] = [], bound: string[] = [];
  let options: { signInHref: string; signOutHref: string; authMode?: 'selfhost' } | undefined; const env: { SELFHOST_AUTH_PROVIDER?: 'local' } = {};
  const factory = runInThisContext('(function(getChatGPTUser,requireChatGPTUser,chatGPTSignInPath,chatGPTSignOutPath,renderAccountPage,withPageAccount,env){' + source + ';return GET;})') as (...values: unknown[]) => (request: Request) => Promise<Response>;
  const GET = factory(
    async () => user, async (path: string) => { required.push(path); if (!user) throw new Error('SIGN_IN_REQUIRED'); return user; },
    (path: string) => '/signin-with-chatgpt?return_to=' + encodeURIComponent(path), (path: string) => '/signout-with-chatgpt?return_to=' + encodeURIComponent(path),
    (value: typeof options) => { options = value; return '<html><head></head><body>Account</body></html>'; },
    (html: string, owner: string) => { bound.push(owner); return html.replace('<head>', '<head><meta name="synthetic-owner" content="' + owner + '">'); }, env,
  ) as (request: Request) => Promise<Response>;
  const response = await GET(new Request('https://account.example/account'));
  assert.deepEqual(required, ['/account']); assert.deepEqual(bound, ['alice']); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(await response.text(), /synthetic-owner/);
  assert.equal(options?.signOutHref, '/signout-with-chatgpt?return_to=%2Faccount%3FsignedOut%3D1');
  assert.equal(options?.signInHref, '/signin-with-chatgpt?return_to=%2Faccount');
  assert.equal(options?.authMode, undefined); env.SELFHOST_AUTH_PROVIDER = 'local'; await GET(new Request('https://account.example/account')); assert.equal(options?.authMode, 'selfhost'); bound.pop();
  user = null;
  const signedOut = await GET(new Request('https://account.example/account?signedOut=1'));
  assert.equal(signedOut.status, 200); assert.doesNotMatch(await signedOut.text(), /synthetic-owner/);
  assert.deepEqual(bound, ['alice']);
  await assert.rejects(GET(new Request('https://account.example/account')), /SIGN_IN_REQUIRED/);
});
