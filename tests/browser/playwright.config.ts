import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Smoke tests for a *deployed* Front Desk.
 *
 * BASE_URL      target origin. Defaults to the production deployment.
 *               Set BASE_URL=local to start the root Vite dev server instead,
 *               which talks to whatever VITE_CONVEX_URL Vite loads (the dev
 *               deployment in a checkout; this config never reads .env files).
 * PW_OUTPUT_DIR where traces/screenshots for failures go (gitignored default).
 *
 * Every test gets a fresh browser context (Playwright default), so every test
 * enters the demo as a brand-new anonymous visitor with its own seeded inn.
 * No staff credentials are used anywhere.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const LOCAL_PORT = 4173;
const DEPLOYED = "https://outgoing-zebra-720.convex.site";

const wantsLocal = process.env.BASE_URL === "local";
const baseURL = wantsLocal ? `http://127.0.0.1:${LOCAL_PORT}` : (process.env.BASE_URL ?? DEPLOYED);

export default defineConfig({
  testDir: "./specs",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 3,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: process.env.PW_OUTPUT_DIR ?? "test-results",
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /mobile\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
  webServer: wantsLocal
    ? {
        command: `npx vite --host 127.0.0.1 --port ${LOCAL_PORT} --strictPort`,
        cwd: repoRoot,
        url: `http://127.0.0.1:${LOCAL_PORT}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      }
    : undefined,
});
