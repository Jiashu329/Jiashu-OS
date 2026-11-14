import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, extensionPackage } from './package-douban-extension.mjs';

test('the authenticated extension download contains the exact static runtime and stable least-privilege identity', async () => {
  const result = await extensionPackage();
  assert.equal(result.extensionId, 'gbcgjkicjfbaakippafhhpadfkfifaeb');
  let offset = 0; const entries = [];
  while (result.archive.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(result.archive.readUInt16LE(offset + 8), 0, 'stored entries are deterministic across supported runtimes');
    const size = result.archive.readUInt32LE(offset + 18), nameLength = result.archive.readUInt16LE(offset + 26);
    const name = result.archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const bytes = result.archive.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
    assert.equal(crc32(bytes), result.archive.readUInt32LE(offset + 14));
    entries.push([name, bytes]); offset += 30 + nameLength + size;
  }
  assert.equal(result.archive.readUInt32LE(offset), 0x02014b50);
  assert.deepEqual(entries.map(([name]) => name), ['manifest.json', 'background.js', 'details-parser.js', 'collector-parser.js', 'collector.js', 'README.md']);
  for (let i = 0; i < entries.length; i++) assert.deepEqual(entries[i][1], result.files[i][1]);
  const manifest = JSON.parse(entries[0][1].toString('utf8'));
  assert.equal(manifest.permissions.includes('cookies'), false);
  assert.equal(manifest.permissions.includes('storage'), false);
  assert.equal(manifest.host_permissions.length, 3);
  assert.deepEqual((await extensionPackage()).archive, result.archive);
});
