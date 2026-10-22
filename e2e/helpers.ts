import { test as base, expect, type Page } from "@playwright/test";
import sk from "../src/i18n/messages/sk.json" with { type: "json" };

export { sk, expect };

/**
 * Every test uses this `test`: on a protected Vercel preview the bypass header (VERCEL_AUTOMATION_BYPASS_SECRET) and
 * `x-vercel-skip-toolbar` (no Vercel toolbar — it exists only on previews) go **only to the site under test**. Sent to
 * every request, they turned the toolbar's cross-site requests into failed CORS preflights (net::ERR_FAILED).
 */
export const test = base.extend({
  context: async ({ context, baseURL }, provide) => {
    const origin = new URL(baseURL ?? "http://localhost:3000").origin;
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const extra: Record<string, string> = { "x-vercel-skip-toolbar": "1", ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}) };
    await context.route(
      (url) => url.origin === origin,
      (route) => route.continue({ headers: { ...route.request().headers(), ...extra } }),
    );
    await provide(context);
  },
});
export const SHOP = process.env.E2E_SHOP ?? "potraviny-centrum";

/** Messages that are not the site's fault: map tiles and analytics when the test machine has no internet. */
const OUTSIDE = /openfreemap|tiles\.|ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|_vercel\/(insights|speed-insights)|WebGL|GPU stall/;

/** Collects console errors and page errors; `check()` fails the test if any came from the site itself. */
export function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    // The address goes along: "Failed to load resource" alone does not say what failed.
    const where = m.location()?.url ?? "";
    if (m.type() === "error" && !OUTSIDE.test(`${m.text()} ${where}`)) problems.push(`${m.text().slice(0, 300)} ${where}`.trim());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && new URL(r.url()).origin === new URL(page.url() || r.url()).origin && !OUTSIDE.test(r.url())) {
      problems.push(`${r.status()} ${r.url()}`);
    }
  });
  return { check: () => expect(problems, problems.join("\n")).toEqual([]) };
}

/** The owner's login (skipped when no login is configured). */
export async function loginOwner(page: Page): Promise<boolean> {
  if (process.env.E2E_OWNER_LOGIN_URL) {
    await page.goto(process.env.E2E_OWNER_LOGIN_URL);
    await page.waitForURL(/dashboard/);
    return true;
  }
  const email = process.env.E2E_OWNER_EMAIL;
  const password = process.env.E2E_OWNER_PASSWORD;
  if (!email || !password) return false;
  await page.goto("/sk/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/);
  return true;
}
