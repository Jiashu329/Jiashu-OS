import assert from 'node:assert/strict';
import test from 'node:test';
import { AISettingsCryptoError, decryptAIKey, encryptAIKey, hasAISettingsEncryptionKey } from './ai-settings-crypto.ts';

const master = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)));
const otherMaster = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => 255 - index)));
const apiKey = 'sk-synthetic-minimax-private-key';

void test('only canonical standard base64 containing exactly 32 bytes enables encryption', () => {
  assert.equal(hasAISettingsEncryptionKey(master), true);
  assert.equal(hasAISettingsEncryptionKey(otherMaster), true);
  const zero = btoa(String.fromCharCode(...new Uint8Array(32)));
  for (const invalid of [undefined, '', 'plain-password', master + '\n', ' ' + master, master.slice(0, -1),
    btoa('x'.repeat(31)), btoa('x'.repeat(33)), otherMaster.replaceAll('/', '_').replaceAll('+', '-'),
    zero.slice(0, -2) + 'B=', master + '=']) {
    assert.equal(hasAISettingsEncryptionKey(invalid), false);
  }
});

void test('AES-GCM round-trips keys with a fresh 12-byte IV on every encryption', async () => {
  const first = await encryptAIKey(master, 'alice', apiKey);
  const second = await encryptAIKey(master, 'alice', apiKey);
  assert.equal(atob(first.iv).length, 12);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(await decryptAIKey(master, 'alice', first), apiKey);
  assert.equal(await decryptAIKey(master, 'alice', second), apiKey);
  assert.ok(!JSON.stringify(first).includes(apiKey));
  assert.ok(!JSON.stringify(first).includes(master));
});

void test('authenticated encryption rejects cross-user replacement, another master and modified ciphertext or IV', async () => {
  const encrypted = await encryptAIKey(master, 'alice', apiKey);
  const modified = (value: string) => (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
  for (const attempt of [
    () => decryptAIKey(master, 'bob', encrypted),
    () => decryptAIKey(otherMaster, 'alice', encrypted),
    () => decryptAIKey(master, 'alice', { ...encrypted, ciphertext: modified(encrypted.ciphertext) }),
    () => decryptAIKey(master, 'alice', { ...encrypted, iv: modified(encrypted.iv) }),
    () => decryptAIKey(master, 'alice', { ...encrypted, iv: btoa('short') }),
    () => decryptAIKey(master, 'alice', { ...encrypted, ciphertext: 'not base64' }),
  ]) {
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof AISettingsCryptoError);
      assert.equal(error.code, 'AI_SETTINGS_CRYPTO_UNAVAILABLE');
      assert.ok(!String(error).includes(apiKey));
      assert.ok(!String(error).includes(master));
      assert.ok(!String(error).includes(encrypted.ciphertext));
      return true;
    });
  }
});

void test('AAD binds the key to a versioned purpose as well as its owner', async () => {
  const encrypted = await encryptAIKey(master, 'alice', apiKey);
  const bytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', bytes(master), { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  for (const aad of ['alice', JSON.stringify(['another-purpose:v1', 'alice']), JSON.stringify(['jiashu-os:ai-user-settings:key:v2', 'alice'])]) {
    await assert.rejects(() => crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(encrypted.iv), additionalData: new TextEncoder().encode(aad), tagLength: 128 }, key, bytes(encrypted.ciphertext)));
  }
});

void test('invalid encryption inputs fail with the same safe error', async () => {
  for (const attempt of [
    () => encryptAIKey('PRIVATE_BAD_MASTER', 'alice', apiKey),
    () => encryptAIKey(master, '', apiKey),
    () => encryptAIKey(master, 'alice', ''),
    () => encryptAIKey(master, 'alice', 'x'.repeat(4097)),
  ]) await assert.rejects(attempt, AISettingsCryptoError);
  const longKey = 'x'.repeat(4096);
  assert.equal(await decryptAIKey(master, 'alice', await encryptAIKey(master, 'alice', longKey)), longKey);
});
