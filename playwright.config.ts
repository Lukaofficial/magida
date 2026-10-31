import { defineConfig, devices } from '@playwright/test';

const PORT = 3299;

export default defineConfig({
  testDir: 'e2e',
  timeout: 40_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run build && npm start',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), DATABASE_PATH: ':memory:' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
