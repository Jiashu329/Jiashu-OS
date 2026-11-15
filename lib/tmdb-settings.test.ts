import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTMDBSettingsRevision, parseTMDBSettingsSave, readTMDBSettingsBody, TMDBSettingsRequestError } from './tmdb-settings.ts';
test('blank token preserves existing configuration, revisions and fields are strict and secrets are not echoed', () => {
  for (const token of ['', ' \n\t ', undefined]) assert.deepEqual(parseTMDBSettingsSave({ expectedRevision: 4, ...(token === undefined ? {} : { token }) }), { expectedRevision: 4 });
  assert.deepEqual(parseTMDBSettingsSave({ expectedRevision: 0, token: ' synthetic-private-token ' }), { expectedRevision: 0, token: 'synthetic-private-token' });
  for (const raw of [{ token: 'secret\nleak', expectedRevision: 0 }, { token: 's'.repeat(4097), expectedRevision: 0 }, { token: 1, expectedRevision: 0 }, { expectedRevision: -1 }, { expectedRevision: Number.MAX_SAFE_INTEGER }, { expectedRevision: 0, extra: 'private' }]) {
    assert.throws(() => parseTMDBSettingsSave(raw), error => { assert.ok(error instanceof TMDBSettingsRequestError); assert.ok(!JSON.stringify(error).includes('private')); return true; });
  }
  assert.throws(() => parseTMDBSettingsRevision({ expectedRevision: 1, token: 'private' }), TMDBSettingsRequestError);
  const getter = Object.defineProperty({}, 'token', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.throws(() => parseTMDBSettingsSave(getter), TMDBSettingsRequestError);
});
test('body reader bounds actual streamed UTF-8 bytes and rejects malformed input safely', async () => {
  const request = (body: BodyInit) => new Request('https://app.example/settings', { method: 'PUT', body });
  assert.deepEqual(await readTMDBSettingsBody(request('{"expectedRevision":0}')), { expectedRevision: 0 });
  await assert.rejects(readTMDBSettingsBody(request('secret malformed body')), TMDBSettingsRequestError);
  await assert.rejects(readTMDBSettingsBody(request('中'.repeat(3000))), error => { assert.ok(error instanceof TMDBSettingsRequestError); assert.equal(error.status, 413); return true; });
});
