import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

// Optional local cross-engine checks. This emulates an iPhone, not a physical device.
export default defineConfig({
  ...base,
  grep: /gestão móvel:|PWA:|atendimento móvel acessa/,
  projects: [{ name: 'webkit-mobile', use: { ...devices['iPhone 13'], browserName: 'webkit' } }],
});
