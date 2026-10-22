import { defineConfig, devices } from "@playwright/test";

/**
 * Mobile end-to-end checks of the main paths (performance pass): run against any running site —
 * `E2E_BASE_URL=https://preview.example npm run test:e2e` (default http://localhost:3000). The owner checks need a
 * login (E2E_OWNER_EMAIL + E2E_OWNER_PASSWORD, or E2E_OWNER_LOGIN_URL locally) and are skipped without one.
 * Chromium only (the shop PC's folder sync needs it too); a phone (Pixel 7) viewport.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    // Protected Vercel previews: the bypass header (a repository secret; never in the code).
    ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      ? { extraHTTPHeaders: { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET } }
      : {}),
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } } : {}),
  },
  projects: [{ name: "phone", use: { ...devices["Pixel 7"] } }],
});
