import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import {
  createSyncConnection,
  findSyncConnection,
  listSyncConnections,
  revokeSyncConnection,
  type SyncConnectionDatabase,
  type SyncConnectionStatement,
} from './sync-connections.ts';

function fixture(t: TestContext): SyncConnectionDatabase {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0001_neat_zzzax.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values: SQLInputValue[] = [];
      const bound: SyncConnectionStatement = {
        bind(...parameters) { values = parameters as SQLInputValue[]; return bound; },
        async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
        async all<T>() { return { results: statement.all(...values) as T[] }; },
      };
      return bound;
    },
  };
}

test('the fourth and later connections can be created while old keys stay valid', async (t) => {
  const db = fixture(t);
  const ids: string[] = [];
  for (let index = 0; index < 7; index++) {
    const id = await createSyncConnection(db, 'owner', `Shortcut ${index}`, `hash-${index}`);
    assert.ok(id);
    ids.push(id);
  }
  assert.equal(new Set(ids).size, 7);
  for (let index = 0; index < ids.length; index++) {
    assert.equal(await findSyncConnection(db, 'owner', `hash-${index}`), ids[index]);
  }
  assert.equal((await listSyncConnections(db, 'owner')).length, 7);
});

test('all active connections remain manageable beyond the old 25-row limit', async (t) => {
  const db = fixture(t);
  const ids = new Set<string>();
  for (let index = 0; index < 32; index++) {
    const id = await createSyncConnection(db, 'owner', `Shortcut ${index}`, `hash-${index}`);
    assert.ok(id);
    ids.add(id);
  }
  const connections = await listSyncConnections(db, 'owner');
  assert.equal(connections.length, 32);
  assert.deepEqual(new Set(connections.map((row) => row.deviceId)), ids);
  assert.ok(connections.every((row) => row.revokedAt === null));
  assert.ok(connections.every((row) => !Object.hasOwn(row, 'tokenHash') && !Object.hasOwn(row, 'token_hash')));
});

test('connection lookup, listing and revocation stay isolated by owner', async (t) => {
  const db = fixture(t);
  const aliceId = await createSyncConnection(db, 'alice', 'Alice phone', 'alice-hash');
  const bobId = await createSyncConnection(db, 'bob', 'Bob phone', 'bob-hash');
  assert.ok(aliceId && bobId);
  assert.equal(await findSyncConnection(db, 'alice', 'bob-hash'), null);
  assert.equal(await findSyncConnection(db, 'bob', 'alice-hash'), null);
  assert.deepEqual((await listSyncConnections(db, 'alice')).map((row) => row.deviceId), [aliceId]);
  assert.deepEqual((await listSyncConnections(db, 'bob')).map((row) => row.deviceId), [bobId]);
  assert.equal(await revokeSyncConnection(db, 'alice', bobId), false);
  assert.equal(await findSyncConnection(db, 'bob', 'bob-hash'), bobId);
});

test('revoking one connection hides only that key without altering working shortcuts', async (t) => {
  const db = fixture(t);
  const firstId = await createSyncConnection(db, 'owner', 'Steps', 'steps-hash');
  const secondId = await createSyncConnection(db, 'owner', 'Sleep', 'sleep-hash');
  assert.ok(firstId && secondId);
  assert.equal(await revokeSyncConnection(db, 'owner', secondId), true);
  assert.equal(await findSyncConnection(db, 'owner', 'sleep-hash'), null);
  assert.equal(await findSyncConnection(db, 'owner', 'steps-hash'), firstId);
  const replacement = await createSyncConnection(db, 'owner', 'Sleep again', 'new-sleep-hash');
  assert.ok(replacement);
  assert.equal(await findSyncConnection(db, 'owner', 'steps-hash'), firstId);
  assert.deepEqual(new Set((await listSyncConnections(db, 'owner')).map((row) => row.deviceId)), new Set([firstId, replacement]));
});
