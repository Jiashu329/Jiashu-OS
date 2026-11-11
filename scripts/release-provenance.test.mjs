import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sourceState, verifyRelease, writeProvenance } from './release-provenance.mjs';
import { testFiles } from './test-files.mjs';

const checks = { typecheck: true, unit: true, build: true, production: true };
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'jiashu-release-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  mkdirSync(join(cwd, '.openai'));
  mkdirSync(join(cwd, 'dist/server'), { recursive: true });
  writeFileSync(join(cwd, '.gitignore'), '/dist/\n');
  writeFileSync(join(cwd, '.openai/hosting.json'), JSON.stringify({ project_id: 'synthetic-release-site' }));
  writeFileSync(join(cwd, 'source.ts'), 'export const value = 1;\n');
  writeFileSync(join(cwd, 'dist/server/index.js'), 'export default {fetch(){return new Response("synthetic")}};');
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Release Fixture', '-c', 'user.email=synthetic@example.test', 'commit', '-qm', 'synthetic source');
  return { cwd, git, build(flags = checks) { return writeProvenance(sourceState(cwd), flags, cwd); } };
}

test('a complete clean release is bound to its exact commit and output, and repeated validation is stable', (t) => {
  const f = fixture(t), built = f.build();
  assert.deepEqual(verifyRelease(f.cwd), built);
  assert.deepEqual(verifyRelease(f.cwd), built);
  assert.equal(built.commitSha, sourceState(f.cwd).commitSha);
  assert.equal(built.cleanAtBuild, true);
});

test('changed source, a new untracked source file and a new commit all invalidate prior output', (t) => {
  const f = fixture(t); f.build();
  writeFileSync(join(f.cwd, 'source.ts'), 'export const value = 2;\n');
  assert.throws(() => verifyRelease(f.cwd), /clean committed/);
  assert.throws(() => verifyRelease(f.cwd, { requireClean: false }), /does not match/);
  writeFileSync(join(f.cwd, 'source.ts'), 'export const value = 1;\n');
  writeFileSync(join(f.cwd, 'new-source.ts'), 'export const added = true;');
  assert.throws(() => verifyRelease(f.cwd), /clean committed/);
  f.git('add', '.');
  f.git('-c', 'user.name=Release Fixture', '-c', 'user.email=synthetic@example.test', 'commit', '-qm', 'new source');
  assert.throws(() => verifyRelease(f.cwd), /does not match/);
});

test('output tampering, incomplete checks and another Site identity cannot be published', (t) => {
  const f = fixture(t); f.build();
  writeFileSync(join(f.cwd, 'dist/server/index.js'), 'modified after validation');
  assert.throws(() => verifyRelease(f.cwd), /artifacts changed/);
  f.build({ build: true, production: true });
  assert.throws(() => verifyRelease(f.cwd), /Complete release checks/);
  f.build();
  const path = join(f.cwd, 'dist/release-provenance.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...manifest, projectId: 'another-synthetic-site' }));
  assert.throws(() => verifyRelease(f.cwd), /identity mismatch/);
});

test('source edits while checks or build run cannot receive a successful attestation', (t) => {
  const f = fixture(t), start = sourceState(f.cwd);
  writeFileSync(join(f.cwd, 'source.ts'), 'changed during build');
  assert.throws(() => writeProvenance(start, checks, f.cwd), /Source changed during build/);
});

test('test discovery separates production artifacts from units and ignores generated directories', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.cwd, 'lib/nested'), { recursive: true });
  mkdirSync(join(f.cwd, 'node_modules/dependency'), { recursive: true });
  for (const path of ['lib/a.test.ts', 'lib/nested/new-feature.test.ts', 'lib/health-production-client.test.ts', 'lib/app-production-client.test.ts', 'node_modules/dependency/fake.test.ts', 'dist/server/fake.test.ts']) writeFileSync(join(f.cwd, path), '');
  assert.deepEqual(testFiles('unit', f.cwd), ['lib/a.test.ts', 'lib/nested/new-feature.test.ts']);
  assert.deepEqual(testFiles('production', f.cwd), ['lib/app-production-client.test.ts', 'lib/health-production-client.test.ts']);
});
