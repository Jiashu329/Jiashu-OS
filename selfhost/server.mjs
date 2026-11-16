import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createSelfhostGateway, loadSelfhostAuthConfig } from './auth.ts';
import { closeSelfhostDatabase, getSelfhostDatabase, readSelfhostReadiness } from './env.ts';
import { bootstrapLocalOwner, getLocalUserByEmail, getLocalUserById, touchLocalUserLogin } from '../db/local-users-store.ts';
import { createSelfhostUserManagement } from './user-management.ts';
import { isLocalSessionRevoked, revokeLocalSession } from '../db/local-session-revocations-store.ts';

export async function startSelfhostServer() {
  const config = loadSelfhostAuthConfig();
  const database = getSelfhostDatabase();
  await bootstrapLocalOwner(database, { id: config.ownerId, email: config.ownerEmail, passwordHash: config.passwordHash });
  const rawPort = process.env.PORT ?? '3000';
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('Invalid self-hosted port.');
  // Vinext captures these settings at import. Every forwarded value is replaced
  // by our gateway, never accepted from a client-controlled header.
  process.env.VINEXT_TRUSTED_HOSTS = config.host;
  process.env.VINEXT_TRUST_PROXY = '1';
  const { startProdServer } = await import('vinext/server/prod-server');
  const instance = await startProdServer({ port: Number(rawPort), host: process.env.HOST ?? '0.0.0.0', outDir: resolve(fileURLToPath(new URL('../dist', import.meta.url))), silent: true });
  const listeners = instance.server.listeners('request');
  if (listeners.length !== 1 || typeof listeners[0] !== 'function') { instance.server.close(); throw new Error('Unsupported Vinext request listener layout.'); }
  const original = listeners[0];
  const gateway = createSelfhostGateway(config, (req, res) => original.call(instance.server, req, res), {
    commitSha: process.env.APP_COMMIT_SHA ?? '', readiness: readSelfhostReadiness,
    users: { getById: id => getLocalUserById(database, id), getByEmail: email => getLocalUserByEmail(database, email),
      touchLogin: (id, now) => touchLocalUserLogin(database, id, new Date(now).toISOString()) },
    sessions: { isRevoked: (familyHash, now) => isLocalSessionRevoked(database, familyHash, now),
      revoke: (familyHash, expiresAt, now) => revokeLocalSession(database, familyHash, expiresAt, now) },
    manageUsers: createSelfhostUserManagement(config, database),
  });
  instance.server.removeListener('request', original);
  instance.server.on('request', gateway);
  instance.server.requestTimeout = 15000; instance.server.headersTimeout = 10000;
  instance.server.on('upgrade', (_request, socket) => socket.destroy());
  let closing = false;
  const stop = () => {
    if (closing) return; closing = true;
    instance.server.close(() => { closeSelfhostDatabase(); process.exit(0); });
    setTimeout(() => { instance.server.closeAllConnections(); closeSelfhostDatabase(); process.exit(0); }, 10000).unref();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  process.stdout.write(JSON.stringify({ event: 'selfhost_ready', port: instance.port }) + '\n');
  return instance;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startSelfhostServer().catch(() => { process.stderr.write('Self-hosted server startup failed; check configuration, migrations and build output.\n'); process.exitCode = 1; });
}
