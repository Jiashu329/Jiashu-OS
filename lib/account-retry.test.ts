import assert from 'node:assert/strict';
import test from 'node:test';
import { safeAccountRetryPath } from './account-retry.ts';

void test('permission-service retries preserve business routes and reject external, API and authentication loops', () => {
  for (const path of ['/', '/health?days=30', '/health/nutrition?date=2026-11-15#history', '/finance?ledger=family', '/life/douban', '/settings/access', '/sync/templates', '/connect-sleep']) {
    assert.equal(safeAccountRetryPath(path), path);
  }
  for (const path of [null, undefined, 10, '', 'https://evil.example/path', '//evil.example/path', '/\\evil.example', '/health\\evil', '/%2f%2fevil.example', '/health/%5c%5cevil', '/api/session', '/api/health', '/signin-with-chatgpt', '/signout-with-chatgpt', '/callback', '/access-denied', '/service-unavailable?returnTo=/service-unavailable', '/unknown', '/health\n/records', '/health/' + 'x'.repeat(2000)]) {
    assert.equal(safeAccountRetryPath(path), '/', String(path));
  }
});
