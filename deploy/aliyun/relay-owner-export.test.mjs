import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { MAX_EXPORT_BYTES, OwnerExportRelayError, relayOwnerExport, runOwnerExportRelay, SOURCE_EXPORT_URL,
  validateOwnerExportEnvelope, validateRelayRequest } from './relay-owner-export.mjs';

const credentials = { sourceBearer: 'synthetic-source-bearer-private-value', transferSecret: 'q'.repeat(43) };
const header = { format: 'jiashu-owner-migration-v1', migrationId: 'jiashu-owner-20261116-v1',
  sourceProjectId: 'appgprj_6af116465b5c8191ab7a2b62d4645f0f',
  sourceOwnerId: 'y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap', targetOwnerId: 'treefund-test-owner', keyFingerprint: 'a'.repeat(64) };
const envelope = { header, wrappedKey: Buffer.alloc(384, 4).toString('base64'), iv: Buffer.alloc(12, 5).toString('base64'), ciphertext: Buffer.alloc(64, 6).toString('base64') };
const input = value => Readable.from([JSON.stringify(value)]);
const response = (value = envelope, options = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, ...options });
const diagnostic = (code, detail = {}) => error => {
  assert.ok(error instanceof OwnerExportRelayError);
  assert.equal(error.diagnostic.code, code);
  for (const [key, value] of Object.entries(detail)) assert.equal(error.diagnostic[key], value);
  assert.equal(JSON.stringify(error).includes(credentials.sourceBearer), false);
  assert.equal(JSON.stringify(error).includes(credentials.transferSecret), false);
  return true;
};

void test('relay posts credentials only to the fixed HTTPS source, rejects redirects and emits only the sealed envelope', async () => {
  let stdout = '', calls = 0;
  const output = new Writable({ write(chunk, _encoding, done) { stdout += chunk.toString(); done(); } });
  await runOwnerExportRelay({ input: input(credentials), output, fetchAPI: async (url, options) => {
    calls++; assert.equal(url, SOURCE_EXPORT_URL); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['OAI-Sites-Authorization'], 'Bearer ' + credentials.sourceBearer);
    assert.equal(options.headers.Authorization, 'Bearer ' + credentials.transferSecret);
    assert.equal(options.headers['Content-Type'], 'application/json'); assert.equal(options.body, '{}');
    assert.ok(options.signal instanceof AbortSignal); return response();
  } });
  assert.equal(calls, 1); assert.equal(stdout, JSON.stringify(envelope) + '\n');
  for (const secret of Object.values(credentials)) assert.equal(stdout.includes(secret), false);
});

void test('request schema rejects unsafe credential bytes, extra fields, invalid UTF8 and oversized stdin before network', async () => {
  for (const value of [{}, { ...credentials, url: 'https://evil.test' }, { ...credentials, sourceBearer: 'short' },
    { ...credentials, sourceBearer: credentials.sourceBearer + '\n' }, { ...credentials, transferSecret: 'invalid' }]) {
    assert.throws(() => validateRelayRequest(value), diagnostic('INVALID_REQUEST'));
  }
  for (const stream of [Readable.from([Buffer.from([0xff])]), Readable.from(['x'.repeat(16 * 1024)])]) {
    let called = false;
    await assert.rejects(relayOwnerExport({ input: stream, fetchAPI: async () => { called = true; throw new Error(); } }), error => error instanceof OwnerExportRelayError);
    assert.equal(called, false);
  }
});

void test('every fixed header field, canonical base64, RSA wrapped-key size and nonce size is validated without decrypting data', () => {
  assert.equal(validateOwnerExportEnvelope(envelope), envelope);
  for (const field of Object.keys(header)) {
    assert.throws(() => validateOwnerExportEnvelope({ ...envelope, header: { ...header, [field]: 'wrong' } }), diagnostic('INVALID_ENVELOPE'));
  }
  for (const value of [{ ...envelope, plaintext: 'private text' }, { ...envelope, header: { ...header, unknown: true } },
    { ...envelope, wrappedKey: Buffer.alloc(256).toString('base64') }, { ...envelope, iv: Buffer.alloc(11).toString('base64') },
    { ...envelope, ciphertext: Buffer.alloc(16).toString('base64') }, { ...envelope, ciphertext: envelope.ciphertext.replaceAll('=', '') },
    { ...envelope, ciphertext: envelope.ciphertext + '\n' }]) assert.throws(() => validateOwnerExportEnvelope(value), diagnostic('INVALID_ENVELOPE'));
});

