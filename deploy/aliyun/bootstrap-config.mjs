import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { hashPassword } from '/app/selfhost/password.mjs';

// Invoked inside the verified application image with only /bootstrap writable.
const origin = process.env.BOOTSTRAP_PUBLIC_ORIGIN;
const username = process.env.BOOTSTRAP_USERNAME || 'admin';
const ownerId = process.env.BOOTSTRAP_OWNER_ID || 'treefund-test-owner';
const ownerEmail = process.env.BOOTSTRAP_OWNER_EMAIL || 'admin@treefund.asia';
if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(origin || '')) throw new Error('Expected an HTTPS origin.');
if (![username, ownerId, ownerEmail].every(value => typeof value === 'string' && /^[A-Za-z0-9@._+-]{1,200}$/.test(value))) throw new Error('Invalid account configuration.');
if (existsSync('/bootstrap/app.env')) {
  chmodSync('/bootstrap/app.env', 0o600);
  process.stdout.write('Existing server environment preserved.\n');
} else {
  if (existsSync('/bootstrap/initial-login.txt')) throw new Error('A credential file already exists without app.env; inspect the partial setup privately.');
  const password = randomBytes(24).toString('base64url');
  const values = {
    SELFHOST_PUBLIC_ORIGIN: origin,
    SELFHOST_USERNAME: username,
    SELFHOST_PASSWORD_HASH: await hashPassword(password),
    SELFHOST_SESSION_SECRET: randomBytes(32).toString('base64url'),
    SELFHOST_DB_PATH: '/data/app.sqlite3',
    APP_OWNER_USER_ID: ownerId,
    APP_OWNER_EMAIL: ownerEmail,
    AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
  // Compose env_file requires literal dollars in the scrypt hash, not interpolation.
  const env = Object.entries(values).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n';
  writeFileSync('/bootstrap/app.env', env, { mode: 0o600, flag: 'wx' });
  writeFileSync('/bootstrap/initial-login.txt', `Public origin: ${origin}\nUsername: ${username}\nInitial password: ${password}\nRead only in a private server console; do not copy to Actions logs or chat.\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write('Created server environment and private initial-login file. Values were not printed.\n');
}
