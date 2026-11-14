import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDateRangeQuery } from '../lib/date-range.ts';
import { makeP2HealthMeasurements } from '../tests/browser/p2-api.mjs';
import { withPageAccount } from '../lib/page-account.ts';
import { renderHomeApp } from '../home-ui.ts';
import { renderNutritionPage } from '../nutrition-page.ts';
import { renderHealthRecordsPage } from '../health-records-page.ts';
import { renderHealthWeeklyPage } from '../health-weekly-page.ts';
import { renderDoubanPage } from '../douban-page.ts';
import { renderFinanceApp } from '../finance-ui.ts';
import { renderFinanceGoalsPage } from '../finance-goals-page.ts';
import { renderShortcutTemplatesPage } from '../shortcut-templates-page.ts';
import { renderApp } from '../ui.ts';
import { renderWeightPlanPage } from '../weight-plan-page.ts';
import { renderFinanceRunwayPage } from '../finance-runway-page.ts';
import { renderFinanceReviewPage } from '../finance-review-page.ts';
import { renderDataBackupPage } from '../data-backup-page.ts';

export const BROWSER_FIXTURE_OWNER = 'browser-acceptance-synthetic-owner';
function renderSyntheticPage(pathname) {
  if (pathname === '/') return renderHomeApp();
  if (pathname === '/health/nutrition') return renderNutritionPage(BROWSER_FIXTURE_OWNER);
  if (pathname === '/health/records') return renderHealthRecordsPage(BROWSER_FIXTURE_OWNER);
  if (pathname === '/health/review') return renderHealthWeeklyPage();
  if (pathname === '/life/douban') return renderDoubanPage();
  if (pathname === '/health') return renderApp();
  if (pathname === '/health/weight-plan') return renderWeightPlanPage();
  if (pathname === '/finance') return renderFinanceApp(BROWSER_FIXTURE_OWNER);
  if (pathname === '/finance/goals') return renderFinanceGoalsPage(BROWSER_FIXTURE_OWNER);
  if (pathname === '/finance/runway') return renderFinanceRunwayPage(BROWSER_FIXTURE_OWNER);
  if (pathname === '/finance/review') return renderFinanceReviewPage();
  if (pathname === '/data/backup') return renderDataBackupPage(BROWSER_FIXTURE_OWNER);
  if (pathname === '/sync/templates') return renderShortcutTemplatesPage('weight');
  return null;
}

export function renderBrowserFixture(pathname) {
  const html = renderSyntheticPage(pathname);
  return html === null ? null : withPageAccount(html, BROWSER_FIXTURE_OWNER);
}

// Browser-managed downloads can bypass Playwright route interception. This one
// read-only boundary serves deterministic synthetic bytes, never user storage.
export function browserFixtureHealthExport(url) {
  const range = parseDateRangeQuery(url.searchParams);
  return {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="jiashu-health-' + range.from + '_' + range.to + '.json"' },
    body: JSON.stringify({ version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt: new Date().toISOString(),
      measurements: makeP2HealthMeasurements().filter(row => row.startDate.slice(0, 10) >= range.from && row.startDate.slice(0, 10) <= range.to) }),
  };
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
    if (url.pathname === '/api/health/export') {
      try { const file = browserFixtureHealthExport(url); response.writeHead(200, file.headers).end(file.body); }
      catch { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid synthetic export range' })); }
      return;
    }
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
