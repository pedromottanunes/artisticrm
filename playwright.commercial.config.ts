import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

// Isolated local server, synthetic documents, no provider requests or live database.
export default defineConfig({
  ...base,
  testMatch: 'commercial-evidence.spec.ts',
  testIgnore: [],
  timeout: 60000,
  projects: [
    { name: 'commercial-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'commercial-iphone', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
  webServer: {
    ...(base.webServer as object),
    env: {
      ...(base.webServer as { env: Record<string, string> }).env,
      COMMERCIAL_EVIDENCE_ENABLED: 'true',
      COMMERCIAL_AI_ENABLED: 'false',
      COMMERCIAL_AI_AUTO_VALIDATE: 'false',
      GEMINI_API_KEY: '',
    },
  },
});
