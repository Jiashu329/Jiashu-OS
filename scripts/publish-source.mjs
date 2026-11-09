import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import readline from 'node:readline/promises';

// Repository credentials are accepted on hidden stdin and used only in child
// process environment. They never enter argv, Git configuration, or files.
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write('Ready for repository workflow JSON on hidden stdin.\n');
const input = JSON.parse(await rl.question(''));
rl.close();
const { credential, project_id, mode = 'push', archive_path } = input;
const manifest = JSON.parse(readFileSync('.openai/hosting.json', 'utf8'));
if (manifest.project_id !== project_id) throw new Error('Site identity mismatch');
const remote = new URL(credential.remote_url);
if (remote.protocol !== 'https:' || remote.username || remote.password ||
    !['git.chatgpt-team.site', 'git.chatgpt.site'].includes(remote.hostname)) {
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
if (credential.token) {
  // The source server advertises HTTP Basic authentication, realm artifacts.
  gitConfig(`http.${remote.href}.extraHeader`,
    `Authorization: Basic ${Buffer.from(`x-access-token:${credential.token}`).toString('base64')}`);
}
gitConfig('http.followRedirects', 'false');
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { encoding: 'utf8', env });
  if (result.status !== 0) {
    const output = `${result.stderr || result.stdout || result.error || 'Command failed'}`;
    throw new Error(credential.token ? output.replaceAll(credential.token, '[redacted]') : output);
  }
  return result.stdout.trim();
}
run('git', ['ls-remote', remote.href], childEnv);
if (mode === 'probe') {
  process.stdout.write(JSON.stringify({ authenticated: true, project_id }) + '\n');
  process.exit(0);
}
if (!archive_path || !archive_path.startsWith('/workspace/')) throw new Error('Expected workspace archive path');
const branch = credential.branch;
run('git', ['check-ref-format', '--branch', branch]);
run('git', ['init', '-b', branch]);
run('git', ['config', 'user.name', 'Codex']);
run('git', ['config', 'user.email', 'codex@openai.com']);
run('git', ['add', '.']);
const staged = run('git', ['diff', '--cached', '--name-only']);
if (staged) run('git', ['commit', '-m', 'Build private health dashboard and health-data sync']);
const commit_sha = run('git', ['rev-parse', 'HEAD']);
run('git', ['push', remote.href, `HEAD:refs/heads/${branch}`], childEnv);
const remoteHead = run('git', ['ls-remote', remote.href, `refs/heads/${branch}`], childEnv).split(/\s/)[0];
if (remoteHead !== commit_sha) throw new Error('Pushed source verification failed');
mkdirSync(archive_path.slice(0, archive_path.lastIndexOf('/')), { recursive: true });
const stage = `${process.cwd()}/outputs/.deployment-stage`;
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync('dist', `${stage}/dist`, { recursive: true });
cpSync('dist/.openai', `${stage}/.openai`, { recursive: true });
run('tar', ['-czf', archive_path, '-C', stage, '.']);
process.stdout.write(JSON.stringify({ project_id, commit_sha, archive: archive_path }) + '\n');
