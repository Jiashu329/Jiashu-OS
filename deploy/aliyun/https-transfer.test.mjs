import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { artifactParameters, safeDiagnostic, signedArtifactURL, transferArtifact, validateBlobURL } from './https-transfer.mjs';

const signedURL = 'https://productionresultssa0.blob.core.windows.net/actions-results/image.zip?sig=test-secret';
const parameters = { id: '123', digest: 'a'.repeat(64), repository: 'owner/repository', token: 'runner-only-token' };

void test('artifact API access is scoped to the exact artifact and never follows authenticated redirects', async () => {
  const result = await signedArtifactURL(parameters, async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/owner/repository/actions/artifacts/123/zip');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer runner-only-token');
    return { status: 302, headers: new Headers({ location: signedURL }) };
  });
  assert.equal(result, signedURL);
  await assert.rejects(signedArtifactURL(parameters, async () => ({ status: 403 })), error => {
    assert.deepEqual(error.diagnostic, { phase: 'api', code: 'http', status: 403 }); return true;
  });
  assert.deepEqual(artifactParameters({ ARTIFACT_ID: '123', ARTIFACT_DIGEST: `sha256:${parameters.digest}`, GITHUB_REPOSITORY: parameters.repository, GITHUB_TOKEN: parameters.token }), parameters);
  assert.throws(() => artifactParameters({ ARTIFACT_ID: '../123' }), /invalid/);
  for (const value of ['http://productionresultssa0.blob.core.windows.net/a', 'https://evil.test/a', 'https://productionresultssa0.blob.core.windows.net.evil.test/a', 'https://user:password@productionresultssa0.blob.core.windows.net/a', `${signedURL}\ncommand`, `${signedURL}#fragment`]) assert.throws(() => validateBlobURL(value));
});

void test('diagnostics expose only fixed phases, fixed error codes and bounded numbers', () => {
  assert.deepEqual(safeDiagnostic({ phase: 'network', code: 'http', status: 403 }), { phase: 'network', code: 'http', status: 403 });
  for (const value of [{ phase: signedURL, code: 'http' }, { phase: 'network', code: signedURL }, { phase: 'network', code: 'http', status: signedURL }, { phase: 'network', code: 'http', status: 403, url: signedURL }, { phase: 'ssh', code: 'process', exitCode: -1 }]) assert.equal(safeDiagnostic(value), null);
});

void test('probe prepares pinned SSH first and sends the signed URL only through stdin, then cleans up', async () => {
  const calls = [];
  let helperReady = false;
  const result = await transferArtifact({ probe: true, parameters }, {
    mask() {},
    async signedURL() { assert.equal(helperReady, true); return signedURL; },
    run(command, args, input) {
      calls.push({ command, args, input });
      assert.equal(JSON.stringify(args).includes('test-secret'), false);
      assert.equal(JSON.stringify(args).includes(parameters.token), false);
      if (command === 'bash') return '/runner/private-ssh-config';
      if (command === 'scp') { helperReady = true; return ''; }
      if (args.at(-1).startsWith('umask')) return '/tmp/jiashu-https-probe.ABC12345';
      if (args.at(-1).startsWith('rm')) return '';
      assert.equal(args.includes('/runner/private-ssh-config'), true);
      assert.deepEqual(JSON.parse(input), { url: signedURL, artifactDigest: parameters.digest });
      return JSON.stringify({ mode: 'probe', bytes: 262144, seconds: 0.5, bytesPerSecond: 524288 });
    },
  });
  assert.deepEqual(result, { mode: 'probe', bytes: 262144, seconds: 0.5, bytesPerSecond: 524288 });
  assert.match(calls.at(-1).args.at(-1), /^rm -rf -- '\/tmp\/jiashu-https-probe\.ABC12345'$/);
});

void test('download uses the caller private directory and does not pass any GitHub token to ECS', async () => {
  const calls = [];
  const result = await transferArtifact({ remoteDirectory: '/tmp/jiashu-release.ABC12345', sshConfig: '/runner/pinned-config', parameters }, {
    mask() {}, signedURL: async () => signedURL,
    run(command, args, input) {
      calls.push({ command, args, input });
      assert.equal(JSON.stringify({ args, input }).includes(parameters.token), false);
      return JSON.stringify({ mode: 'download', bytes: 12345, seconds: 1, bytesPerSecond: 12345, ignored: signedURL });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ssh');
  assert.equal(calls[0].args.at(-1), "python3 '/tmp/jiashu-release.ABC12345/fetch-artifact.py'");
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
  await assert.rejects(transferArtifact({ remoteDirectory: '/tmp/../etc', sshConfig: '/config', parameters }, { run() { throw new Error('must not run'); } }), /directory is invalid/);
});

void test('server helper rejects tampering, unsafe ZIP entries and HTTP redirects with real ZIP streams', () => {
  const result = spawnSync('python3', [new URL('./fetch-artifact.test.py', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
