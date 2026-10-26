import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive the real web UI against the real API and the local
 * seeded PostgreSQL (`pnpm db:up && pnpm db:migrate && pnpm db:seed`).
 * They create real orders in that database.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @kitchos/api dev',
      url: 'http://localhost:4000/health/ready',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @kitchos/web dev',
      url: 'http://localhost:3100',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