void test('HTTP errors expose only the status and closed source diagnostic codes/phases', async () => {
  await assert.rejects(relayOwnerExport({ input: input(credentials), fetchAPI: async () => response({ error: credentials.sourceBearer,
    code: 'OWNER_MIGRATION_EXPORT_UNAVAILABLE', phase: 'snapshot' }, { status: 503 }) }), diagnostic('SOURCE_HTTP', {
    status: 503, sourceCode: 'OWNER_MIGRATION_EXPORT_UNAVAILABLE', sourcePhase: 'snapshot',
  }));
  await assert.rejects(relayOwnerExport({ input: input(credentials), fetchAPI: async () => response({ error: credentials.transferSecret,
    code: credentials.sourceBearer, phase: credentials.transferSecret }, { status: 403 }) }), error => {
    diagnostic('SOURCE_HTTP', { status: 403 })(error);
    assert.deepEqual(Object.keys(error.diagnostic).sort(), ['code', 'ok', 'phase', 'status']); return true;
  });
  await assert.rejects(relayOwnerExport({ input: input(credentials), fetchAPI: async () => new Response(credentials.sourceBearer + 'x'.repeat(9000), {
    status: 403, headers: { 'Content-Type': 'text/html' },
  }) }), diagnostic('SOURCE_HTTP', { status: 403 }));
});

void test('non-JSON success, malformed envelopes, redirects and network errors never leak response bodies or URLs', async () => {
  for (const fake of [new Response(credentials.sourceBearer, { headers: { 'Content-Type': 'text/html' } }), response({ plaintext: credentials.transferSecret }),
    new Response(credentials.sourceBearer, { headers: { 'Content-Type': 'application/json' } })]) {
    await assert.rejects(relayOwnerExport({ input: input(credentials), fetchAPI: async () => fake }), error => {
      assert.ok(error instanceof OwnerExportRelayError); assert.equal(JSON.stringify(error).includes(credentials.sourceBearer), false); return true;
    });
  }
  await assert.rejects(relayOwnerExport({ input: input(credentials), fetchAPI: async () => new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }) }), diagnostic('SOURCE_HTTP', { status: 302 }));
  await assert.rejects(relayOwnerExport({ input: input(credentials), fetchAPI: async () => { throw new Error('private https://example.test/?token=' + credentials.sourceBearer); } }), diagnostic('SOURCE_NETWORK'));
});

void test('declared and streamed response size limits are enforced before ciphertext reaches stdout', async () => {
  await assert.rejects(relayOwnerExport({ input: input(credentials), fetchAPI: async () => response(envelope, {
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_EXPORT_BYTES + 1) },
  }) }), diagnostic('BODY_TOO_LARGE'));
  let stdout = '', cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_EXPORT_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(runOwnerExportRelay({ input: input(credentials), output: new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } }),
    fetchAPI: async () => ({ status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), body }) }), diagnostic('BODY_TOO_LARGE'));
  assert.equal(stdout, ''); assert.equal(cancelled, true);
});

void test('fetch deadline aborts and exposes only a timeout code', async () => {
  await assert.rejects(relayOwnerExport({ input: input(credentials), timeoutMs: 5, fetchAPI: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('private credential ' + credentials.sourceBearer)), { once: true });
  }) }), diagnostic('SOURCE_TIMEOUT'));
});

void test('rejecting a response before reading its body still cancels the fetch connection', async () => {
  let signal;
  await assert.rejects(relayOwnerExport({ input: input(credentials), fetchAPI: async (_url, options) => {
    signal = options.signal;
    return new Response('untrusted body', { headers: { 'Content-Type': 'text/html' } });
  } }), diagnostic('INVALID_CONTENT_TYPE'));
  assert.equal(signal.aborted, true);
});

void test('CLI rejects arguments or invalid stdin with empty stdout and safe JSON-only stderr', () => {
  for (const args of [[], ['unexpected']]) {
    const result = spawnSync(process.execPath, [new URL('./relay-owner-export.mjs', import.meta.url).pathname, ...args], {
      input: JSON.stringify({ ...credentials, unexpected: credentials.sourceBearer }), encoding: 'utf8',
    });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    const failure = JSON.parse(result.stderr); assert.equal(failure.ok, false);
    assert.equal(result.stderr.includes(credentials.sourceBearer), false); assert.equal(result.stderr.includes(credentials.transferSecret), false);
  }
});
