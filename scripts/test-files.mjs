import { readdirSync } from 'node:fs';
import { join } from 'node:path';
export function testFiles(kind = 'unit', cwd = process.cwd()) {
  const files = [];
  const ignored = new Set(['.git', 'node_modules', 'dist', 'outputs', '.wrangler', '.vinext', '.next', '.sites-runtime', 'coverage']);
  function visit(path = '') {
    for (const entry of readdirSync(join(cwd, path), { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!ignored.has(entry.name)) visit(join(path, entry.name)); continue; }
      if (!entry.isFile() || !/\.test\.(?:ts|mjs)$/.test(entry.name)) continue;
      const production = /(?:^|-)production-client\.test\.ts$/.test(entry.name);
      if (production === (kind === 'production')) files.push(join(path, entry.name));
    }
  }
  visit();
  if (!files.length) throw new Error('No ' + kind + ' tests found');
  return files.sort();
}
