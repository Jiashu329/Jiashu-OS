import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// This isolated suite loads the actual MV3 package. A loopback-only HTTPS proxy
// serves synthetic responses, including extension-created tabs' first navigation.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60000,
  expect: { timeout: 10000 },
  outputDir: '../../outputs/extension-results',
  reporter: [['line'], ['html', { outputFolder: resolve(import.meta.dirname, '../../outputs/extension-report'), open: 'never' }]],
});
