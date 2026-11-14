import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { sourceState, writeProvenance } from './release-provenance.mjs';
const start = sourceState();
for (const [command, args] of [[process.execPath, ['scripts/package-douban-extension.mjs', '--check']], [resolve('node_modules/.bin/vinext'), ['build']], [process.execPath, ['scripts/run-tests.mjs', 'production']]]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const result = writeProvenance(start, { build: true, production: true });
process.stdout.write('Build verified for ' + result.commitSha.slice(0, 12) + '\n');
