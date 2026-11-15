import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('./bootstrap-config.mjs', import.meta.url), 'utf8');
// Execute the actual bootstrap body with isolated filesystem/crypto dependencies.
// No /bootstrap path, environment secret or running service is accessed.
const bootstrap = compileFunction(`return (async () => {${source.replace(/^import [^\n]+\n/gm, '')}})();`,
  ['process', 'randomBytes', 'chmodSync', 'existsSync', 'writeFileSync', 'hashPassword']);

async function fixture(existing = false) {
  const files = new Map(existing ? [['/bootstrap/app.env', 'existing private environment'], ['/bootstrap/initial-login.txt', 'existing legacy login file']] : []);
  const writes = [], permissions = [];
  let stdout = '';
  const email = 'initial-admin@example.test';
  await bootstrap(
    { env: { BOOTSTRAP_PUBLIC_ORIGIN: 'https://example.test', BOOTSTRAP_OWNER_EMAIL: email }, stdout: { write(value) { stdout += value; } } },
    length => Buffer.alloc(length, 7),
    (path, mode) => permissions.push({ path, mode }),
    path => files.has(path),
    (path, value, options) => { assert.equal(files.has(path), false); files.set(path, value); writes.push({ path, options }); },
    async () => 'controlled-test-password-hash',
  );
  return { files, writes, permissions, stdout, email };
}

void test('new private login files show the configured email and retain legacy username fields without logging credentials', async () => {
  const result = await fixture();
  const login = result.files.get('/bootstrap/initial-login.txt');
  assert.match(login, /^Public origin: https:\/\/example\.test$/m);
  assert.match(login, /^Username: admin$/m);
  assert.equal(login.split('\n').filter(line => line.startsWith('Email: '))[0], `Email: ${result.email}`);
  const password = /^Initial password: (.+)$/m.exec(login)?.[1];
  assert.ok(password && password.length >= 12);
  assert.equal(result.stdout.includes(password), false);
  assert.equal(result.stdout.includes('controlled-test-password-hash'), false);
  assert.equal(result.stdout.includes(result.email), false);
  assert.match(result.files.get('/bootstrap/app.env'), /APP_OWNER_EMAIL='initial-admin@example\.test'/);
  assert.deepEqual(result.writes.map(row => row.options), [{ mode: 0o600, flag: 'wx' }, { mode: 0o600, flag: 'wx' }]);
});

void test('existing server environment and legacy credential file remain byte-for-byte unchanged', async () => {
  const result = await fixture(true);
  assert.equal(result.files.get('/bootstrap/app.env'), 'existing private environment');
  assert.equal(result.files.get('/bootstrap/initial-login.txt'), 'existing legacy login file');
  assert.deepEqual(result.writes, []);
  assert.deepEqual(result.permissions, [{ path: '/bootstrap/app.env', mode: 0o600 }]);
});
