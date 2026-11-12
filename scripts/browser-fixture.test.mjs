import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBrowserFixtureEnvironment, renderBrowserFixture } from './browser-fixture.mjs';

test('browser acceptance fixture refuses managed preview substitution and exposes only known synthetic pages', () => {
  assert.throws(() => assertBrowserFixtureEnvironment({ SITES_MANAGED_LINUX_CONTAINER: '1' }), /managed Sites use sites-preview/);
  assert.doesNotThrow(() => assertBrowserFixtureEnvironment({ CI: 'true' }));
  assert.equal(renderBrowserFixture('/api/health/nutrition'), null);
  assert.equal(renderBrowserFixture('/unknown'), null);
  assert.match(renderBrowserFixture('/health/nutrition'), /browser-acceptance-synthetic-owner/);
  assert.match(renderBrowserFixture('/health/records'), /id="records-dialog"/);
});
