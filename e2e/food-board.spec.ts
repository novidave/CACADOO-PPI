import type { Browser, Locator, Page } from "@playwright/test";
import { expect, loginOwner, sk, test, watchConsole } from "./helpers";

/**
 * Objednávky jedla → Objednávky without the feed (2026-11-07) at 1180×820 and 390×844: the green bar is ONE row at
 * 1180 (the menu folded to the rail) and rows on a phone (the close button full width, last); a delay chip changes
 * what the assistant tells customers and back; "Uzavrieť objednávky" → yellow "Objednávky sú uzavreté" → "Otvoriť
 * objednávky"; a pickup order placed in the shop assistant goes Nové → V príprave → Na ceste / na odber by its step
 * buttons, "Vyzdvihnuté" opens the payment dialog (cash, "Presne") and puts it under Doručené, "Vrátiť" brings it back,
 * finished again it needs no payment; on a phone the segmented row shows one column at a time; nothing scrolls
 * sideways. "Len objednávky" (Nastavenia → Čo používate): the Kuriéri tab goes and a finish needs no payment step.
 *
 * Runs only against a test restaurant (it places real orders): E2E_FOOD_SHOP (Pro, "Objednávky jedla" on with pickup
 * and cash, "Platby v Cacaduu" on), E2E_FOOD_ITEM (a Sklad product with a price), E2E_FOOD_PHONE (the site runs with
 * SMS_PROVIDER unset or "test" and BOOKING_TEST_CODES=on), and the owner's login (E2E_OWNER_EMAIL + _PASSWORD or
 * E2E_OWNER_LOGIN_URL). Skipped otherwise (as in CI against the live database).
 */

const SHOP = process.env.E2E_FOOD_SHOP ?? "";
const ITEM = process.env.E2E_FOOD_ITEM ?? "";
const PHONE = process.env.E2E_FOOD_PHONE ?? "";
const f = sk.food;
const c = sk.chat;

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

/** One pickup order ("Osobný odber"), placed in the assistant with the SMS test code; its number. */
async function pickupOrder(browser: Browser): Promise<number> {
  const context = await browser.newContext({ ...test.info().project.use });
  const page = await context.newPage();
  const console = watchConsole(page);
  await page.goto(`/sk/shops/${SHOP}`);
  const box = page.locator("[data-assistant] textarea").first();
  await box.click();
  await box.fill(`Chcem si objednať 1× ${ITEM} na osobný odber.`);
  await page.locator("[data-chat-send]").first().click();
  const panel = page.locator("[data-order-panel]");
  await expect(panel, "the assistant offers the cart card").toBeVisible({ timeout: 90_000 });
  // the visible button is the radio's label (the input itself is visually hidden)
  await panel.locator('[data-order-kind="pickup"]').click();
  await expect(panel.getByRole("radio", { name: c.order_pickup, exact: true })).toBeChecked();
  await expect(panel.locator('input[name="address"]'), "no address for Osobný odber").toHaveCount(0);
  await expect(panel.locator("[data-order-time]")).toContainText(c.order_ready_at.split(" {")[0]);
  // update 85: no payment choice for the customer (the shop marks it at the handover)
  await expect(panel.getByRole("button", { name: /hotovos|QR platba|kartou/i })).toHaveCount(0);
  await panel.locator("[data-order-continue]").click();
  await panel.locator('input[name="name"]').fill("E2E board");
  await panel.locator('input[name="phone"]').fill(PHONE);
  await panel.locator('input[name="consent"]').check();
  await panel.locator("[data-order-send-code]").click();
  const testCode = panel.locator("[data-order-test-code]");
  await expect(testCode).toBeVisible({ timeout: 20_000 });
  await panel.locator("[data-order-code]").fill((await testCode.getAttribute("data-order-test-code")) ?? "");
  await panel.locator("[data-order-place]").click();
  const done = page.locator("[data-order-done]");
  await expect(done).toBeVisible({ timeout: 20_000 });
  // the test restaurant keeps the default payment note
  await expect(done.locator("[data-order-pay-note]")).toHaveText(c.order_pay_note_default);
  const number = Number(await done.getAttribute("data-order-done"));
  console.check();
  await context.close();
  return number;
}

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "no sideways scroll").toBeLessThanOrEqual(0);

type Column = "new" | "preparing" | "on_the_way" | "done";

/** The card of an order in a column; on a phone the segmented row shows that column first. */
async function cardIn(page: Page, col: Column, number: number, phone: boolean): Promise<Locator> {
  if (phone) {
    await page.locator(`[data-food-segment="${col}"]`).click();
    await expect(page.locator(`[data-board-col="${col}"]`)).toBeVisible();
  }
  return page.locator(`[data-board-col="${col}"] [data-food-order="${number}"]`).first();
}

