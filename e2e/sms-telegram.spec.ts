import type { Page } from "@playwright/test";
import { expect, loginOwner, sk, test, watchConsole } from "./helpers";

/**
 * "SMS a Telegram" (2026-11-07): every SMS and Telegram setting on one page, each in ONE place. The old addresses
 * forward with their query (/dashboard/hours-sms → the SMS tab, /dashboard/ai#telegram → the Telegram tab); the booking
 * SMS switches are gone from Rezervácie → Nastavenia (a link line instead) and save on SMS a Telegram without touching
 * the alert e-mail that stays on Rezervácie (update 89: only the keys sent change); a restaurant's "Objednávka je na
 * ceste" is gone from Objednávky jedla → Nastavenia (a link line) and lives under "SMS pri objednávkach jedla". At
 * 1180×820 and 390×844; nothing scrolls sideways. Needs an owner login and E2E_OWNER_SHOP (Pro); the restaurant part
 * also E2E_FOOD_SHOP with food orders on.
 */

const SHOP = process.env.E2E_OWNER_SHOP ?? "";
const FOOD = process.env.E2E_FOOD_SHOP ?? "";
const s = sk.smstg;

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "no sideways scroll").toBeLessThanOrEqual(0);

for (const size of [{ width: 1180, height: 820 }, { width: 390, height: 844 }]) {
  test.describe(`SMS a Telegram at ${size.width}×${size.height}`, () => {
    test.use({ viewport: size });
    test.beforeEach(async ({ page }) => {
      test.skip(!SHOP, "needs E2E_OWNER_SHOP");
      test.skip(!(await loginOwner(page)), "needs an owner login");
    });

    test("old addresses forward with their query; the two tabs", async ({ page }) => {
      const console = watchConsole(page);
      await page.goto(`/sk/dashboard/hours-sms?shop=${SHOP}&ok=ok_verified`);
      await expect(page).toHaveURL(/\/sk\/dashboard\/sms-telegram\?/);
      const url = new URL(page.url());
      expect(url.searchParams.get("shop")).toBe(SHOP);
      expect(url.searchParams.get("tab")).toBe("sms");
      expect(url.searchParams.get("ok"), "the query goes along").toBe("ok_verified");
      await expect(page.locator("#hours-sms")).toBeVisible();
      await expect(page.locator('[data-item-tabs="smstg"] [aria-current="page"]')).toHaveAttribute("data-tab", "sms");

      // the bot's old link: /dashboard/ai#telegram → the Telegram tab
      await page.goto(`/sk/dashboard/ai?shop=${SHOP}#telegram`);
      await page.waitForURL(/\/sk\/dashboard\/sms-telegram\?.*tab=telegram/);
      await expect(page.locator('[data-item-tabs="smstg"] [aria-current="page"]')).toHaveAttribute("data-tab", "telegram");
      await expect(page.locator("[data-telegram]")).toBeVisible();
      await noSideways(page);
      console.check();
    });

    test("the booking SMS moved: a link on Rezervácie, saved on SMS a Telegram, the alert e-mail untouched", async ({ page }) => {
      await page.goto(`/sk/dashboard/bookings?shop=${SHOP}&tab=settings`);
      const part = page.locator('[data-settings-part="messages"]');
      await expect(part).toBeVisible();
      await expect(part.locator('input[name="reminder_on"], input[name="notify_on_owner_change"]'), "the switches left Rezervácie").toHaveCount(0);
      const email = (await part.locator('input[name="alert_email"]').inputValue()) ?? "";
      const link = part.locator("[data-moved-sms] a");
      await expect(link).toHaveText(s.moved_link);
      await link.click();
      await page.waitForURL(/\/sms-telegram\?.*tab=sms/);

      const card = page.locator('[data-sms-part="bookings"]');
      await expect(card).toBeVisible();
      const toggle = card.locator('input[name="reminder_on"]');
      test.skip(await toggle.isDisabled(), "the shop has no Pro (the switches are read-only)");
      const was = await toggle.isChecked();
      await toggle.setChecked(!was);
      await card.locator('button[type="submit"]').click();
      await expect(page.locator('[data-sms-notice="ok"]')).toHaveText(s.ok_booking_sms);
      await expect(page.locator('[data-sms-part="bookings"] input[name="reminder_on"]')).toBeChecked({ checked: !was });

      // the alert e-mail on Rezervácie is what it was (only the keys sent changed)
      await page.goto(`/sk/dashboard/bookings?shop=${SHOP}&tab=settings`);
      await expect(page.locator('[data-settings-part="messages"] input[name="alert_email"]')).toHaveValue(email);

      // back as it was
      await page.goto(`/sk/dashboard/sms-telegram?shop=${SHOP}&tab=sms`);
      await page.locator('[data-sms-part="bookings"] input[name="reminder_on"]').setChecked(was);
      await page.locator('[data-sms-part="bookings"] button[type="submit"]').click();
      await expect(page.locator('[data-sms-notice="ok"]')).toBeVisible();
      await noSideways(page);
    });

    test("a restaurant's 'Objednávka je na ceste' moved from Objednávky jedla → Nastavenia", async ({ page }) => {
      test.skip(!FOOD, "needs E2E_FOOD_SHOP");
      await page.goto(`/sk/dashboard/assistant/orders/settings?shop=${FOOD}`);
      await expect(page.locator('input[name="sms_on_the_way"]'), "the switch left Nastavenia").toHaveCount(0);
      await page.locator("[data-moved-sms] a").click();
      await page.waitForURL(/\/sms-telegram\?.*tab=sms/);
      const card = page.locator('[data-sms-part="food"]');
      test.skip((await card.count()) === 0, "food orders are off for this restaurant");
      await expect(card.locator('input[name="sms_on_the_way"]')).toHaveCount(1);
      await expect(page.locator('[data-sms-usage] [data-sms-quota="order"]'), "the order quota in SMS tento mesiac").toHaveCount(1);
      await noSideways(page);
    });
  });
}
