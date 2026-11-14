import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { assertBrowserFixtureEnvironment, renderBrowserFixture, BROWSER_FIXTURE_OWNER } from './browser-fixture.mjs';

test('browser acceptance fixture refuses managed preview substitution and exposes only known synthetic pages', () => {
  assert.throws(() => assertBrowserFixtureEnvironment({ SITES_MANAGED_LINUX_CONTAINER: '1' }), /managed Sites use sites-preview/);
  assert.doesNotThrow(() => assertBrowserFixtureEnvironment({ CI: 'true' }));
  assert.equal(renderBrowserFixture('/api/health/nutrition'), null);
  assert.equal(renderBrowserFixture('/unknown'), null);
  assert.match(renderBrowserFixture('/health/nutrition'), /browser-acceptance-synthetic-owner/);
  assert.match(renderBrowserFixture('/health/records'), /id="records-dialog"/);
});

test('all synthetic fixture pages emit parseable inline scripts', () => {
  for (const pathname of ['/', '/health', '/health/nutrition', '/health/records', '/health/weight-plan', '/finance', '/finance/goals', '/finance/runway', '/finance/review', '/data/backup', '/sync/templates']) {
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
