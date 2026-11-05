import { expect, test, type Page } from "@playwright/test";
import { loginOwner } from "./helpers";

/**
 * The admin area (2026-11-05): its own shell and menu, one page per topic (@/lib/adminPages). With an admin login
 * (E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD, else skipped), at 1180×820 and 390×844: every menu item opens its page and is
 * the current one (aria-current); an old /admin/domains#section link lands on its new page. With an owner login that is
 * not an admin (E2E_OWNER_*): /admin and every admin page answer 404.
 */

const PAGES = [
  ["home", "/sk/admin"],
  ["shops", "/sk/admin/shops"],
  ["errors", "/sk/admin/errors"],
  ["domains", "/sk/admin/domains"],
  ["limits", "/sk/admin/limits"],
  ["sms", "/sk/admin/sms"],
  ["integrations", "/sk/admin/integrations"],
  ["translations", "/sk/admin/translations"],
  ["search", "/sk/admin/search"],
  ["partners", "/sk/admin/partners"],
  ["inventory", "/sk/admin/inventory"],
  ["holidays", "/sk/admin/holidays"],
] as const;

async function loginAdmin(page: Page): Promise<boolean> {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) return false;
  await page.goto("/sk/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard|admin/);
  return true;
}

for (const size of [
  { width: 1180, height: 820 },
  { width: 390, height: 844 },
]) {
  const phone = size.width < 768;
  test.describe(`admin ${size.width}×${size.height}`, () => {
    test.use({ viewport: size, isMobile: phone, hasTouch: phone });

    test("every menu item opens its page and is the current one", async ({ page }) => {
      test.skip(!(await loginAdmin(page)), "needs E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD");
      await page.goto("/sk/admin");
      for (const [key, path] of PAGES) {
        const scope = phone ? page.locator("[data-admin-sheet]") : page.locator("[data-admin-menu]");
        if (phone) {
          await page.locator("[data-admin-menu-button]").click();
          await expect(scope).toBeVisible();
        }
        await scope.locator(`[data-admin-item="${key}"]`).click();
        await page.waitForURL(new RegExp(`${path.replace(/\//g, "\\/")}(\\?|#|$)`));
        if (phone) await expect(page.locator("[data-admin-sheet]")).toBeHidden();
        await expect(page.locator(`[data-admin-head="${key}"] h1`)).toBeVisible();
        const menu = phone ? page.locator("[data-admin-sheet]") : page.locator("[data-admin-menu]");
        await expect(menu.locator(`[data-admin-item="${key}"]`)).toHaveAttribute("aria-current", "page");
        await expect(menu.locator('[aria-current="page"]')).toHaveCount(1);
        // nothing sideways
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(wide, `${key} scrolls sideways`).toBeLessThanOrEqual(0);
      }
    });

    test("an old /admin/domains link lands on its new page; Späť do Môj obchod", async ({ page }) => {
      test.skip(!(await loginAdmin(page)), "needs E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD");
      await page.goto("/sk/admin/domains#sms");
      await page.waitForURL(/\/sk\/admin\/sms#sms$/);
      await page.goto("/sk/admin/domains?hcountry=HU");
      await page.waitForURL(/\/sk\/admin\/holidays\?hcountry=HU/);
      await page.goto("/sk/admin/translations#limits");
      await page.waitForURL(/\/sk\/admin\/limits#translation-limits$/);
      if (!phone) {
        await page.locator("[data-admin-menu] [data-admin-back]").click();
        await page.waitForURL(/\/sk\/dashboard/);
      }
    });
  });
}

test("a shop owner who is not the admin gets 404 on /admin and every admin page", async ({ page }) => {
  test.skip(!(await loginOwner(page)), "needs an owner login (not an admin)");
  for (const [, path] of PAGES) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
  }
});

test("Obchody a domény: Otvoriť opens a shop's row in place and Zavrieť closes it", async ({ page }) => {
  test.skip(!(await loginAdmin(page)), "needs E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD");
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto("/sk/admin/shops");
  const toggle = page.locator("[data-row-toggle]").first();
  test.skip((await toggle.count()) === 0, "no shop with a domain");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const panel = page.locator(`#${await toggle.getAttribute("aria-controls")}`);
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toBeVisible();
  // Platba, Websupport, Platí do, E-mail o spustení
  await expect(panel.locator("span.text-xs")).toHaveCount(4);
  await toggle.click();
  await expect(panel).toBeHidden();
  // the Stav filter: "S problémom" is the current one after a tap
  await page.locator('[data-status-filter] [data-status="problem"]').click();
  await page.waitForURL(/status=problem/);
  await expect(page.locator('[data-status-filter] [data-status="problem"]')).toHaveAttribute("aria-current", "true");
});
