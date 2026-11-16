import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import readline from 'node:readline/promises';

const rl = readline.createInterface({ input: process.stdin });
process.stdout.write('Ready for private transfer request on hidden stdin.\n');
const request = JSON.parse(await rl.question('')); rl.close();
const publicKey = createPublicKey(request.publicKey);
if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails?.modulusLength !== 3072
  || typeof request.sourceBearer !== 'string' || typeof request.transferSecret !== 'string') throw new Error('Invalid transfer request');
const keyFingerprint = createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
const header = { format: 'jiashu-migration-request-v1', migrationId: 'jiashu-owner-20261116-v1',
  sourceProjectId: 'appgprj_6af116465b5c8191ab7a2b62d4645f0f',
  sourceOwnerId: 'y14x9HXn9E8I8zpGRCvNTur8iFO3LTptBeNGDPLF0xsRXRsGnZ7Uap', targetOwnerId: 'treefund-test-owner', keyFingerprint };
const key = randomBytes(32), iv = randomBytes(12);
const plaintext = Buffer.from(JSON.stringify({ sourceBearer: request.sourceBearer, transferSecret: request.transferSecret }));
try {
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const envelope = { header, wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
    iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') };
  const file = '/tmp/jiashu-owner-migration-dispatch.json';
  const input = { operation: 'migration-fetch-plan', expected_app_commit: '65285905bc2738f57576e97f76ce8f8ea240321a', migration_request: JSON.stringify(envelope) };
  writeFileSync(file, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ file, keyFingerprint, encryptedRequestBytes: Buffer.byteLength(input.migration_request) }) + '\n');
} finally { key.fill(0); plaintext.fill(0); }
