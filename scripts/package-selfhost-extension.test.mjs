import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, extensionPackage } from './package-douban-extension.mjs';
import { DEFAULT_SELFHOST_ORIGIN, SELFHOST_EXTENSION_VERSION, SITES_ORIGIN, selfhostExtensionPackage } from './package-selfhost-extension.mjs';

let packagePromise;
function packaged() { return packagePromise ??= selfhostExtensionPackage(); }
async function controller() {
  const result = await packaged();
  const files = new Map(result.files);
  const parserUrl = 'data:text/javascript;base64,' + files.get('details-parser.js').toString('base64');
  const background = files.get('background.js').toString('utf8').replace("'./details-parser.js'", JSON.stringify(parserUrl));
  const backgroundModule = await import('data:text/javascript;base64,' + Buffer.from(background).toString('base64'));
  return backgroundModule.createDoubanExtensionController({}, {
    randomUUID: () => '00000000-0000-4000-8000-000000000002',
    readSubject: async () => ({ kind: 'movie', coverUrl: null, details: {} }),
  });
}
const request = { type: 'JIASHU_DOUBAN', version: 1, action: 'CONNECT', ownerKey: '00000000-0000-4000-8000-000000000001', profileId: 'test-owner' };
const sender = (origin = DEFAULT_SELFHOST_ORIGIN) => ({ tab: { id: 8 }, frameId: 0, url: origin + '/life/douban' });

void test('self-host ZIP keeps the reviewed runtime, fixed identity, and exact two-site permissions', async () => {
  const result = await packaged();
  const stock = await extensionPackage();
  assert.equal(result.extensionId, stock.extensionId);
  assert.deepEqual(result.origins, [SITES_ORIGIN, DEFAULT_SELFHOST_ORIGIN]);
  const entries = [];
  let offset = 0;
  while (result.archive.readUInt32LE(offset) === 0x04034b50) {
    const size = result.archive.readUInt32LE(offset + 18), nameLength = result.archive.readUInt16LE(offset + 26);
    const name = result.archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const bytes = result.archive.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
    assert.equal(crc32(bytes), result.archive.readUInt32LE(offset + 14));
    entries.push([name, bytes]); offset += 30 + nameLength + size;
  }
  assert.deepEqual(entries, result.files);
  assert.deepEqual(result.files.map(([name]) => name), stock.files.map(([name]) => name));
  const files = new Map(result.files), originals = new Map(stock.files);
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  const original = JSON.parse(originals.get('manifest.json').toString('utf8'));
  assert.equal(manifest.version, SELFHOST_EXTENSION_VERSION);
  assert.deepEqual(manifest.externally_connectable.matches, [SITES_ORIGIN + '/*', DEFAULT_SELFHOST_ORIGIN + '/*']);
  assert.deepEqual({ ...manifest, version: original.version, externally_connectable: original.externally_connectable }, original);
  for (const name of ['collector.js', 'collector-parser.js', 'details-parser.js']) assert.deepEqual(files.get(name), originals.get(name));
  assert.deepEqual((await selfhostExtensionPackage()).archive, result.archive);
  assert.equal(result.output.includes(result.archive.toString('base64')), true);
  // extensionPackage() also verifies the checked-in ZIP still matches stock files.
  assert.deepEqual((await extensionPackage()).archive, stock.archive);
});

void test('packaged worker accepts the two exact Douban application pages and rejects foreign senders', async () => {
  const runtime = await controller();
  for (const origin of [SITES_ORIGIN, DEFAULT_SELFHOST_ORIGIN]) {
    const response = await runtime.handle(request, sender(origin));
    assert.equal(response.ok, true);
    assert.equal(response.data.extensionVersion, SELFHOST_EXTENSION_VERSION);
  }
  for (const url of [
    'https://treefund.asia/life/douban', 'https://www.treefund.asia.attacker.example/life/douban',
    'http://www.treefund.asia/life/douban', 'https://www.treefund.asia:8443/life/douban',
    'https://user:password@www.treefund.asia/life/douban', 'https://www.treefund.asia/life/douban/',
    'https://www.treefund.asia/life/other', 'not a URL',
  ]) assert.equal((await runtime.handle(request, { ...sender(), url })).error.code, 'FORBIDDEN');
  for (const extra of [{ frameId: 2 }, { tab: { id: -1 } }, { tab: { id: '8' } }, { tab: undefined }]) {
    assert.equal((await runtime.handle(request, { ...sender(), ...extra })).error.code, 'FORBIDDEN');
  }
});

void test('two allowed origins cannot inspect, cancel, or replace each other’s active run in the same tab', async () => {
  const runtime = await controller();
  const started = await runtime.handle({ ...request, action: 'START', domains: ['screen'] }, sender());
  assert.equal(started.ok, true);
  const runId = started.data.runId;
  assert.equal((await runtime.handle({ ...request, action: 'POLL', runId }, sender())).ok, true);
  for (const action of ['POLL', 'CANCEL']) {
    assert.equal((await runtime.handle({ ...request, action, runId }, sender(SITES_ORIGIN))).error.code, 'RUN_NOT_FOUND');
  }
  assert.equal((await runtime.handle({ ...request, action: 'START', ownerKey: '00000000-0000-4000-8000-000000000003' }, sender(SITES_ORIGIN))).error.code, 'RUN_BUSY');
  assert.equal((await runtime.handle({ ...request, action: 'POLL', runId }, sender())).ok, true);
  for (const extra of [{ tab: { id: 9 } }, {}]) {
    const message = { ...request, action: 'POLL', runId, ...(Object.keys(extra).length ? {} : { ownerKey: '00000000-0000-4000-8000-000000000003' }) };
    assert.equal((await runtime.handle(message, { ...sender(), ...extra })).error.code, 'RUN_NOT_FOUND');
  }
});

void test('subject metadata responses are bound to the originating allowed site', async () => {
  const runtime = await controller();
  const message = { ...request, action: 'SUBJECT', requestId: '00000000-0000-4000-8000-000000000004', domain: 'screen', subjectId: '1292052' };
  assert.equal((await runtime.handle(message, sender())).ok, true);
  assert.equal((await runtime.handle(message, sender(SITES_ORIGIN))).error.code, 'RUN_NOT_FOUND');
  assert.equal((await runtime.handle({ ...request, action: 'SUBJECT_CANCEL', requestId: message.requestId }, sender(SITES_ORIGIN))).error.code, 'RUN_NOT_FOUND');
  assert.equal((await runtime.handle(message, sender())).ok, true);
});

void test('generation supports an exact HTTPS origin and writes only the selected generated module', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'selfhost-extension-'));
  try {
    const outputPath = join(temporary, 'generated.ts');
    const result = await selfhostExtensionPackage({ origin: 'https://test.example:8443/', outputPath, write: true });
    assert.deepEqual(result.origins, [SITES_ORIGIN, 'https://test.example:8443']);
    assert.equal(await readFile(outputPath, 'utf8'), result.output);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  for (const origin of ['http://test.example', 'https://*.example', 'https://test.example/subpath',
    'https://test.example/?query=1', 'https://test.example/#fragment', 'https://user@www.treefund.asia', 'https://www.treefund.asia\n', null]) {
    await assert.rejects(selfhostExtensionPackage({ origin }), /HTTPS origin/);
  }
});
