import type { Browser, Page } from "@playwright/test";
import { expect, loginOwner, sk, test, watchConsole } from "./helpers";

/**
 * "Objednávky jedla" end to end (Prompt 15 phase F5) on a phone (Pixel 7): two orders placed in the shop assistant with
 * the SMS test codes; the owner takes the first all the way to "Doručené" (cash, "Presne"); the second goes to the
 * courier, who signs in with an SMS code, marks "Na ceste", takes the cash and marks "Doručené" — sent twice with the
 * same step UUID, as a weak signal would. The Sklad stock of the product goes down exactly once per order.
 *
 * Runs only against a test shop made for it (it places real orders and takes stock):
 *   E2E_FOOD_SHOP     the shop's slug: Pro plan, Sklad as the stock source, "Objednávky jedla" on with "Donáška", cash
 *                     and "Odpísať zo skladu" on, a delivery zone that covers E2E_FOOD_ADDRESS
 *   E2E_FOOD_ITEM     the name of a Sklad product with a sale price and stock ≥ 2 (what the shopper asks for)
 *   E2E_FOOD_CODE     that product's Sklad code (its row in Sklad → Produkty)
 *   E2E_FOOD_ADDRESS  a delivery address inside the zone
 *   E2E_FOOD_PHONE    a mobile number (the shopper's and the courier's); the site must run with SMS_PROVIDER unset or
 *                     "test" and BOOKING_TEST_CODES=on, so the codes are shown on the page and nothing is sent
 *   E2E_FOOD_COURIER  the courier's name (default "E2E kuriér"; added on the Kuriéri tab when missing)
 * plus the owner's login (E2E_OWNER_EMAIL + E2E_OWNER_PASSWORD, or E2E_OWNER_LOGIN_URL).
 */

const SHOP = process.env.E2E_FOOD_SHOP ?? "";
const ITEM = process.env.E2E_FOOD_ITEM ?? "";
const CODE = process.env.E2E_FOOD_CODE ?? "";
const ADDRESS = process.env.E2E_FOOD_ADDRESS ?? "";
const PHONE = process.env.E2E_FOOD_PHONE ?? "";
const COURIER = process.env.E2E_FOOD_COURIER ?? "E2E kuriér";
const ready = Boolean(SHOP && ITEM && CODE && ADDRESS && PHONE);
const c = sk.chat;

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

/** The product's total in Sklad → Produkty (the owner's own screen, never cached). */
async function stockOf(owner: Page): Promise<number> {
  await owner.goto(`/sk/dashboard/sklad/products?shop=${SHOP}&q=${encodeURIComponent(CODE)}`);
  const total = owner.locator(`[data-sklad-row="${CODE}"] [data-sklad-total]`).first();
  await expect(total).toBeVisible();
  return Number(await total.getAttribute("data-sklad-total"));
}

