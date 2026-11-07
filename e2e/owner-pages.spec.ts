import { expect, loginOwner, sk, test } from "./helpers";
import type { Page } from "@playwright/test";

/**
 * The owner's "Stránka obchodu" pages in the canvas design (canvas "Cacaduu – webová aplikácia (Môj obchod)", artboards
 * 9–13), at 1180×820, 820×1180 and 390×844: the designed parts are there, the save bar counts a change and "Zrušiť"
 * puts it back, nothing scrolls sideways. Phase 1 = artboard 9 "Môj obchod", phase 2 = artboard 10 "Obsah stránky", phase 3 = artboard 11 "Novinky / Blog", phase 4 = artboard 12 "AI asistent", phase 5 = artboard 13 "Jazyky a inventár → Tovar". Nothing is saved. Needs an owner login and
 * E2E_OWNER_SHOP; skipped otherwise.
 */
const SIZES = [
  { name: "computer", width: 1180, height: 820 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
] as const;

const SHOP = process.env.E2E_OWNER_SHOP ?? "";
const q = SHOP ? `?shop=${encodeURIComponent(SHOP)}` : "";
const d = sk.dashboard;

async function noSideways(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(wide, "no sideways scroll").toBeLessThanOrEqual(1);
}

for (const size of SIZES) {
  const wide = size.width >= 1024;
  test.describe(`owner pages ${size.width}×${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    test.beforeEach(async ({ page }) => {
      test.skip(!SHOP, "needs E2E_OWNER_SHOP");
      test.skip(!(await loginOwner(page)), "no owner login configured (E2E_OWNER_EMAIL/PASSWORD or E2E_OWNER_LOGIN_URL)");
    });

    test("Môj obchod (artboard 9): head, two columns, hours pills and their editor, switches, one save bar", async ({ page }) => {
      await page.goto(`/sk/dashboard${q}`);
      // the head: the title, the live status, "Mimoriadne dni a sviatky" → #holidays
      await expect(page.locator("h1").first()).toHaveText(sk.nav.shop);
      await expect(page.locator("[data-shop-status]")).toBeVisible();
      const special = page.locator("[data-holidays-link]");
      await expect(special).toHaveText(d.special_days_link);
      await expect(special).toHaveAttribute("href", "#holidays");

      // the designed parts
      const details = page.locator("[data-shop-form-details]");
      const hours = page.locator("[data-shop-form-hours]");
      await expect(details.getByRole("heading", { name: d.details_title })).toBeVisible();
      for (const name of ["name", "address", "city", "phone", "email", "website", "facebook_url"]) {
        await expect(details.locator(`[name="${name}"]`)).toBeVisible();
      }
      await expect(page.locator("[data-shop-logo]")).toContainText(d.upload);
      await expect(hours.getByRole("heading", { name: d.hours })).toBeVisible();
      await expect(hours.locator("[data-hours-day]")).toHaveCount(7);
      await expect(page.locator('[data-shop-amenities] input[name="has_card_terminal"]')).toHaveCount(1);
      await expect(page.locator('[data-shop-amenities] input[name="is_active"]')).toHaveCount(1);
      // the parts the artboard does not show are still in the card
      for (const name of ["zip", "country", "timezone", "booking_url"]) await expect(details.locator(`[name="${name}"]`)).toHaveCount(1);
      await expect(details.locator("[data-width-toggle]")).toHaveCount(6);
      await expect(page.locator("#holidays")).toHaveCount(1);
      await expect(page.locator("#delete")).toHaveCount(1);

      // two columns from 1024 px, one below it
      const left = (await details.boundingBox())!;
      const right = (await hours.boundingBox())!;
      if (wide) expect(right.x, "the hours to the right of the details").toBeGreaterThan(left.x + left.width - 1);
      else expect(right.y, "the hours under the details").toBeGreaterThan(left.y + left.height - 1);
      // every pill is at least 44 px high
      for (const pill of await hours.locator("[data-hours-day] button").all()) expect((await pill.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);

      // the save bar counts a change; "Zrušiť" puts it back
      const bar = page.locator("#details [data-save-bar]");
      const unsaved = bar.locator("[data-unsaved]");
      await expect(unsaved).toHaveAttribute("data-unsaved", "0");
      const name = details.locator('[name="name"]');
      const before = await name.inputValue();
      await name.fill(`${before} x`);
      await expect(unsaved).toHaveAttribute("data-unsaved", "1");
      await expect(unsaved).toHaveText(sk.owner.unsaved.replace("{n}", "1"));

      // a tap on a pill opens the small editor; a changed time counts as a second change
      const pill = hours.locator("[data-hours-range], [data-hours-closed]").first();
      await pill.click();
      const dialog = page.locator("[data-hours-dialog]");
      await expect(dialog).toBeVisible();
      await dialog.locator("[data-hours-from]").fill("06:15");
      await dialog.locator("[data-hours-done]").click();
      await expect(dialog).toBeHidden();
      await expect(unsaved).toHaveAttribute("data-unsaved", "2");
      await expect(hours).toContainText("6:15");
      // Esc closes the editor without a change
      await hours.locator("[data-hours-range]").first().click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();

      await bar.getByRole("button", { name: sk.owner.cancel_changes }).click();
      await expect(unsaved).toHaveAttribute("data-unsaved", "0");
      await expect(name).toHaveValue(before);
      await expect(hours).not.toContainText("6:15");
      await noSideways(page);
    });

    test("Obsah stránky (artboard 10): head line, slider settings, slot rows, preview Telefón | Počítač, the save bar", async ({ page }) => {
      await page.goto(`/sk/dashboard/content${q}`);
      await expect(page.locator("h1").first()).toHaveText(sk.account.content_page);
      if ((await page.locator("[data-content-editor]").count()) === 0) {
        test.info().annotations.push({ type: "skipped", description: "database update 38 is not applied" });
        return;
      }
      await expect(page.locator("[data-content-line]")).toContainText(sk.content.slider_title);
      await expect(page.locator("[data-content-upload]")).toHaveText(sk.content.upload_button);
      await expect(page.locator('[data-segment="display"] [data-choice]')).toHaveCount(2);
      const preview = page.locator("[data-content-preview]");
      await expect(preview.locator("[data-device]")).toHaveCount(2);
      // two columns from 1024 px: the preview right of the settings
      const settings = (await page.locator("[data-content-settings]").boundingBox())!;
      const box = (await preview.boundingBox())!;
      if (wide) expect(box.x).toBeGreaterThan(settings.x + settings.width - 1);
      else expect(box.y).toBeGreaterThan(settings.y);
      await preview.locator('[data-device="desktop"]').click();
      await expect(preview.locator('[data-device="desktop"]')).toHaveAttribute("aria-pressed", "true");

      // a change counts; "Zrušiť" puts it back; nothing is saved
      const unsaved = page.locator("[data-content-editor] [data-unsaved]");
      await expect(unsaved).toHaveAttribute("data-unsaved", "0");
      await page.locator('[data-segment="display"] [aria-pressed="false"]').click();
      await expect(unsaved).toHaveAttribute("data-unsaved", "1");
      const rows = page.locator("[data-slot]");
      if ((await rows.count()) > 1) {
        // ▲ ▼ only change the order in the browser: "Poradie zmenené" when nothing else changed
        await page.locator("[data-content-cancel]").click();
        await page.locator("[data-slot-down]").first().click();
        await expect(unsaved).toHaveText(sk.content.order_changed);
        for (const b of await page.locator("[data-slot-handle], [data-slot-up], [data-slot-down]").all()) {
          expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(47.5);
        }
      }
      await page.locator("[data-content-cancel]").click();
      await expect(unsaved).toHaveAttribute("data-unsaved", "0");
      await noSideways(page);
    });

    test("Novinky / Blog (artboard 11): head, filter chips with counts, post rows, the Facebook card when set up", async ({ page }) => {
      await page.goto(`/sk/dashboard/blog${q}`);
      await expect(page.locator("h1").first()).toHaveText(sk.owner_blog.title);
      if ((await page.locator("[data-blog-list]").count()) === 0) {
        test.info().annotations.push({ type: "skipped", description: "database update 37 is not applied" });
        return;
      }
      await expect(page.locator("[data-new-post]")).toBeVisible();
      expect((await page.locator("[data-new-post]").boundingBox())!.height).toBeGreaterThanOrEqual(55.5);
      await expect(page.locator("[data-blog-line]")).toBeVisible();
      const chips = page.locator("[data-blog-filter]");
      expect(await chips.count()).toBeGreaterThanOrEqual(4);
      await expect(page.locator('[data-blog-filter="all"]')).toHaveAttribute("aria-current", "page");
      const all = Number((await page.locator('[data-blog-filter="all"]').innerText()).replace(/\D+/g, ""));
      expect(await page.locator("[data-post]").count()).toBe(all);
      // a filter is a link; its rows are only that kind
      await page.locator('[data-blog-filter="draft"]').click();
      await expect(page).toHaveURL(/f=draft/);
      for (const row of await page.locator("[data-post]").all()) await expect(row).toHaveAttribute("data-status", "draft");
      await page.locator('[data-blog-filter="all"]').click();
      const first = page.locator("[data-post]").first();
      if (await first.count()) {
        expect((await first.boundingBox())!.height).toBeGreaterThanOrEqual(103.5);
        await expect(first.locator("[data-post-edit]")).toHaveAttribute("href", /\/dashboard\/blog\/[0-9a-f-]{36}/);
        await first.locator("[data-post-menu] summary").click();
        await expect(first.locator("[data-post-menu]")).toHaveAttribute("open", "");
      }
      const fb = page.locator("[data-facebook-card]");
      if (await fb.count()) {
        await expect(fb.getByRole("heading", { name: sk.owner_blog.fb_title })).toBeVisible();
        if (wide) expect((await fb.boundingBox())!.x).toBeGreaterThan((await page.locator("[data-blog-list]").boundingBox())!.x + 100);
      }
      await noSideways(page);
    });

    test("AI asistent → Nastavenia (artboard 12): the four cards, the switches, one save bar, Vyskúšať asistenta", async ({ page }) => {
      await page.goto(`/sk/dashboard/assistant${q}`);
      await expect(page.locator('[data-item-tabs="assistant"] [aria-current="page"]')).toHaveText(sk.nav.tabs.assistant_settings);
      const x = sk.asst_page;
      for (const sel of ["[data-assistant-texts]", "[data-assistant-unanswered]", "[data-assistant-does]", "[data-assistant-docs]"]) {
        await expect(page.locator(sel)).toBeVisible();
      }
      await expect(page.locator("[data-assistant-unanswered]").getByRole("heading")).toHaveText(x.unanswered);
      await expect(page.locator("[data-assistant-does]").getByRole("heading")).toHaveText(x.does);
      // two columns from 1024 px
      const left = (await page.locator("[data-assistant-texts]").boundingBox())!;
      const right = (await page.locator("[data-assistant-does]").boundingBox())!;
      if (wide) expect(right.x).toBeGreaterThan(left.x + left.width - 1);
      else expect(right.y).toBeGreaterThan(left.y);
      // the save bar counts a switch; Zrušiť puts it back (nothing is saved)
      const unsaved = page.locator("[data-assistant-form] [data-unsaved]");
      const ask = page.locator('[data-switch="ask_contact"]');
      if (await ask.count()) {
        await expect(unsaved).toHaveAttribute("data-unsaved", "0");
        await ask.click();
        await expect(unsaved).toHaveAttribute("data-unsaved", "1");
        await page.locator("[data-assistant-form] [data-save-bar]").getByRole("button", { name: sk.owner.cancel_changes }).click();
        await expect(unsaved).toHaveAttribute("data-unsaved", "0");
      }
      const docsAll = page.locator("[data-docs-all]");
      if (await docsAll.count()) await expect(docsAll).toHaveAttribute("href", /\/dashboard\/assistant\/documents/);
      const tryIt = page.locator("[data-try-assistant]");
      if (await tryIt.count()) {
        await expect(tryIt).toHaveAttribute("target", "_blank");
        await expect(tryIt).toHaveAttribute("href", /#assistant$/);
      }
      await noSideways(page);
    });
    test("Jazyky a inventár → Tovar (artboard 13): tabs, status strip, search, chips, toolbar, 76 px rows as links, Vybrať", async ({ page }) => {
      await page.goto(`/sk/dashboard/translations${q}${q ? "&" : "?"}at=items`);
      await expect(page.locator('[data-item-tabs="translations"] [data-tab]')).toHaveCount(2);
      await expect(page.locator('[data-item-tabs="translations"] [aria-current="page"]')).toHaveText(sk.nav.tabs.translations_items);
      const items = page.locator("#items");
      await expect(items.locator("[data-file-status]")).toBeVisible();
      await expect(items.locator("[data-items-exact]")).toHaveText(d.items_exact);
      const search = items.locator('[data-items-search] input[name="q"]');
      await expect(search).toHaveAttribute("placeholder", d.search);
      expect((await search.locator("xpath=..").boundingBox())!.height).toBeGreaterThanOrEqual(51.5);
      const chips = items.locator("[data-item-filters] [data-filter]");
      if (await chips.count()) {
        await expect(chips).toHaveCount(5);
        for (const box of await chips.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(47.5);
      }
      await expect(items.locator("[data-items-hint]")).toHaveText(d.items_tap_hint);
      const rows = items.locator("[data-item-row]");
      if (await rows.count()) {
        const first = rows.first();
        expect((await first.boundingBox())!.height).toBeGreaterThanOrEqual(75.5);
        // the whole row is the link to the product's page
        const box = (await first.boundingBox())!;
        const href = await first.locator("[data-item-detail]").getAttribute("href");
        expect(href).toMatch(/\/dashboard\/items\//);
        const linkAt = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("a")?.getAttribute("href") ?? null, { x: box.x + box.width - 30, y: box.y + box.height / 2 });
        expect(linkAt).toBe(href);
        // ticks only behind "Vybrať"; then a tap on the row ticks it, Esc leaves
        const select = items.locator("[data-items-select]");
        if (await select.count()) {
          await expect(items.locator("[data-item-pick]").first()).toBeHidden();
          await select.click();
          await first.click({ position: { x: box.width / 2, y: box.height / 2 } });
          await expect(items.locator("[data-item-pick]").first()).toBeChecked();
          await expect(items.locator("[data-items-selected]")).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(items.locator("[data-items-select]")).toBeVisible();
          await expect(page).toHaveURL(/\/dashboard\/translations/);
        }
      }
      // Texty stránky is the other tab
      await page.locator('[data-item-tabs="translations"] [data-tab="texts"]').click();
      await expect(page.locator('[data-item-tabs="translations"] [aria-current="page"]')).toHaveText(sk.nav.tabs.translations_texts);
      await expect(page.locator("[data-texts-section]")).toBeVisible();
      await noSideways(page);
    });
  });
}
