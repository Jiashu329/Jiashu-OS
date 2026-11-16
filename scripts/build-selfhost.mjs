import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

if (Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('Self-hosted production builds require Node.js 24 or newer');
}
const buildEnv = { ...process.env, APP_DEPLOY_TARGET: 'node' };
for (const [command, args] of [
  [process.execPath, ['scripts/package-douban-extension.mjs', '--check']],
  [process.execPath, ['scripts/package-selfhost-extension.mjs']],
  [resolve('node_modules/.bin/vinext'), ['build']],
]) {
  const result = spawnSync(command, args, { env: buildEnv, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const output = resolve('dist/standalone');
if (!existsSync(resolve(output, 'dist/server/index.js'))) {
  throw new Error('Vinext did not produce the standalone server bundle');
}
mkdirSync(resolve(output, 'selfhost'), { recursive: true });
for (const name of readdirSync('selfhost')) {
  if (/\.(?:mjs|ts|sh)$/.test(name) && !/\.test\./.test(name)) {
    cpSync(resolve('selfhost', name), resolve(output, 'selfhost', name));
  }
}
// These pure TypeScript modules are also consumed by the native Node gateway,
// outside Vinext's bundled application. Keep the authentication registry shared.
for (const path of ['db/local-users-store.ts', 'db/local-session-revocations-store.ts', 'lib/local-users.ts', 'lib/access-control.ts']) {
  mkdirSync(resolve(output, path, '..'), { recursive: true });
  cpSync(resolve(path), resolve(output, path));
}
cpSync('drizzle', resolve(output, 'drizzle'), { recursive: true });
console.log('Standalone build ready in dist/standalone');