/** One order in the shop assistant: the AI proposes the cart, the page's own form and the SMS code place it. */
async function orderInAssistant(browser: Browser): Promise<number> {
  const context = await browser.newContext({ ...test.info().project.use });
  const page = await context.newPage();
  const console = watchConsole(page);
  await page.goto(`/sk/shops/${SHOP}`);
  const box = page.locator("[data-assistant] textarea").first();
  await box.click();
  await box.fill(`Chcem si objednať 1× ${ITEM} s donáškou.`);
  await page.locator("[data-chat-send]").first().click();
  const panel = page.locator("[data-order-panel]");
  await expect(panel, "the assistant offers the cart card").toBeVisible({ timeout: 90_000 });
  await expect(panel.locator("li").first()).toContainText(ITEM);
  // 2026-11-06: both ways ALWAYS shown, nothing chosen, "Pokračovať" waits for the customer's own pick
  await expect(panel.locator("[data-order-kind]")).toHaveCount(2);
  await expect(panel.getByRole("radio", { name: c.order_pickup, exact: true })).not.toBeChecked();
  await expect(panel.getByRole("radio", { name: c.order_delivery, exact: true })).not.toBeChecked();
  await expect(panel.locator("[data-order-continue]")).toBeDisabled();
  await expect(panel.locator("[data-order-kind-pick]")).toHaveText(c.order_kind_pick);
  await expect(panel.locator("[data-order-time]")).toHaveCount(0);
  // update 85: "Donáška" shows the address field, "Osobný odber" hides it (what was typed stays)
  const delivery = panel.locator('[data-order-kind="delivery"]');
  await delivery.click();
  await expect(panel.getByRole("radio", { name: c.order_delivery, exact: true })).toBeChecked();
  await expect(panel.locator("[data-order-continue]")).toBeEnabled();
  await expect(panel.locator("[data-order-time]")).toContainText(c.order_delivery_by.split(" {")[0]);
  await panel.locator('input[name="address"]').fill(ADDRESS);
  await panel.locator('input[name="address"]').blur();
  // update 87: with zones the card asks "Kam doručujeme?" — the one zone the address fits is chosen, with its fee;
  // without zones there is no question and no fee
  if (await panel.locator("[data-order-zones]").count()) {
    await expect(panel.locator("[data-order-zones] legend")).toHaveText(c.order_zone_question);
    await expect(panel.locator("[data-order-zone-on]"), "the zone of E2E_FOOD_ADDRESS is chosen").toHaveCount(1);
    await expect(panel.locator("[data-order-fee]"), "the zone's delivery fee").toBeVisible({ timeout: 20_000 });
  } else {
    await expect(panel.locator("[data-order-fee]"), "no zones: no fee").toHaveCount(0);
  }
  await panel.locator('[data-order-kind="pickup"]').click();
  await expect(panel.locator('input[name="address"]')).toHaveCount(0);
  await delivery.click();
  await expect(panel.locator('input[name="address"]')).toHaveValue(ADDRESS);
  // update 85: no payment choice for the customer (the shop marks it at the handover)
  await expect(panel.getByRole("button", { name: /hotovos|QR platba|kartou/i })).toHaveCount(0);
  await panel.locator("[data-order-continue]").click();
  await panel.locator('input[name="name"]').fill("E2E zákazník");
  await panel.locator('input[name="phone"]').fill(PHONE);
  await panel.locator('input[name="consent"]').check();
  await panel.locator("[data-order-send-code]").click();
  const testCode = panel.locator("[data-order-test-code]");
  await expect(testCode, "the site shows the SMS test code (BOOKING_TEST_CODES=on, no SMS provider)").toBeVisible({ timeout: 20_000 });
  await panel.locator("[data-order-code]").fill((await testCode.getAttribute("data-order-test-code")) ?? "");
  await panel.locator("[data-order-place]").click();
  const done = page.locator("[data-order-done]");
  await expect(done).toBeVisible({ timeout: 20_000 });
  await expect(done.locator("[data-order-pay-note]")).toHaveText(c.order_pay_note_default);
  const number = Number(await done.getAttribute("data-order-done"));
  expect(number).toBeGreaterThan(0);
  console.check();
  await context.close();
  return number;
}

/** The owner's detail page of one order (found by its number on the board of the Objednávky tab, 2026-11-07). */
async function openOrder(owner: Page, number: number, list: "new" | "done" = "new") {
  await owner.goto(`/sk/dashboard/assistant/orders?shop=${SHOP}&col=${list}`);
  const card = owner.locator(`[data-board-col="${list}"] [data-food-order="${number}"]`).first();
  await expect(card).toBeVisible();
  await card.locator("a").first().click();
  await expect(owner.locator("[data-food-detail]")).toBeVisible();
}

