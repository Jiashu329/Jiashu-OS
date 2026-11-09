import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createSyncToken, hashSyncToken, isSyncToken } from './tokens.ts';

test('device credentials use the scoped prefix and 256-bit URL-safe random value', () => {
  const values = new Set(Array.from({ length: 64 }, () => createSyncToken()));
  assert.equal(values.size, 64);
  for (const value of values) {
    assert.equal(isSyncToken(value), true);
    assert.equal(Buffer.from(value.slice('jso_sync_'.length), 'base64url').byteLength, 32);
  }
});

test('malformed or unrelated platform credentials are not accepted as device keys', () => {
  for (const value of [null, undefined, '', 'Bearer something', 'jso_sync_short', 'jso_sync_' + 'A'.repeat(44), 'jso_sync_' + '+'.repeat(43)]) {
    assert.equal(isSyncToken(value), false);
  }
});

test('only the SHA-256 digest is suitable for storage', async () => {
  const value = createSyncToken();
  const digest = await hashSyncToken(value);
  assert.equal(digest, createHash('sha256').update(value).digest('hex'));
  assert.equal(digest.length, 64);
  assert.notEqual(digest, value);
  assert.equal(await hashSyncToken(value), digest);
});
