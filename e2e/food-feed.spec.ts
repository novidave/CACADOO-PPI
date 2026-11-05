import type { Browser, Page } from "@playwright/test";
import { expect, loginOwner, sk, test, watchConsole } from "./helpers";

/**
 * Objednávky jedla → the feed (database update 81) at 1180×820 and 390×844: a pickup order placed in the shop
 * assistant appears on top; a swipe past 30 % of the card (the payment chosen first: cash, "Presne") puts it grey at
 * the bottom, "Späť" in the toast brings it back; the delay chip changes what the assistant box says; at the end the
 * order is finished with the button and the delay is back at 0.
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

/** One pickup order, paid in cash on receipt, placed in the assistant with the SMS test code; its number. */
async function pickupOrder(browser: Browser): Promise<number> {
  const context = await browser.newContext({ ...test.info().project.use });
  const page = await context.newPage();
  const console = watchConsole(page);
  await page.goto(`/sk/shops/${SHOP}`);
  const box = page.locator("[data-assistant] textarea").first();
  await box.click();
  await box.fill(`Chcem si objednať 1× ${ITEM} na osobný odber, platím hotovosťou.`);
  await page.locator("[data-chat-send]").first().click();
  const panel = page.locator("[data-order-panel]");
  await expect(panel, "the assistant offers the cart card").toBeVisible({ timeout: 90_000 });
  const pickup = panel.getByRole("button", { name: c.order_pickup, exact: true });
  if (await pickup.count()) await pickup.click();
  await panel.getByRole("button", { name: c.order_pay_cash }).click();
  await panel.locator("[data-order-continue]").click();
  await panel.locator('input[name="name"]').fill("E2E feed");
  await panel.locator('input[name="phone"]').fill(PHONE);
  await panel.locator('input[name="consent"]').check();
  await panel.locator("[data-order-send-code]").click();
  const testCode = panel.locator("[data-order-test-code]");
  await expect(testCode).toBeVisible({ timeout: 20_000 });
  await panel.locator("[data-order-code]").fill((await testCode.getAttribute("data-order-test-code")) ?? "");
  await panel.locator("[data-order-place]").click();
  const done = page.locator("[data-order-done]");
  await expect(done).toBeVisible({ timeout: 20_000 });
  const number = Number(await done.getAttribute("data-order-done"));
  console.check();
  await context.close();
  return number;
}

/** A sideways drag on a card with the pointer (a finger's swipe on a phone is the same pointer events). */
async function swipe(page: Page, selector: string, share: number) {
  const card = page.locator(selector).first();
  await card.scrollIntoViewIfNeeded();
  const box = (await card.boundingBox())!;
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width * 0.2;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  const steps = 10;
  for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + (box.width * share * i) / steps, y);
  await page.mouse.up();
}

for (const size of [{ width: 1180, height: 820 }, { width: 390, height: 844 }]) {
  test.describe(`the feed at ${size.width}×${size.height}`, () => {
    test.use({ viewport: size });

    test("swipe → grey at the bottom, Späť → back; the delay changes the assistant box", async ({ page, browser }) => {
      test.skip(!SHOP || !ITEM || !PHONE, "needs E2E_FOOD_SHOP, E2E_FOOD_ITEM and E2E_FOOD_PHONE (a test restaurant)");
      test.skip(!(await loginOwner(page)), "needs an owner login");
      const number = await pickupOrder(browser);
      const console = watchConsole(page);
      await page.goto(`/sk/dashboard/assistant/orders?shop=${SHOP}&view=feed`);
      const active = page.locator(`[data-feed-active] [data-feed-number="${number}"]`);
      await expect(active, "the new order is a card in the feed").toBeVisible();
      await expect(page.locator("[data-feed-active] [data-feed-card]").first(), "newest on top").toHaveAttribute("data-feed-number", String(number));

      // a short drag springs back
      await swipe(page, `[data-feed-active] [data-feed-number="${number}"]`, 0.15);
      await expect(active).toBeVisible();
      await expect(page.locator("dialog[open]"), "no dialog after a short drag").toHaveCount(0);

      // past 30 %: unpaid → the payment choice first (cash, "Presne"), then grey at the bottom
      await swipe(page, `[data-feed-active] [data-feed-number="${number}"]`, 0.6);
      const pay = page.locator("[data-feed-pay]");
      await expect(pay, "the payment choice before the finish").toBeVisible();
      await pay.locator('[data-feed-pay-method="cash"]').click();
      await pay.getByRole("button", { name: f.cash_exact }).click();
      await pay.locator("[data-feed-pay-confirm]").click();
      const grey = page.locator(`[data-feed-done] [data-feed-number="${number}"]`);
      await expect(grey, "grey in Vybavené dnes").toBeVisible({ timeout: 15_000 });
      await expect(active).toHaveCount(0);
      await expect(page.locator("[data-feed-toast]")).toContainText(`#${number}`);

      // Späť → active again (the payment mark stays)
      await page.locator("[data-feed-undo]").click();
      await expect(active, "Späť brings it back").toBeVisible({ timeout: 15_000 });
      await expect(grey).toHaveCount(0);
      await page.reload();
      await expect(page.locator(`[data-feed-active] [data-feed-number="${number}"]`), "SQL has it back too").toBeVisible();

      // the delay: the assistant box says the new time at once
      const says = page.locator("[data-feed-says-pickup]");
      const prep = Number((await page.locator('[data-feed-value="prep_minutes"]').textContent())?.match(/\d+/)?.[0] ?? "0");
      await page.locator('[data-feed-delay="10"]').click();
      await expect(says).toContainText(`${prep + 10} min)`);
      await expect(page.locator('[data-feed-delay="10"]')).toHaveAttribute("aria-pressed", "true");
      await page.locator('[data-feed-delay="0"]').click();
      await expect(says).toContainText(`${prep} min)`);

      // tidy: finished with the button (already paid), stays grey
      await page.locator(`[data-feed-active] [data-feed-number="${number}"] [data-feed-finish]`).click();
      await expect(page.locator(`[data-feed-done] [data-feed-number="${number}"]`)).toBeVisible({ timeout: 15_000 });
      console.check();
    });
  });
}
