import { defineConfig, devices } from "@playwright/test";

const MOCK_BACKEND_PORT = 4100;
const APP_PORT = 3100;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `node tests/e2e/mock-backend.mjs`,
      env: { MOCK_BACKEND_PORT: String(MOCK_BACKEND_PORT) },
      port: MOCK_BACKEND_PORT,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `npx next build && npx next start --port ${APP_PORT}`,
      env: {
        BACKEND_URL: `http://localhost:${MOCK_BACKEND_PORT}`,
      },
      port: APP_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
