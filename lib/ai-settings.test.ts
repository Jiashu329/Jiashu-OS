import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AISettingsRequestError,
  parseAISettingsRevision,
  parseAISettingsSave,
  parseAISettingsTest,
  readAISettingsBody,
} from './ai-settings.ts';

const PRIVATE_VALUE = 'sk-private-settings-test-do-not-echo';
const save = (fields: Record<string, unknown> = {}) => ({ model: 'MiniMax-M3', region: 'cn', expectedRevision: 0, ...fields });
const request = (body: BodyInit | null, headers?: HeadersInit) => new Request('https://app.test/api/ai/settings', { method: 'POST', body, headers });
const failure = (status = 400) => (error: unknown) => {
  assert.ok(error instanceof AISettingsRequestError);
  assert.equal(error.code, 'INVALID_AI_SETTINGS');
  assert.equal(error.status, status);
  assert.doesNotMatch(error.message, new RegExp(PRIVATE_VALUE));
  assert.doesNotMatch(JSON.stringify(error), new RegExp(PRIVATE_VALUE));
  return true;
};

test('save trims model and a replacement key while preserving explicit region and revision', () => {
  assert.deepEqual(parseAISettingsSave(save({ model: ' MiniMax-M3.1-Flash ', apiKey: ' \t' + PRIVATE_VALUE + '\n', region: 'global', expectedRevision: 7 })), {
    apiKey: PRIVATE_VALUE, model: 'MiniMax-M3.1-Flash', region: 'global', expectedRevision: 7,
  });
  assert.deepEqual(parseAISettingsSave(save()), { model: 'MiniMax-M3', region: 'cn', expectedRevision: 0 });
  const boundary = 'MiniMax-' + 'M'.repeat(92);
  assert.equal(boundary.length, 100);
  assert.equal(parseAISettingsSave(save({ model: boundary, apiKey: 'a'.repeat(4096) })).apiKey?.length, 4096);
});

test('omitted and blank keys mean keep the current key rather than erase it', () => {
  for (const fields of [{}, { apiKey: '' }, { apiKey: ' \t\n ' }]) {
    const parsed = parseAISettingsSave(save(fields));
    assert.equal(Object.hasOwn(parsed, 'apiKey'), false);
  }
});

test('model names require the MiniMax prefix, safe characters and the length bound without echoing credentials', () => {
  for (const model of [undefined, null, 1, true, [], {}, '', ' ', 'MiniMax-', 'minimax-M3', 'sk-valid-looking-key', PRIVATE_VALUE, 'https://attacker.test/model', 'MiniMax-M3/other', 'MiniMax-M3:other', 'MiniMax-M3\n' + PRIVATE_VALUE, 'MiniMax-模型', 'MiniMax-' + 'M'.repeat(93)]) {
    assert.throws(() => parseAISettingsSave(save({ model })), failure());
  }
});

test('regions are exactly cn or global without case coercion or arbitrary URLs', () => {
  for (const region of [undefined, null, 0, true, 'CN', 'GLOBAL', ' cn ', '', 'us', 'https://attacker.test/' + PRIVATE_VALUE]) {
    assert.throws(() => parseAISettingsSave(save({ region })), failure());
  }
});

test('non-string, oversized or non-ASCII replacement keys fail without reflecting their values', () => {
  for (const apiKey of [undefined, null, true, 1, [], {}, PRIVATE_VALUE + 'a'.repeat(4097), PRIVATE_VALUE + '\nsecond-line', PRIVATE_VALUE + ' internal-space', PRIVATE_VALUE + '\0', PRIVATE_VALUE + '\x7f', PRIVATE_VALUE + '密钥']) {
    assert.throws(() => parseAISettingsSave(save({ apiKey })), failure());
  }
});

