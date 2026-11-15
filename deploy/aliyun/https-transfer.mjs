import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const remotePattern = /^\/tmp\/jiashu-(?:release|https-probe)\.[A-Za-z0-9]+$/;
const diagnosticPhases = new Set(['input', 'api', 'ssh', 'network', 'verify_zip', 'verify_image']);
const diagnosticCodes = new Set(['validation', 'http', 'timeout', 'network', 'tls', 'process', 'io', 'invalid_zip', 'internal']);

export function safeDiagnostic(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['phase', 'code', 'status', 'exitCode'].includes(key)) || !diagnosticPhases.has(value.phase) || !diagnosticCodes.has(value.code)) return null;
  if (value.status !== undefined && (!Number.isInteger(value.status) || value.status < 100 || value.status > 599)) return null;
  if (value.exitCode !== undefined && (!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)) return null;
  return { phase: value.phase, code: value.code, ...(value.status !== undefined ? { status: value.status } : {}), ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}) };
}

class TransferFailure extends Error {
  constructor(diagnostic) { super('HTTPS artifact transfer failed'); this.diagnostic = safeDiagnostic(diagnostic); }
}

export function artifactParameters(environment = process.env) {
  const { ARTIFACT_ID: id, ARTIFACT_DIGEST: digest, GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository } = environment;
  if (!/^[1-9][0-9]*$/.test(id ?? '') || !/^(?:sha256:)?[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('Artifact identity is invalid');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !token) throw new Error('GitHub artifact access is unavailable');
  return { id, digest: digest.replace(/^sha256:/, ''), token, repository };
}

export function validateBlobURL(value) {
  if (typeof value !== 'string' || value.length > 12_000 || value.split('').some(character => character.charCodeAt(0) < 32)) throw new Error('Artifact download location is invalid');
  let url;
  try { url = new URL(value); } catch { throw new Error('Artifact download location is invalid'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname)) throw new Error('Artifact download location is not approved HTTPS storage');
  return url.href;
}

export async function signedArtifactURL(parameters, fetchAPI = fetch) {
  let response;
  try {
    response = await fetchAPI(`https://api.github.com/repos/${parameters.repository}/actions/artifacts/${parameters.id}/zip`, {
      headers: { Authorization: `Bearer ${parameters.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
  } catch (error) { throw new TransferFailure({ phase: 'api', code: ['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout' : 'network' }); }
  if (response.status !== 302) throw new TransferFailure({ phase: 'api', code: 'http', status: response.status });
  return validateBlobURL(response.headers.get('location'));
}

function run(command, args, input, timeout = 60_000) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', timeout, maxBuffer: 64 * 1024, env: process.env });
  if (result.status !== 0 || result.error) {
    let diagnostic;
    // Only the helper's closed JSON vocabulary may cross into runner logs.
    // Discard every raw SSH/Python exception string, including URL-bearing errors.
    try { diagnostic = safeDiagnostic(JSON.parse(result.stderr.trim().split('\n').at(-1))); } catch { /* safe SSH-only fallback */ }
    throw new TransferFailure(diagnostic ?? { phase: 'ssh', code: result.error?.code === 'ETIMEDOUT' ? 'timeout' : 'process', ...(Number.isInteger(result.status) ? { exitCode: result.status } : {}) });
  }
  return result.stdout.trim();
}

export async function transferArtifact({ probe = false, remoteDirectory, sshConfig, parameters = artifactParameters() }, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const downloadURL = dependencies.signedURL ?? signedArtifactURL;
  const config = sshConfig ?? execute('bash', [resolve(scriptDirectory, 'ssh-config.sh')]);
  let directory = remoteDirectory;
  if (probe) directory = execute('ssh', ['-T', '-F', config, 'jiashu-aliyun', 'umask 077; mktemp -d /tmp/jiashu-https-probe.XXXXXXXX']);
  if (!remotePattern.test(directory ?? '')) throw new Error('Artifact destination directory is invalid');
  try {
    if (probe) execute('scp', ['-F', config, resolve(scriptDirectory, 'fetch-artifact.py'), `jiashu-aliyun:${directory}/`]);
    // Obtain the one-minute URL only after SSH and the helper are ready. Keep
    // the GitHub token on the runner; pass only the short-lived URL over stdin.
    const url = await downloadURL(parameters);
    // Runner command processing masks accidental future diagnostics. This line
    // is never used outside Actions and contains no repository access token.
    const mask = dependencies.mask ?? (value => {
      if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}\n`);
    });
    mask(url);
    const payload = JSON.stringify({ url, artifactDigest: parameters.digest });
    const output = execute('ssh', ['-T', '-F', config, 'jiashu-aliyun', `python3 '${directory}/fetch-artifact.py'${probe ? ' --probe' : ''}`], payload, probe ? 75_000 : 12 * 60_000);
    const result = JSON.parse(output);
    if (result.mode !== (probe ? 'probe' : 'download') || !Number.isSafeInteger(result.bytes) || result.bytes <= 0 || !Number.isFinite(result.seconds) || result.seconds <= 0 || !Number.isFinite(result.bytesPerSecond) || result.bytesPerSecond <= 0) throw new Error('Artifact transfer returned invalid metadata');
    return { mode: result.mode, bytes: result.bytes, seconds: result.seconds, bytesPerSecond: result.bytesPerSecond };
  } finally {
    if (probe && directory) {
      try { execute('ssh', ['-T', '-F', config, 'jiashu-aliyun', `rm -rf -- '${directory}'`]); } catch { /* best effort private probe cleanup */ }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--probe') return transferArtifact({ probe: true });
  if (args.length !== 4 || args[0] !== '--remote-dir' || args[2] !== '--ssh-config') throw new Error('Invalid HTTPS artifact transfer arguments');
  return transferArtifact({ remoteDirectory: args[1], sshConfig: args[3] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main())); }
  catch (error) { console.error(JSON.stringify(error instanceof TransferFailure && error.diagnostic ? error.diagnostic : { phase: 'input', code: 'validation' })); process.exitCode = 1; }
}
