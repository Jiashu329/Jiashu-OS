import assert from 'node:assert/strict';
import test from 'node:test';
import { identityFromHeaders, pageAccountFailure } from './account-identity.ts';

void test('identity requires both platform headers and safely decodes display metadata', () => {
  assert.equal(identityFromHeaders(new Headers({ 'oai-authenticated-user-id': 'alice' })), null);
  const headers = new Headers({ 'oai-authenticated-user-id': 'alice', 'oai-authenticated-user-email': 'alice@example.test',
    'oai-authenticated-user-full-name': encodeURIComponent('测试用户'), 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8' });
  assert.equal(identityFromHeaders(headers)?.displayName, '测试用户');
  headers.set('oai-authenticated-user-full-name', '%broken');
  assert.equal(identityFromHeaders(headers)?.displayName, 'alice@example.test');
});

void test('all write methods reject an unbound page or a page belonging to the previous account', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(pageAccountFailure(new Request('https://site.example/api/new-route', { method }), 'bob')?.code, 'ACCOUNT_CHANGED');
    assert.equal(pageAccountFailure(new Request('https://site.example/api/new-route', { method, headers: { 'X-Page-Owner': 'alice' } }), 'bob')?.code, 'ACCOUNT_CHANGED');
    assert.equal(pageAccountFailure(new Request('https://site.example/api/new-route', { method, headers: { 'X-Page-Owner': 'bob' } }), 'bob'), null);
  }
  assert.equal(pageAccountFailure(new Request('https://site.example/api/health', { headers: { 'X-Page-Owner': 'alice' } }), 'bob')?.code, 'ACCOUNT_CHANGED');
  assert.equal(pageAccountFailure(new Request('https://site.example/api/health'), 'bob'), null);
});