test("food order: in the assistant, the owner and the courier, the stock taken once", async ({ page, browser }) => {
  test.skip(!ready, "no food test shop (E2E_FOOD_SHOP, E2E_FOOD_ITEM, E2E_FOOD_CODE, E2E_FOOD_ADDRESS, E2E_FOOD_PHONE)");
  test.skip(!(await loginOwner(page)), "no owner login configured (E2E_OWNER_EMAIL/PASSWORD or E2E_OWNER_LOGIN_URL)");
  const before = await stockOf(page);
  expect(before, "the test product needs 2 pieces in stock").toBeGreaterThanOrEqual(2);

  // the courier exists (added once, kept for the next runs)
  await page.goto(`/sk/dashboard/assistant/orders/couriers?shop=${SHOP}`);
  const row = page.locator("[data-courier-row]", { hasText: COURIER });
  if ((await row.count()) === 0) {
    await page.locator('#add input[name="name"]').fill(COURIER);
    await page.locator('#add input[name="phone"]').fill(PHONE);
    await page.locator("[data-courier-add]").click();
    await expect(page.locator("[data-courier-row]", { hasText: COURIER })).toBeVisible();
  } else if ((await row.locator('[data-courier-active="on"]').count()) > 0) {
    await row.locator('[data-courier-active="on"]').click();
    await expect(page.locator("[data-courier-row]", { hasText: COURIER }).locator('[data-courier-active="off"]')).toBeVisible();
  }

  // 1. the owner takes the first order to "Doručené": Na ceste, then cash "Presne" (paid and delivered in one step)
  const first = await orderInAssistant(browser);
  await openOrder(page, first);
  await page.locator('[data-food-step="on_the_way"]').click();
  await expect(page.locator('[data-food-detail="on_the_way"]')).toBeVisible();
  await page.locator("[data-food-cash]").click();
  await page.locator('[data-food-cash-amounts] [data-food-pay="cash"]').first().click();
  await expect(page.locator('[data-food-detail="delivered"]')).toBeVisible();
  await expect(page.locator("[data-food-paid]")).toBeVisible();
  expect(await stockOf(page), "the first order took its piece once").toBe(before - 1);

  // 2. the second order goes to the courier
  const second = await orderInAssistant(browser);
  await openOrder(page, second);
  await page.locator('[data-order-courier] select[name="courier_id"]').selectOption({ label: COURIER });
  await page.locator("[data-order-assign]").click();
  await expect(page.locator("[data-order-courier]")).toContainText(COURIER);

  // the courier's phone: the SMS code, no account
  const phone = await browser.newContext({ ...test.info().project.use });
  const courier = await phone.newPage();
  const courierConsole = watchConsole(courier);
  await courier.goto(`/sk/kurier/prihlasenie/${SHOP}`);
  await courier.locator('input[name="phone"]').fill(PHONE);
  await courier.getByRole("button", { name: sk.courier.send_code }).click();
  const code = courier.locator("[data-courier-test-code]");
  await expect(code).toBeVisible();
  await courier.locator('input[name="code"]').fill((await code.getAttribute("data-courier-test-code")) ?? "");
  await courier.getByRole("button", { name: sk.courier.sign_in }).click();
  await expect(courier.locator("[data-courier-head]")).toBeVisible();
  await expect(courier.locator("[data-site-header]")).toBeHidden();
  await courier.locator('[data-courier-tile="deliveries"]').click();
  await courier.locator("[data-courier-delivery]", { hasText: `#${second}` }).first().click();
  await courier.locator('[data-courier-step="on_the_way"] button[type="submit"]').click();
  await expect(courier.locator('[data-courier-status="on_the_way"]')).toBeVisible();
  await courier.locator("[data-courier-pay-cash]").click();
  const sent = courier.waitForRequest((r) => r.url().endsWith("/api/kurier/step") && r.method() === "POST");
  await courier.locator('[data-courier-step="cash"] button[type="submit"]').click();
  const body = (await sent).postDataJSON() as Record<string, string>;
  await courier.waitForURL(/\/kurier\/donasky/);
  // a weak signal sends the same step again: the same answer, nothing changes twice
  const again = await courier.request.post("/api/kurier/step", { data: body, headers: { Accept: "application/json" } });
  expect(again.status(), await again.text()).toBe(200);
  courierConsole.check();
  await phone.close();

  await openOrder(page, second, "done");
  await expect(page.locator('[data-food-detail="delivered"]')).toBeVisible();
  await expect(page.locator("[data-food-paid]")).toBeVisible();
  expect(await stockOf(page), "each order took its piece exactly once").toBe(before - 2);
});
