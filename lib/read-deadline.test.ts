import assert from 'node:assert/strict';
import test from 'node:test';
import { readWithDeadline } from './read-deadline.ts';

test('bounded reads return successful data, preserve failures, and reject hung operations', async () => {
  assert.equal(await readWithDeadline(Promise.resolve(42), 50), 42);
  const failure = new Error('synthetic failure');
  await assert.rejects(readWithDeadline(Promise.reject(failure), 50), (error) => error === failure);
  await assert.rejects(readWithDeadline(new Promise(() => {}), 10), /READ_DEADLINE_EXCEEDED/);
});
