import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 30000,
  expect: { timeout: 8000 },
  outputDir: 'outputs/browser-results',
  reporter: [['line'], ['html', { outputFolder: 'outputs/browser-report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4175', locale: 'zh-CN', timezoneId: 'Asia/Shanghai', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile-390-chromium', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
  ],
  webServer: { command: 'node scripts/browser-fixture.mjs', url: 'http://127.0.0.1:4175/__browser-fixture-health', reuseExistingServer: false, timeout: 30000 },
});
