import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import readline from 'node:readline/promises';
import { artifactFingerprint, verifyRelease } from './release-provenance.mjs';

// Repository credentials are accepted on hidden stdin and used only in child
// process environment. They never enter argv, persisted Git configuration, or files.
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write('Ready for repository workflow JSON on hidden stdin.\n');
const input = JSON.parse(await rl.question(''));
rl.close();
const { credential, project_id, mode = 'push', archive_path, sync_github = false } = input;
const manifest = JSON.parse(readFileSync('.openai/hosting.json', 'utf8'));
if (manifest.project_id !== project_id) throw new Error('Site identity mismatch');
if (!['push', 'probe', 'verify'].includes(mode)) throw new Error('Unknown repository workflow mode');
if (mode === 'verify') {
  const verified = verifyRelease();
  process.stdout.write(JSON.stringify({ project_id, commit_sha: verified.commitSha, verified: true }) + '\n');
  process.exit(0);
}
const checked = mode === 'probe' ? null : verifyRelease();
const remote = new URL(credential.remote_url);
if (remote.protocol !== 'https:' || remote.username || remote.password ||
    !['git.chatgpt-team.site', 'git.chatgpt.site', 'git.appgardenapps.dev', 'git.appgardenapps.com'].includes(remote.hostname)) {
  throw new Error('Unexpected source repository destination');
}
const childEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
for (const key of Object.keys(childEnv)) if (key.startsWith('GIT_TRACE')) delete childEnv[key];
let configCount = Number(childEnv.GIT_CONFIG_COUNT || 0);
function gitConfig(key, value) {
  childEnv[`GIT_CONFIG_KEY_${configCount}`] = key;
  childEnv[`GIT_CONFIG_VALUE_${configCount}`] = value;
  childEnv.GIT_CONFIG_COUNT = String(++configCount);
}
const auth = credential.token ? Buffer.from(`x-access-token:${credential.token}`).toString('base64') : '';
if (auth) {
  // The source server advertises HTTP Basic authentication, realm artifacts.
  gitConfig(`http.${remote.href}.extraHeader`,
    `Authorization: Basic ${auth}`);
}
gitConfig('http.followRedirects', 'false');
function run(command, args, env = process.env, failureMessage = 'Command failed') {
  const result = spawnSync(command, args, { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) {
    let output = `${result.stderr || result.stdout || result.error || failureMessage}`;
    for (const secret of [credential.token, auth].filter(Boolean)) output = output.replaceAll(secret, '[redacted]');
    throw new Error(output);
  }
  return result.stdout.trim();
}
const branch = credential.branch;
run('git', ['check-ref-format', '--branch', branch]);
const sourceHead = run('git', ['ls-remote', remote.href, `refs/heads/${branch}`], childEnv).split(/\s/)[0];
if (mode === 'probe') {
  process.stdout.write(JSON.stringify({ authenticated: true, project_id }) + '\n');
  process.exit(0);
}
const archive = resolve(archive_path || '');
if (!archive_path || !archive.startsWith('/workspace/') || !archive.endsWith('.tar.gz')) throw new Error('Expected workspace .tar.gz archive path');
run('git', ['fetch', remote.href, `${branch}:refs/remotes/sites-release/${branch}`], childEnv);
run('git', ['merge-base', '--is-ancestor', sourceHead, 'HEAD'], process.env,
  'Sites source contains new commits. Merge the source branch, commit, and run npm run release:check again before publishing.');
const commit_sha = checked.commitSha;
run('git', ['push', remote.href, `HEAD:refs/heads/${branch}`], childEnv);
const remoteHead = run('git', ['ls-remote', remote.href, `refs/heads/${branch}`], childEnv).split(/\s/)[0];
if (remoteHead !== commit_sha) throw new Error('Pushed source verification failed');
if (sync_github) {
  const github = new URL(run('git', ['remote', 'get-url', 'origin']));
  if (github.protocol !== 'https:' || github.hostname !== 'github.com' || github.username || github.password) throw new Error('Expected credential-free HTTPS GitHub origin');
  run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  if (run('git', ['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s/)[0] !== commit_sha) throw new Error('GitHub source verification failed');
}
const verified = verifyRelease();
mkdirSync(dirname(archive), { recursive: true });
const stage = `${process.cwd()}/outputs/.deployment-stage`;
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync('dist', `${stage}/dist`, { recursive: true });
cpSync('dist/.openai', `${stage}/.openai`, { recursive: true });
if (artifactFingerprint(stage) !== verified.artifactFingerprint) throw new Error('Packaged artifacts differ from validated build');
verifyRelease();
run('tar', ['-czf', archive, '-C', stage, '.']);
process.stdout.write(JSON.stringify({ project_id, commit_sha, archive }) + '\n');
