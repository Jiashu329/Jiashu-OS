import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SOURCE_EXPORT_URL = 'https://jiashu-life-os-health.jiashuh329.chatgpt.site/_migration/owner-export';
export const MAX_EXPORT_BYTES = 48 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const identity = Object.freeze({ format: 'jiashu-owner-migration-v1', migrationId: 'jiashu-owner-20261116-v1',
  sourceProjectId: 'appgprj_6af116465b5c8191ab7a2b62d4645f0f',
  sourceOwnerId: 'y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap', targetOwnerId: 'treefund-test-owner' });
const knownSourceCodes = new Set(['OWNER_MIGRATION_EXPORT_UNAVAILABLE']);
const knownSourcePhases = new Set(['request', 'destination_key', 'snapshot', 'seal']);

export class OwnerExportRelayError extends Error {
  constructor(phase, code, details = {}) {
    super('Owner export relay failed.');
    this.name = 'OwnerExportRelayError';
    this.diagnostic = { ok: false, phase, code, ...details };
  }
}
const fail = (phase, code, details) => { throw new OwnerExportRelayError(phase, code, details); };
function exact(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === names.slice().sort().join(',');
}
export function validateRelayRequest(value) {
  if (!exact(value, ['sourceBearer', 'transferSecret']) || typeof value.sourceBearer !== 'string'
    || !/^[\x21-\x7e]{16,4096}$/.test(value.sourceBearer) || typeof value.transferSecret !== 'string'
    || !/^[A-Za-z0-9_-]{43,128}$/.test(value.transferSecret)) fail('input', 'INVALID_REQUEST');
  return value;
}
function canonicalBase64(value, maximum, size) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maximum / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length <= maximum && (size === undefined ? bytes.length >= 17 : bytes.length === size) && bytes.toString('base64') === value;
}
export function validateOwnerExportEnvelope(value) {
  if (!exact(value, ['header', 'wrappedKey', 'iv', 'ciphertext'])
    || !exact(value.header, [...Object.keys(identity), 'keyFingerprint'])
    || typeof value.header.keyFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.header.keyFingerprint)
    || JSON.stringify(value.header) !== JSON.stringify({ ...identity, keyFingerprint: value.header.keyFingerprint })
    || !canonicalBase64(value.wrappedKey, 384, 384) || !canonicalBase64(value.iv, 12, 12)
    || !canonicalBase64(value.ciphertext, MAX_EXPORT_BYTES)) fail('envelope', 'INVALID_ENVELOPE');
  return value;
}
async function boundedBytes(stream, maximum, phase, strictMaximum = false) {
  const chunks = []; let size = 0;
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') fail(phase, 'INVALID_BODY');
  try {
    for await (const part of stream) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (strictMaximum ? size >= maximum : size > maximum) fail(phase, 'BODY_TOO_LARGE');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof OwnerExportRelayError) throw error;
    fail(phase, 'BODY_UNAVAILABLE');
  }
}
function parseJSON(bytes, phase) {
  try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
  catch { fail(phase, 'INVALID_JSON'); }
}
async function sourceFailure(response) {
  const details = {};
  if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) details.status = response.status;
  // Error text can contain URLs or secrets. Only this closed source vocabulary
  // may cross the stderr boundary; never propagate error.message or raw HTML.
  try {
    const body = parseJSON(await boundedBytes(response.body, 8192, 'source'), 'source');
    if (knownSourceCodes.has(body?.code)) details.sourceCode = body.code;
    if (knownSourcePhases.has(body?.phase)) details.sourcePhase = body.phase;
  } catch { /* Keep the HTTP status when an error body is large or non-JSON. */ }
  fail('source', 'SOURCE_HTTP', details);
}

/** Credentials live only in memory. Returned data is still sealed for the ECS. */
export async function relayOwnerExport({ input = process.stdin, fetchAPI = fetch, timeoutMs = 90_000 } = {}) {
  let request;
  try { request = validateRelayRequest(parseJSON(await boundedBytes(input, MAX_REQUEST_BYTES, 'input', true), 'input')); }
  catch (error) { if (error instanceof OwnerExportRelayError) throw error; fail('input', 'INVALID_REQUEST'); }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchAPI(SOURCE_EXPORT_URL, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'OAI-Sites-Authorization': 'Bearer ' + request.sourceBearer, Authorization: 'Bearer ' + request.transferSecret,
          'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity' }, body: '{}' });
    } catch (error) {
      fail('source', controller.signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name) ? 'SOURCE_TIMEOUT' : 'SOURCE_NETWORK');
    }
    if (response.status !== 200) await sourceFailure(response);
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('envelope', 'INVALID_CONTENT_TYPE');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_EXPORT_BYTES)) fail('envelope', 'BODY_TOO_LARGE');
    const envelope = parseJSON(await boundedBytes(response.body, MAX_EXPORT_BYTES, 'envelope'), 'envelope');
    return validateOwnerExportEnvelope(envelope);
  } catch (error) {
    if (controller.signal.aborted) fail('source', 'SOURCE_TIMEOUT');
    if (error instanceof OwnerExportRelayError) throw error;
    fail('source', 'SOURCE_UNAVAILABLE');
  } finally { clearTimeout(timer); controller.abort(); request = undefined; }
}

export async function runOwnerExportRelay(options = {}) {
  const envelope = await relayOwnerExport(options);
  try { await pipeline(Readable.from([JSON.stringify(envelope) + '\n']), options.output ?? process.stdout); }
  catch { fail('output', 'OUTPUT_UNAVAILABLE'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) fail('input', 'INVALID_ARGUMENTS');
    await runOwnerExportRelay();
  } catch (error) {
    const diagnostic = error instanceof OwnerExportRelayError ? error.diagnostic : { ok: false, phase: 'relay', code: 'RELAY_FAILED' };
    process.stderr.write(JSON.stringify(diagnostic) + '\n'); process.exitCode = 1;
  }
}
