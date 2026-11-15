import { pathToFileURL } from 'node:url';
import { hashPassword, verifyPassword } from './password-hash.ts';
export { hashPassword, verifyPassword };

async function main() {
  const action = process.argv[2];
  if (!['hash', 'verify'].includes(action) || process.argv.length !== 3) throw new Error('Usage: node selfhost/password.mjs hash|verify < private-password-file');
  let content = ''; for await (const chunk of process.stdin) { content += chunk; if (Buffer.byteLength(content) > 2048) throw new Error('Password input is too large.'); }
  const password = content.replace(/\r?\n$/, '');
  if (action === 'hash') process.stdout.write(await hashPassword(password) + '\n');
  else process.exitCode = await verifyPassword(password, process.env.SELFHOST_PASSWORD_HASH ?? '') ? 0 : 1;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => { process.stderr.write('Password operation failed; check the command and private input.\n'); process.exitCode = 1; });
}
