import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4174', headless: true,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] } },
  webServer: { command: 'npm run preview -- --port 4174', url: 'http://127.0.0.1:4174', reuseExistingServer: !process.env.CI },
});
