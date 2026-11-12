import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessConfigurationError, AccessForbiddenError, AccessValidationError, assertAccessOwner, configuredAccessOwner, normalizeAccessEmail, parseAccessInvite, parseAccessOperationId, parseAccessStatus, presentAccessGrant } from './access-control.ts';

void test('email matching trims and lowercases without collapsing aliases or dots', () => {
  assert.equal(normalizeAccessEmail('  Member.Name+TAG@Example.COM  '), 'member.name+tag@example.com');
  assert.notEqual(normalizeAccessEmail('member+one@example.com'), normalizeAccessEmail('member@example.com'));
  assert.notEqual(normalizeAccessEmail('member.name@example.com'), normalizeAccessEmail('membername@example.com'));
  for (const value of ['', null, 'not an email', 'one@example.com\n', 'a@@example.com', '.member@example.com', 'member..name@example.com', 'member@-example.com', 'member@example..com', 'member@example.com<script>']) assert.throws(() => normalizeAccessEmail(value), AccessValidationError);
});
void test('an owner is exclusively a configured stable server identity and missing configuration never bootstraps a caller', () => {
  assert.equal(configuredAccessOwner('   '), null);
  assert.equal(configuredAccessOwner(undefined), null);
  assert.equal(assertAccessOwner('owner-stable-id', 'owner-stable-id'), 'owner-stable-id');
  assert.throws(() => assertAccessOwner('first-visitor', undefined), AccessConfigurationError);
  assert.throws(() => assertAccessOwner('member-stable-id', 'owner-stable-id'), AccessForbiddenError);
});
void test('invite and state payloads refuse client-supplied owners, roles and identity bindings', () => {
  assert.deepEqual(parseAccessInvite({ email: 'Member@Example.com' }), { email: 'member@example.com' });
  for (const field of ['ownerUserId', 'actorUserId', 'role', 'isOwner', 'boundUserId']) assert.throws(() => parseAccessInvite({ email: 'member@example.com', [field]: 'owner' }), AccessValidationError);
  assert.deepEqual(parseAccessStatus({ status: 'revoked', expectedRevision: 2 }), { status: 'revoked', expectedRevision: 2 });
  for (const value of [{ status: 'owner', expectedRevision: 1 }, { status: 'active', expectedRevision: 0 }, { status: 'active', expectedRevision: 1.5 }, { status: 'active', expectedRevision: 1, email: 'other@example.com' }, { status: 'active', expectedRevision: 1, boundUserId: 'replacement' }]) assert.throws(() => parseAccessStatus(value), AccessValidationError);
});
void test('operation identifiers require a canonical UUID and a public grant omits the bound stable ID', () => {
  assert.equal(parseAccessOperationId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.throws(() => parseAccessOperationId('arbitrary request'), AccessValidationError);
  const grant = presentAccessGrant({ id: 'a', email: 'member@example.com', boundUserId: 'private-stable-identity', status: 'active', revision: 1, createdAt: 'now', updatedAt: 'now', lastLoginAt: null });
  assert.equal(grant.bound, true);
  assert.equal(Object.hasOwn(grant, 'boundUserId'), false);
});
