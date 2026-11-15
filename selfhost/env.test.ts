import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

void test('env imports are inert, settings stay runtime-bound, and bundled copies share one DB', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'selfhost-env-'));
  const path = join(directory, 'app.sqlite3');
  const previous = { path: process.env.SELFHOST_DB_PATH, owner: process.env.APP_OWNER_USER_ID };
  process.env.SELFHOST_DB_PATH = path;
  try {
    const runtimeEnv = await import('./env.ts');
    const duplicateModuleURL = new URL('./env.ts?second-module-copy', import.meta.url).href;
    const duplicate = await import(duplicateModuleURL);
    assert.equal(existsSync(path), false);
    assert.equal(runtimeEnv.readSelfhostReadiness().schemaReady, false);
    assert.equal(existsSync(path), false);
    process.env.APP_OWNER_USER_ID = 'test-owner-runtime';
    assert.equal(runtimeEnv.env.APP_OWNER_USER_ID, 'test-owner-runtime');
    process.env.APP_OWNER_USER_ID = 'changed-owner-runtime';
    assert.equal(runtimeEnv.env.APP_OWNER_USER_ID, 'changed-owner-runtime');
    assert.equal(runtimeEnv.env.SELFHOST_AUTH_PROVIDER, 'local');
    const db = runtimeEnv.env.DB;
    assert.equal(duplicate.env.DB, db);
    assert.equal(existsSync(path), true);
    duplicate.closeSelfhostDatabase();
    assert.throws(() => db.prepare('SELECT 1'), /closed/);
    runtimeEnv.closeSelfhostDatabase();
  } finally {
    if (previous.path === undefined) delete process.env.SELFHOST_DB_PATH;
    else process.env.SELFHOST_DB_PATH = previous.path;
    if (previous.owner === undefined) delete process.env.APP_OWNER_USER_ID;
    else process.env.APP_OWNER_USER_ID = previous.owner;
    rmSync(directory, { recursive: true, force: true });
  }
});
