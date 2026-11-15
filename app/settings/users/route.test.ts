import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInThisContext } from 'node:vm';
import test from 'node:test';

function fixture(provider?: string, isOwner = true) {
  const source = stripTypeScriptTypes(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const required: string[] = [], rendered: string[] = [], bound: string[] = [];
  const bindings = {
    env: { SELFHOST_AUTH_PROVIDER: provider },
    async requireChatGPTUser(path: string) { required.push(path); return { userId: 'local-admin', isOwner }; },
    renderUsersSettingsPage(owner: string) { rendered.push(owner); return '<html><head></head><body>Users</body></html>'; },
    withPageAccount(html: string, owner: string) { bound.push(owner); return html; },
  };
  const factory = runInThisContext('(function(' + Object.keys(bindings).join(',') + '){' + source + '\nreturn GET;})') as (...values: unknown[]) => () => Promise<Response>;
  const get = factory(...Object.values(bindings));
  return { get, required, rendered, bound };
}

void test('user management exists only on local authentication and authorizes the owner before rendering', async () => {
  for (const provider of [undefined, 'sites', 'unexpected']) {
    const f = fixture(provider), response = await f.get();
    assert.equal(response.status, 404); assert.deepEqual(f.required, []); assert.deepEqual(f.rendered, []);
  }
  const member = fixture('local', false), denied = await member.get();
  assert.equal(denied.status, 403); assert.deepEqual(member.required, ['/settings/users']); assert.deepEqual(member.rendered, []); assert.deepEqual(member.bound, []);
  const admin = fixture('local'), response = await admin.get();
  assert.equal(response.status, 200); assert.deepEqual(admin.rendered, ['local-admin']); assert.deepEqual(admin.bound, ['local-admin']);
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('Referrer-Policy'), 'same-origin');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});
