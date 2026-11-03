import { expect, loginOwner, test } from "./helpers";
import type { Page } from "@playwright/test";

/**
 * The owner area's shell (back-end layout, 2026-11-03): at 1180×820 the full menu, at 820×1180 the 76 px rail, at
 * 390×844 the top bar and the bottom sheet. Every menu item opens its page and is marked as the current one, only
 * one group of the full menu is open, the sheet closes with Esc (the focus back on the menu button), and no page
 * scrolls sideways. Needs an owner login (E2E_OWNER_EMAIL + E2E_OWNER_PASSWORD or E2E_OWNER_LOGIN_URL); skipped
 * without one.
 */
const SIZES = [
  { name: "computer", width: 1180, height: 820 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
] as const;

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "no sideways scroll").toBeLessThanOrEqual(0);

/** The menu's links (key → address), read from the menu itself. */
async function menuLinks(page: Page, phone: boolean): Promise<[string, string][]> {
  const selector = phone ? "[data-owner-sheet] [data-sheet-item]" : "[data-owner-nav] [data-nav-item]";
  return page.$$eval(selector, (links) =>
    links.map((a) => [a.getAttribute(a.hasAttribute("data-sheet-item") ? "data-sheet-item" : "data-nav-item") ?? "", a.getAttribute("href") ?? ""] as [string, string]),
  );
}

for (const size of SIZES) {
  test.describe(`owner shell ${size.width}×${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    test.beforeEach(async ({ page }) => {
      test.skip(!(await loginOwner(page)), "no owner login configured (E2E_OWNER_EMAIL/PASSWORD or E2E_OWNER_LOGIN_URL)");
    });

    test("every menu item opens its page and is the current one; ?shop= stays", async ({ page }) => {
      const phone = size.name === "phone";
      const shop = process.env.E2E_OWNER_SHOP ?? "";
      await page.goto(shop ? `/sk/dashboard?shop=${encodeURIComponent(shop)}` : "/sk/dashboard");
      const links = await menuLinks(page, phone);
      expect(links.length).toBeGreaterThan(10);
      // the shop pages' links keep the open shop
      if (shop) expect(links.filter(([, href]) => new URL(href, "https://x").searchParams.get("shop") === shop).length).toBeGreaterThan(8);
      for (const [key, href] of links) {
        await page.goto(href);
        if (phone) {
          await expect(page.locator("[data-owner-topbar]")).toBeVisible();
          await page.locator("[data-owner-menu-button]").click();
          await expect(page.locator(`[data-owner-sheet] [data-sheet-item="${key}"]`)).toHaveAttribute("aria-current", "page");
          await page.keyboard.press("Escape");
        } else {
          await expect(page.locator(`[data-owner-nav] [data-nav-item="${key}"]`)).toHaveAttribute("aria-current", "page");
        }
        await noSideways(page);
      }
    });

    if (size.name === "computer") {
      test("only one group is open; the group of the page opens by itself; the work screens get the rail", async ({ page }) => {
        await page.goto("/sk/sync");
        const head = (g: string) => page.locator(`[data-nav-group="${g}"]`);
        await expect(head("account")).toHaveAttribute("aria-expanded", "true");
        await expect(head("page")).toHaveAttribute("aria-expanded", "false");
        await head("page").click();
        await expect(head("page")).toHaveAttribute("aria-expanded", "true");
        await expect(head("account")).toHaveAttribute("aria-expanded", "false");
        await expect(page.locator('[data-nav-list="account"] [data-nav-item]').first()).toBeHidden();
        await page.goto("/sk/dashboard/sklad/sale");
        await expect(page.locator("[data-owner-nav]")).toHaveAttribute("data-owner-nav", "rail");
        await page.goto("/sk/dashboard/sklad");
        await expect(page.locator("[data-owner-nav]")).toHaveAttribute("data-owner-nav", "menu");
        await expect(page.locator("[data-site-header]")).toBeHidden();
      });
    }

    if (size.name === "phone") {
      test("the menu sheet opens, closes with Esc and gives the focus back", async ({ page }) => {
        await page.goto("/sk/dashboard");
        const button = page.locator("[data-owner-menu-button]");
        await button.click();
        await expect(page.locator("[data-owner-sheet]")).toBeVisible();
        await expect(button).toHaveAttribute("aria-expanded", "true");
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-owner-sheet]")).toBeHidden();
        await expect(button).toBeFocused();
        await noSideways(page);
      });
    }
  });
}
