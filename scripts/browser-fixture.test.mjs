import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { assertBrowserFixtureEnvironment, renderBrowserFixture, BROWSER_FIXTURE_OWNER, browserFixtureHealthExport } from './browser-fixture.mjs';

test('browser acceptance fixture refuses managed preview substitution and exposes only known synthetic pages', () => {
  assert.throws(() => assertBrowserFixtureEnvironment({ SITES_MANAGED_LINUX_CONTAINER: '1' }), /managed Sites use sites-preview/);
  assert.doesNotThrow(() => assertBrowserFixtureEnvironment({ CI: 'true' }));
  assert.equal(renderBrowserFixture('/api/health/nutrition'), null);
  assert.equal(renderBrowserFixture('/unknown'), null);
  assert.match(renderBrowserFixture('/health/nutrition'), /browser-acceptance-synthetic-owner/);
  assert.match(renderBrowserFixture('/health/records'), /id="records-dialog"/);
});

test('all synthetic fixture pages emit parseable inline scripts', () => {
  for (const pathname of ['/', '/life/douban', '/health', '/health/review', '/health/nutrition', '/health/records', '/health/weight-plan', '/finance', '/finance/goals', '/finance/runway', '/finance/review', '/data/backup', '/sync/templates']) {
    const html = renderBrowserFixture(pathname);
    assert.ok(html, pathname);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(([, attributes]) => !/type=["']application\//.test(attributes));
    assert.ok(scripts.length, pathname);
    const window = {};
    vm.runInNewContext(scripts[0][2], { window });
    assert.equal(window.__JIASHU_PAGE_OWNER__, BROWSER_FIXTURE_OWNER, pathname + ' must pin the same SSR owner as the real route before initializing clients');
    assert.equal(Object.getOwnPropertyDescriptor(window, '__JIASHU_PAGE_OWNER__').configurable, false);
    for (const [, , source] of scripts) assert.doesNotThrow(() => new vm.Script(source, { filename: pathname + '.inline.js' }));
  }
});


test('synthetic native health downloads preserve JSON filenames and the selected date range', () => {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const from = new Date(Date.parse(today + 'T12:00:00Z') - 3 * 86400000).toISOString().slice(0, 10);
  const file = browserFixtureHealthExport(new URL('http://127.0.0.1:4175/api/health/export?from=' + from + '&to=' + today));
  assert.equal(file.headers['Content-Disposition'], 'attachment; filename="jiashu-health-' + from + '_' + today + '.json"');
  const payload = JSON.parse(file.body);
  assert.equal(payload.source, 'apple-health-shortcuts');
  assert.ok(payload.measurements.length);
  assert.ok(payload.measurements.every(row => row.startDate.slice(0, 10) >= from && row.startDate.slice(0, 10) <= today));
  assert.throws(() => browserFixtureHealthExport(new URL('http://127.0.0.1:4175/api/health/export?from=invalid&to=' + today)));
});
