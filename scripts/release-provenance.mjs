import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const MANIFEST_NAME = 'release-provenance.json';
export function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Release Git check failed: ' + args[0]);
  return result.stdout.trim();
}
function digestFiles(cwd, names) {
  const hash = createHash('sha256');
  for (const name of [...new Set(names)].sort()) {
    const path = join(cwd, name);
    let stat;
    try { stat = lstatSync(path); } catch { hash.update(name + '\0missing\0'); continue; }
    hash.update(name + '\0' + (stat.mode & 0o777) + '\0');
    if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
    else if (stat.isFile()) hash.update(readFileSync(path));
    else throw new Error('Unsupported release source entry: ' + name);
    hash.update('\0');
  }
  return hash.digest('hex');
}
export function sourceState(cwd = process.cwd()) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot enumerate release source');
  return {
    commitSha: git(cwd, ['rev-parse', 'HEAD']),
    sourceFingerprint: digestFiles(cwd, result.stdout.split('\0').filter(Boolean)),
    clean: git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']) === '',
  };
}
export function artifactFingerprint(cwd = process.cwd()) {
  const directory = join(cwd, 'dist');
  const files = [];
  function visit(path) {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const entry = join(path, item.name);
      if (entry === join(directory, MANIFEST_NAME)) continue;
      if (item.isDirectory()) visit(entry);
      else files.push(relative(directory, entry));
    }
  }
  visit(directory);
  return digestFiles(directory, files);
}
export function writeProvenance(start, checks, cwd = process.cwd()) {
  const end = sourceState(cwd);
  if (start.commitSha !== end.commitSha || start.sourceFingerprint !== end.sourceFingerprint) throw new Error('Source changed during build; run checks again');
  const manifest = {
    version: 1,
    projectId: JSON.parse(readFileSync(join(cwd, '.openai/hosting.json'), 'utf8')).project_id,
    commitSha: end.commitSha,
    sourceFingerprint: end.sourceFingerprint,
    cleanAtBuild: end.clean,
    artifactFingerprint: artifactFingerprint(cwd),
    checkedAt: new Date().toISOString(),
    checks,
  };
  writeFileSync(join(cwd, 'dist', MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
export function verifyRelease(cwd = process.cwd(), { requireClean = true, requireChecks = true } = {}) {
  const source = sourceState(cwd);
  if (requireClean && !source.clean) throw new Error('Release requires a clean committed worktree');
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(cwd, 'dist', MANIFEST_NAME), 'utf8')); }
  catch { throw new Error('Build provenance missing; commit source and run npm run release:check'); }
  if (manifest.version !== 1 || manifest.commitSha !== source.commitSha || manifest.sourceFingerprint !== source.sourceFingerprint) throw new Error('Build does not match current source; run npm run release:check');
  const project = JSON.parse(readFileSync(join(cwd, '.openai/hosting.json'), 'utf8')).project_id;
  if (manifest.projectId !== project) throw new Error('Build Site identity mismatch');
  if (requireClean && !manifest.cleanAtBuild) throw new Error('Release build was created from uncommitted source; rebuild after committing');
  if (requireChecks && !['typecheck', 'unit', 'build', 'production'].every((name) => manifest.checks?.[name] === true)) throw new Error('Complete release checks have not passed');
  if (manifest.artifactFingerprint !== artifactFingerprint(cwd)) throw new Error('Build artifacts changed after validation; rebuild before publishing');
  return manifest;
}
