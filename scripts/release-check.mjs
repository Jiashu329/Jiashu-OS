import { spawnSync } from 'node:child_process';
import { sourceState, verifyRelease, writeProvenance } from './release-provenance.mjs';
const publish = process.argv.includes('--release');
const start = sourceState();
if (publish && !start.clean) throw new Error('Commit all source changes before npm run release:check');
for (const args of [
  ['node_modules/typescript/bin/tsc', '--noEmit'],
  ['scripts/run-tests.mjs', 'unit'],
  ['scripts/build-release.mjs'],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
writeProvenance(start, { typecheck: true, unit: true, build: true, production: true });
const verified = verifyRelease(process.cwd(), { requireClean: publish });
process.stdout.write((publish ? 'Release ready: ' : 'Checks passed: ') + verified.commitSha + '\n');
