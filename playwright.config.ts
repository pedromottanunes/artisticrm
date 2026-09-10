import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './frontend/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5175', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5175/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: '3335',
      FRONTEND_PORT: '5175',
      ARTISTI_API_TARGET: 'http://127.0.0.1:3335',
      ARTISTI_EPHEMERAL_DB: '1',
      MONGODB_URI: '',
      DATABASE_URL: '',
      NODE_ENV: 'development',
    },
  },
});
