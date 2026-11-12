import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { resolveOwnerIdentity, type OwnerIdentityDatabase } from './owner-identity-store.ts';

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle', import.meta.url)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql); let args: SQLInputValue[] = [];
    const bound = { bind(...values: SQLInputValue[]) { args = values; return bound; },
      async first() { return statement.get(...args) ?? null; }, async run() { return statement.run(...args); } };
    return bound;
  } } as unknown as OwnerIdentityDatabase;
  return { db, sqlite };
}

void test('an arbitrary first visitor cannot claim owner and missing configuration stays closed', async (t) => {
  const { db, sqlite } = fixture(t);
  assert.equal(await resolveOwnerIdentity(db, { userId: 'visitor', email: 'visitor@example.test' }, {}), null);
  assert.equal(await resolveOwnerIdentity(db, { userId: 'visitor', email: 'visitor@example.test' }, { email: 'owner@example.test' }), null);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM app_owner_identity').get()?.total, 0);
});

void test('only the configured verified email bootstraps a Site-specific stable owner ID exactly once', async (t) => {
  const { db } = fixture(t);
  const config = { email: ' Owner@Example.test ' };
  assert.equal(await resolveOwnerIdentity(db, { userId: 'site-owner-alice', email: 'owner@example.test' }, config), 'site-owner-alice');
  assert.equal(await resolveOwnerIdentity(db, { userId: 'different-id', email: 'owner@example.test' }, config), 'site-owner-alice');
  assert.equal(await resolveOwnerIdentity(db, { userId: 'site-owner-alice', email: 'new-email@example.test' }, config), 'site-owner-alice');
  assert.equal(await resolveOwnerIdentity(db, { userId: 'visitor', email: 'visitor@example.test' }, config), 'site-owner-alice');
});

void test('an explicit valid Site identity works without storage and owner identity is excluded from business backups', async () => {
  assert.equal(await resolveOwnerIdentity(undefined, { userId: 'site-owner', email: 'owner@example.test' }, { userId: 'site-owner' }), 'site-owner');
  const { BACKUP_TABLE_NAMES } = await import('../lib/data-backup.ts');
  assert.equal(BACKUP_TABLE_NAMES.some((name: string) => name.startsWith('app_access_') || name === 'app_owner_identity'), false);
});
