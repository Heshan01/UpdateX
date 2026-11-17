import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const baseURL = "http://127.0.0.1:3100";
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve(__dirname, "../../.local/playwright-browsers");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: "./test-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