/** The menu folded to the 76 px rail (1180: the bar then has the width for one row); remembered on this device. */
async function foldMenu(page: Page) {
  const fold = page.locator('button[aria-controls="owner-menu"]');
  if ((await fold.count()) && (await fold.getAttribute("aria-expanded")) === "true") {
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
  }
}

for (const size of [{ width: 1180, height: 820 }, { width: 390, height: 844 }]) {
  const phone = size.width < 1024;
  test.describe(`the board at ${size.width}×${size.height}`, () => {
    test.use({ viewport: size });

    test("the green bar; a delay; Uzavrieť / Otvoriť; a card through its steps, the payment dialog and Vrátiť", async ({ page, browser }) => {
      test.skip(!SHOP || !ITEM || !PHONE, "needs E2E_FOOD_SHOP, E2E_FOOD_ITEM and E2E_FOOD_PHONE (a test restaurant)");
      test.skip(!(await loginOwner(page)), "needs an owner login");
      const number = await pickupOrder(browser);
      const console = watchConsole(page);
      await page.goto(`/sk/dashboard/assistant/orders?shop=${SHOP}`);
      if (!phone) {
        await foldMenu(page);
        await page.reload();
      }
      await expect(page.locator("[data-food-view], [data-feed-active]"), "no feed, no view switch").toHaveCount(0);

      // the bar: the first block under the tabs; one row at 1180, rows on a phone
      const bar = page.locator("[data-food-bar]");
      await expect(bar).toBeVisible();
      const tabs = (await page.locator('[data-item-tabs="food"]').boundingBox())!;
      const barBox = (await bar.boundingBox())!;
      expect(barBox.y, "the bar is under the tabs").toBeGreaterThan(tabs.y + tabs.height - 1);
      const state = (await bar.locator("[data-food-bar-state]").boundingBox())!;
      const prep = (await bar.locator('[data-food-stepper="prep_minutes"]').boundingBox())!;
      const close = bar.locator("[data-food-pause]");
      const closeBox = (await close.boundingBox())!;
      if (phone) {
        expect(prep.y, "rows on a phone").toBeGreaterThan(state.y + state.height - 1);
        expect(closeBox.y, "the button last").toBeGreaterThan(prep.y);
        expect(closeBox.width, "the button full width").toBeGreaterThan(barBox.width - 40);
        for (const chip of await bar.locator("[data-food-delay]").all()) expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      } else {
        const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
        expect(Math.abs(mid(prep) - mid(state)), "one row: the stepper beside the state").toBeLessThan(barBox.height / 2);
        expect(Math.abs(mid(closeBox) - mid(state)), "one row: the button at the end").toBeLessThan(barBox.height / 2);
        expect(closeBox.x, "the button at the end").toBeGreaterThan(prep.x);
      }

      // a delay tap changes what the assistant says; back to 0
      const says = bar.locator("[data-food-says-line]");
      const before = (await says.textContent()) ?? "";
      const now = (await bar.locator("[data-food-delay][aria-pressed=true]").getAttribute("data-food-delay")) ?? "0";
      const other = now === "10" ? "20" : "10";
      await bar.locator(`[data-food-delay="${other}"]`).click();
      await expect(bar.locator(`[data-food-delay="${other}"]`)).toHaveAttribute("aria-pressed", "true");
      await expect(says).not.toHaveText(before);
      await bar.locator(`[data-food-delay="${now}"]`).click();
      await expect(bar.locator(`[data-food-delay="${now}"]`)).toHaveAttribute("aria-pressed", "true");

      // Uzavrieť → yellow → Otvoriť
      const tone = (await bar.getAttribute("data-food-bar")) ?? "";
      if (tone !== "paused") {
        await close.click();
        await expect(bar).toHaveAttribute("data-food-bar", "paused", { timeout: 15_000 });
        await expect(bar.locator("[data-food-bar-state]")).toHaveText(f.bar_closed_title);
        await expect(close).toHaveText(f.bar_open);
      }
      await close.click();
      await expect(bar).not.toHaveAttribute("data-food-bar", "paused", { timeout: 15_000 });
      await expect(close).toHaveText(f.bar_close);

      // the phone: one column at a time, four 44 px segments
      if (phone) {
        const segments = page.locator("[data-food-segment]");
        await expect(segments).toHaveCount(4);
        for (const s of await segments.all()) expect((await s.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await page.locator('[data-food-segment="done"]').click();
        await expect(page.locator('[data-board-col="done"]')).toBeVisible();
        await expect(page.locator('[data-board-col="new"]')).toBeHidden();
      } else {
        for (const col of ["new", "preparing", "on_the_way", "done"]) await expect(page.locator(`[data-board-col="${col}"]`)).toBeVisible();
      }
      await noSideways(page);

      // the order: Nové → V príprave → Na ceste / na odber by its own step buttons
      let card = await cardIn(page, "new", number, phone);
      await expect(card, "the new order under Nové").toBeVisible();
      await card.locator('[data-food-step="preparing"]').click();
      card = await cardIn(page, "preparing", number, phone);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.locator('[data-food-step="ready"]').click();
      card = await cardIn(page, "on_the_way", number, phone);
      await expect(card).toBeVisible({ timeout: 15_000 });

      // "Vyzdvihnuté": the payment dialog first (cash, "Presne"), then Doručené
      await card.locator("[data-food-finish]").click();
      const pay = page.locator("[data-food-pay]");
      await expect(pay, "the payment choice before the finish").toBeVisible();
      await pay.locator('[data-food-pay-method="cash"]').click();
      await pay.getByRole("button", { name: f.cash_exact }).click();
      await pay.locator("[data-food-pay-confirm]").click();
      await expect(page.locator("[data-food-toast]")).toContainText(`#${number}`);
      card = await cardIn(page, "done", number, phone);
      await expect(card, "under Doručené").toBeVisible({ timeout: 15_000 });

      // Vrátiť → back to Na ceste / na odber; finished again it needs no payment (the mark stays)
      await card.locator("[data-food-reopen]").click();
      card = await cardIn(page, "on_the_way", number, phone);
      await expect(card, "Vrátiť brings it back").toBeVisible({ timeout: 15_000 });
      await card.locator("[data-food-finish]").click();
      await expect(page.locator("dialog[open]"), "paid already: no dialog").toHaveCount(0);
      card = await cardIn(page, "done", number, phone);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await noSideways(page);
      console.check();
    });
  });
}

const PARTS = ["delivery_on", "courier_app", "payments_on", "deduct_on_delivery", "qr_terminal"] as const;

/** Nastavenia → "Uložiť" in the save bar, and back on the page. */
async function saveSettings(page: Page) {
  await page.locator("[data-save-bar] button[type=submit]").click();
  await expect(page.locator('[role="status"]')).toBeVisible({ timeout: 15_000 });
}

for (const size of [{ width: 1180, height: 820 }, { width: 390, height: 844 }]) {
  const phone = size.width < 1024;
  test.describe(`"Len objednávky" at ${size.width}×${size.height}`, () => {
    test.use({ viewport: size });

    test("Len objednávky hides the Kuriéri tab and the payment step; the shop's own switches come back", async ({ page, browser }) => {
      test.skip(!SHOP || !ITEM || !PHONE, "needs E2E_FOOD_SHOP, E2E_FOOD_ITEM and E2E_FOOD_PHONE (a test restaurant)");
      test.skip(!(await loginOwner(page)), "needs an owner login");
      const settings = `/sk/dashboard/assistant/orders/settings?shop=${SHOP}`;
      await page.goto(settings);
      const parts = page.locator("[data-food-parts]");
      await expect(parts).toBeVisible();
      const before = Object.fromEntries(await Promise.all(PARTS.map(async (p) => [p, await parts.locator(`input[name="${p}"]`).isChecked()])));
      try {
        await page.locator("[data-food-feed-only]").click();
        await expect(page.locator("[data-food-parts-status]")).toHaveAttribute("data-food-parts-status", "feed_only");
        await expect(page.locator("[data-food-parts-status]")).toContainText(f.mod_status_feed_only);
        await expect(page.locator("[data-needs-payments]").first()).toBeHidden();
        await saveSettings(page);
        await expect(page.locator('[data-item-tabs] [data-tab="couriers"]'), "no Kuriéri tab").toHaveCount(0);

        const number = await pickupOrder(browser);
        await page.goto(`/sk/dashboard/assistant/orders?shop=${SHOP}`);
        let card = await cardIn(page, "new", number, phone);
        await card.locator('[data-food-step="preparing"]').click();
        card = await cardIn(page, "preparing", number, phone);
        await card.locator('[data-food-step="ready"]').click();
        card = await cardIn(page, "on_the_way", number, phone);
        await card.locator("[data-food-finish]").click();
        await expect(page.locator("dialog[open]"), "finished without a payment step").toHaveCount(0);
        await expect(await cardIn(page, "done", number, phone)).toBeVisible({ timeout: 15_000 });
      } finally {
        // the shop's own switches as they were
        await page.goto(settings);
        const box = page.locator("[data-food-parts]");
        await box.locator("[data-food-all-on]").click();
        for (const p of ["delivery_on", "payments_on", "deduct_on_delivery", "courier_app", "qr_terminal"] as const) {
          const input = box.locator(`input[name="${p}"]`);
          if ((await input.isChecked()) !== before[p] && (await input.isEnabled())) await input.setChecked(before[p], { force: true });
        }
        await saveSettings(page);
      }
    });
  });
}
