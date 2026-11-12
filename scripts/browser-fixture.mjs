import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderHomeApp } from '../home-ui.ts';
import { renderNutritionPage } from '../nutrition-page.ts';
import { renderHealthRecordsPage } from '../health-records-page.ts';
import { renderFinanceApp } from '../finance-ui.ts';
import { renderFinanceGoalsPage } from '../finance-goals-page.ts';
import { renderShortcutTemplatesPage } from '../shortcut-templates-page.ts';

export const BROWSER_FIXTURE_OWNER = 'browser-acceptance-synthetic-owner';
export function renderBrowserFixture(pathname) {
  if (pathname === '/') return renderHomeApp();
  if (pathname === '/health/nutrition') return renderNutritionPage(BROWSER_FIXTURE_OWNER);
  if (pathname === '/health/records') return renderHealthRecordsPage(BROWSER_FIXTURE_OWNER);
  if (pathname === '/finance') return renderFinanceApp(BROWSER_FIXTURE_OWNER);
  if (pathname === '/finance/goals') return renderFinanceGoalsPage(BROWSER_FIXTURE_OWNER);
  if (pathname === '/sync/templates') return renderShortcutTemplatesPage('weight');
  return null;
}

export function assertBrowserFixtureEnvironment(environment = process.env) {
  if (environment.SITES_MANAGED_LINUX_CONTAINER === '1') {
    throw new Error('Browser acceptance fixture is CI/local-only. In managed Sites use sites-preview and the shared browser; this fixture cannot replace that infrastructure.');
  }
}

export function startBrowserFixture() {
  assertBrowserFixtureEnvironment();
  const publicRoot = resolve(import.meta.dirname, '../public');
  const contentTypes = { '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:4175');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (request.method !== 'GET') { response.writeHead(405).end('Fixture server never writes.'); return; }
    if (url.pathname === '/__browser-fixture-health') { response.writeHead(200).end('synthetic-only'); return; }
    if (url.pathname.startsWith('/api/')) { response.writeHead(501).end('API must be intercepted by the acceptance test.'); return; }
    const html = renderBrowserFixture(url.pathname);
    if (html !== null) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.writeHead(200).end(html); return; }
    const file = resolve(publicRoot, '.' + url.pathname);
    if (!file.startsWith(publicRoot + '/') || !Object.hasOwn(contentTypes, extname(file))) { response.writeHead(404).end(); return; }
    try { response.setHeader('Content-Type', contentTypes[extname(file)]); response.writeHead(200).end(await readFile(file)); }
    catch { response.writeHead(404).end(); }
  });
  server.listen(4175, '127.0.0.1', () => process.stdout.write('Synthetic browser fixture listening on 127.0.0.1:4175.\n'));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startBrowserFixture();
