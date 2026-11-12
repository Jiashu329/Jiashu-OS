import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { testFiles } from './test-files.mjs';
const kind = process.argv[2] ?? 'unit';
if (!['unit', 'production'].includes(kind)) throw new Error('Expected unit or production tests');
if (kind === 'production' && !['dist/server/index.js', 'dist/server/_next/static', 'dist/.openai/hosting.json'].every((path) => existsSync(path))) throw new Error('Build output missing; run npm run build before production checks');
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...testFiles(kind)], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
