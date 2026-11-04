import { expect, loginOwner, sk, test } from "./helpers";
import type { Page } from "@playwright/test";

/**
 * CRM → Správy (2026-11-04, database update 76) at 1180×820, 820×1180 and 390×844: the CRM tab row in its place, "SMS
 * tento mesiac" under it, "Komu" finds a contact as the owner types, "+ Nový kontakt" (a dialog) makes a contact and
 * selects it, a tag goes in at the cursor (and an unknown variable is named), "Náhľad" fills the variables for the
 * contact, and — once, on the computer, while SMS run in test mode — "Odoslať" writes the message down without sending
 * it. Needs an owner login, E2E_OWNER_SHOP (a shop made for testing) with Pro; skipped otherwise.
 */
const SIZES = [
  { name: "computer", width: 1180, height: 820 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
] as const;

const SHOP = process.env.E2E_OWNER_SHOP ?? "";
const q = SHOP ? `?shop=${encodeURIComponent(SHOP)}` : "";
const m = sk.crm_msg;

async function tabBox(page: Page) {
  return page.locator('[data-item-tabs="crm"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, height: r.height };
  });
}

for (const size of SIZES) {
  test.describe(`CRM → Správy ${size.width}×${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    test.beforeEach(async ({ page }) => {
      test.skip(!SHOP, "needs E2E_OWNER_SHOP");
      test.skip(!(await loginOwner(page)), "no owner login configured (E2E_OWNER_EMAIL/PASSWORD or E2E_OWNER_LOGIN_URL)");
    });

    test("search a contact, + Nový kontakt selects the new one, a tag, Náhľad, (send in test mode)", async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto(`/sk/dashboard/contacts${q}`);
      const contactsTabs = await tabBox(page);
      await page.goto(`/sk/dashboard/crm/messages${q}`);
      // the tab row exactly where it is on Kontakty; Správy is the open tab
      const tabs = await tabBox(page);
      expect(Math.abs(tabs.x - contactsTabs.x) + Math.abs(tabs.y - contactsTabs.y) + Math.abs(tabs.height - contactsTabs.height)).toBeLessThanOrEqual(1.5);
      await expect(page.locator('[data-item-tabs="crm"] [aria-current="page"]')).toHaveText(sk.nav.tabs.crm_messages);
      const usage = page.locator("[data-sms-usage]");
      if (await usage.count()) expect((await usage.boundingBox())!.y, "SMS usage under the tabs").toBeGreaterThanOrEqual(tabs.y + tabs.height);
      if ((await page.locator("[data-new-contact-open]").count()) === 0) {
        test.info().annotations.push({ type: "skipped", description: "the test shop has no Pro (writing is refused)" });
        return;
      }

      // + Nový kontakt: a dialog; after saving the new contact is the recipient
      const stamp = Date.now().toString().slice(-7);
      const name = `E2E Správy ${size.name} ${stamp}`;
      await page.locator("[data-new-contact-open]").click();
      const dialog = page.locator("[data-new-contact-dialog]");
      await expect(dialog).toBeVisible();
      await dialog.locator('input[name="name"]').fill(name);
      await dialog.locator('input[name="phone"]').fill(`+42190${stamp}0`.slice(0, 13));
      await dialog.locator("[data-new-contact-save]").click();
      await expect(dialog).toBeHidden();
      await expect(page.locator("[data-recipient]")).toContainText(name);

      // Komu: the live search finds it (partial word)
      await page.locator("[data-recipient-change]").click();
      await page.locator("[data-recipient-search]").fill(`správ ${stamp}`);
      const option = page.locator("[data-recipient-option]", { hasText: name });
      await expect(option).toBeVisible();
      await option.click();
      await expect(page.locator("[data-recipient]")).toContainText(name);

      // a tag at the cursor, an unknown variable named
      const body = page.locator("[data-compose-body]");
      await body.click();
      await body.pressSequentially("Dobrý deň ");
      await page.locator('[data-tag="{meno}"]').click();
      await body.pressSequentially(", máme pre vás novinku. {xyz}");
      await expect(body).toHaveValue("Dobrý deň {meno}, máme pre vás novinku. {xyz}");
      await expect(page.locator("[data-tag-unknown]")).toContainText(sk.contacts.tag_unknown.replace("{token}", "{xyz}"));
      await expect(page.locator('[data-tag-pill="known"]').first()).toHaveText("{meno}");
      // the keyboard: Tab to a tag, Enter inserts it where the cursor was
      await body.fill("Ahoj ");
      await body.press("End");
      await page.locator('[data-tag="{obchod}"]').focus();
      await page.keyboard.press("Enter");
      await expect(body).toHaveValue("Ahoj {obchod}");
      await body.fill("Dobrý deň {meno}, máme pre vás novinku.");

      // Náhľad: the variables filled for this contact
      await page.locator("[data-preview]").click();
      await expect(page.locator("[data-preview-body]")).toContainText(`Dobrý deň ${name}, máme pre vás novinku.`);

      // Odoslať once (the computer), only while SMS run in test mode: written down, never sent
      if (size.name === "computer" && (await page.locator("[data-composer]").getByText(sk.contacts.sms_test_note).count()) > 0) {
        await page.locator("[data-send]").click();
        await expect(page.locator("[data-compose-result]")).toHaveAttribute("data-compose-result", "sent_test");
        await page.reload();
        await expect(page.locator("[data-messages-log] li", { hasText: name }).first()).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    });
  });
}

// the texts used above exist in Slovak (a typo would make the test pass for the wrong reason)
test("CRM → Správy texts", () => {
  expect(m.to && m.search_ph && m.new_contact && m.log_title).toBeTruthy();
});