test('all three parsers require a nonnegative safe integer revision', () => {
  for (const expectedRevision of [undefined, null, true, '', '0', -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseAISettingsSave(save({ expectedRevision })), failure());
    assert.throws(() => parseAISettingsRevision({ expectedRevision }), failure());
    assert.throws(() => parseAISettingsTest({ expectedRevision, consent: true }), failure());
  }
  assert.deepEqual(parseAISettingsRevision({ expectedRevision: Number.MAX_SAFE_INTEGER }), { expectedRevision: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(parseAISettingsTest({ expectedRevision: 0, consent: true }), { expectedRevision: 0, consent: true });
});

test('connection tests require explicit boolean consent and accept no health-data payload', () => {
  for (const consent of [undefined, null, false, 'true', 1, [], {}]) {
    assert.throws(() => parseAISettingsTest({ expectedRevision: 0, consent }), failure());
  }
  assert.throws(() => parseAISettingsTest({ expectedRevision: 0, consent: true, context: { private: PRIVATE_VALUE } }), failure());
  assert.throws(() => parseAISettingsTest({ expectedRevision: 0, consent: true, question: PRIVATE_VALUE }), failure());
});

test('unknown properties, non-data objects and inherited values never bypass strict request shapes', () => {
  const parsers = [parseAISettingsSave, parseAISettingsRevision, parseAISettingsTest];
  for (const parse of parsers) {
    for (const raw of [undefined, null, true, 1, 'value', [], new Date(), { [PRIVATE_VALUE]: 0 }, Object.create({ expectedRevision: 0 }), { [Symbol('private')]: PRIVATE_VALUE }]) {
      assert.throws(() => parse(raw), failure());
    }
  }
  assert.throws(() => parseAISettingsSave({ ...save(), endpoint: 'https://attacker.test/' + PRIVATE_VALUE }), failure());
  assert.throws(() => parseAISettingsRevision({ expectedRevision: 0, apiKey: PRIVATE_VALUE }), failure());
  assert.throws(() => parseAISettingsTest({ expectedRevision: 0, consent: true, apiKey: PRIVATE_VALUE }), failure());
  assert.throws(() => parseAISettingsRevision(JSON.parse('{"expectedRevision":0,"__proto__":{"key":"' + PRIVATE_VALUE + '"}}')), failure());
  const nullPrototype = Object.assign(Object.create(null), { expectedRevision: 3 });
  assert.deepEqual(parseAISettingsRevision(nullPrototype), { expectedRevision: 3 });
});

test('validation never invokes getters or exposes errors from unusual objects', () => {
  let getterCalls = 0;
  const raw = { get expectedRevision() { getterCalls++; throw new Error(PRIVATE_VALUE); } };
  assert.throws(() => parseAISettingsRevision(raw), failure());
  assert.equal(getterCalls, 0);
  const proxy = new Proxy({}, { getPrototypeOf() { throw new Error(PRIVATE_VALUE); } });
  assert.throws(() => parseAISettingsRevision(proxy), failure());
});

test('body reading preserves valid JSON values and applies the exact 8 KiB byte boundary', async () => {
  assert.deepEqual(await readAISettingsBody(request(JSON.stringify(save()))), save());
  const body = JSON.stringify('a'.repeat(8190));
  assert.equal(new TextEncoder().encode(body).byteLength, 8192);
  assert.equal((await readAISettingsBody(request(body)) as string).length, 8190);
  await assert.rejects(readAISettingsBody(request(JSON.stringify('a'.repeat(8191)))), failure(413));
  assert.equal(await readAISettingsBody(request('null')), null);
  // Actual bytes are authoritative; a wrong header cannot relax or inflate the limit.
  assert.deepEqual(await readAISettingsBody(request('{"expectedRevision":0}', { 'Content-Length': '99999' })), { expectedRevision: 0 });
});

test('body limits count actual streamed UTF-8 bytes even with a misleading content-length', async () => {
  let cancelled = false;
  let pulls = 0;
  const chunk = new TextEncoder().encode('字'.repeat(1500));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const streamed = new Request('https://app.test/settings', { method: 'POST', body: stream, headers: { 'Content-Length': '1' }, duplex: 'half' } as RequestInit & { duplex: 'half' });
  await assert.rejects(readAISettingsBody(streamed), failure(413));
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3);
});

test('split multibyte UTF-8 chunks decode correctly without counting characters as bytes', async () => {
  const encoded = new TextEncoder().encode('{"label":"中文"}');
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < encoded.length) controller.enqueue(encoded.slice(offset, ++offset));
      else controller.close();
    },
  });
  const streamed = new Request('https://app.test/settings', { method: 'POST', body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
  assert.deepEqual(await readAISettingsBody(streamed), { label: '中文' });
});

test('empty, malformed, invalid UTF-8, consumed or failed request bodies produce safe 400 errors', async () => {
  for (const body of [null, '', '   ', '{"apiKey":"' + PRIVATE_VALUE + '"', new Uint8Array([0xff])]) {
    await assert.rejects(readAISettingsBody(request(body)), failure());
  }
  const consumed = request(JSON.stringify(save()));
  await consumed.text();
  await assert.rejects(readAISettingsBody(consumed), failure());
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(PRIVATE_VALUE)); } });
  const broken = new Request('https://app.test/settings', { method: 'POST', body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
  await assert.rejects(readAISettingsBody(broken), failure());
});
