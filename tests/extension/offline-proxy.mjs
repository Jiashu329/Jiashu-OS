import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHTTPServer } from 'node:http';
import { createServer as createHTTPSServer } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
});
const close = server => new Promise(resolve => server.close(resolve));

/**
 * Chrome may navigate an extension-created tab before Playwright attaches to it.
 * Intercept below the browser instead: every allowed CONNECT is wired to the
 * same loopback TLS server. No code here opens a connection to its target host.
 */
export async function startOfflineProxy({ allowedHosts, respond, nativeLoginCookie }) {
  if (process.env.SITES_MANAGED_LINUX_CONTAINER === '1') throw new Error('The isolated extension transport is CI/local-only, never a managed Sites preview substitute.');
  const allowed = new Set(allowedHosts), requests = [], unexpected = [], tunnels = [];
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const certificateDir = await mkdtemp(join(tmpdir(), 'jiashu-mv3-offline-'));
  let tlsServer, proxyServer;
  const cleanup = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([tlsServer?.listening ? close(tlsServer) : undefined, proxyServer?.listening ? close(proxyServer) : undefined]);
    await rm(certificateDir, { recursive: true, force: true });
  };
  try {
    const keyPath = join(certificateDir, 'key.pem'), certPath = join(certificateDir, 'cert.pem');
    await executeFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=synthetic-extension.invalid', '-addext', 'subjectAltName=' + [...allowed].map(host => 'DNS:' + host).join(','),
      '-keyout', keyPath, '-out', certPath]);
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    tlsServer = createHTTPSServer({ key, cert }, async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      try {
        const url = new URL(request.url ?? '/', 'https://' + request.headers.host);
        if (url.protocol !== 'https:' || !allowed.has(url.hostname) || url.port || url.username || url.password) throw new Error('Unexpected fixture authority');
        const chunks = []; let length = 0;
        for await (const chunk of request) { length += chunk.length; if (length > 1024 * 1024) throw new Error('Unexpected fixture upload'); chunks.push(chunk); }
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const body = rawBody ? JSON.parse(rawBody) : null;
        // Retain only a boolean proof that the synthetic native cookie was sent.
        // Never retain Cookie header text in fixture diagnostics or bridge data.
        const nativeLogin = Boolean(nativeLoginCookie && (request.headers.cookie ?? '').split(';').some(value => value.trim() === nativeLoginCookie.name + '=' + nativeLoginCookie.value));
        requests.push({ url: url.href, method: request.method, body, nativeLogin });
        const result = await respond(url, request.method, body);
        if (!result) { unexpected.push(url.href); response.writeHead(403).end('Unrecognized synthetic request'); return; }
        response.writeHead(result.status ?? 200, result.headers ?? {}).end(result.body ?? '');
      } catch {
        unexpected.push('invalid HTTPS fixture request');
        response.writeHead(403).end('Invalid synthetic request');
      }
    });
    tlsServer.on('connection', track);
    const tlsPort = await listen(tlsServer);
    proxyServer = createHTTPServer((request, response) => {
      unexpected.push('non-CONNECT proxy request: ' + request.url);
      response.writeHead(403).end('Only synthetic HTTPS tunnels are permitted');
    });
    proxyServer.on('connection', track);
    proxyServer.on('connect', (request, clientSocket, head) => {
      clientSocket.on('error', () => {});
      let target;
      try { target = new URL('https://' + request.url); } catch { /* Rejected below. */ }
      if (!target || !allowed.has(target.hostname) || target.port || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
        unexpected.push('unrecognized CONNECT: ' + request.url);
        clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      tunnels.push(target.hostname);
      // Deliberately constant loopback destination, never target.hostname.
      const upstream = connect({ host: '127.0.0.1', port: tlsPort });
      track(upstream);
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        clientSocket.pipe(upstream); upstream.pipe(clientSocket);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
      clientSocket.once('close', () => upstream.destroy());
    });
    const proxyPort = await listen(proxyServer);
    return { proxy: 'http://127.0.0.1:' + proxyPort, requests, unexpected, tunnels, close: cleanup };
  } catch (error) { await cleanup(); throw error; }
}
