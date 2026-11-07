import type { Page } from "@playwright/test";
import { expect, loginOwner, sk, test, watchConsole } from "./helpers";

/**
 * Donáška without zones and the zone the customer picks (update 87, 2026-11-06), on a phone, in the shop assistant:
 *   1. a shop WITHOUT zones (runs only when the test shop has none): Donáška → the address → no zone question, no fee,
 *      the order placed with the SMS test code;
 *   2. two town zones made for the test ("E2E A" = E2E_ZONE_TOWN, "E2E B" = E2E_ZONE_TOWN_2): Donáška → the address in
 *      town A → both buttons, A chosen; B picked → the "nie je v zóne" line; A again → its fee → the order with its fee;
 *      the owner's feed shows the zone's label. The two zones are deleted at the end.
 *
 * Runs only against a test shop made for it (it places real orders): E2E_FOOD_SHOP (food ordering on with Donáška),
 * E2E_FOOD_ITEM (a product with a sale price and stock), E2E_FOOD_PHONE (the site runs with SMS_PROVIDER test and
 * BOOKING_TEST_CODES=on) and the owner's login.
 */

const SHOP = process.env.E2E_FOOD_SHOP ?? "";
const ITEM = process.env.E2E_FOOD_ITEM ?? "";
const PHONE = process.env.E2E_FOOD_PHONE ?? "";
const TOWN_A = process.env.E2E_ZONE_TOWN ?? "Pavlovce nad Uhom";
const TOWN_B = process.env.E2E_ZONE_TOWN_2 ?? "Sobrance";
const LABEL_A = "E2E A " + TOWN_A;
const LABEL_B = "E2E B " + TOWN_B;
const c = sk.chat;
const f = sk.food;

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const settings = () => `/sk/dashboard/assistant/orders/settings?shop=${SHOP}#zones`;

async function addZone(owner: Page, name: string, label: string, town: string, fee: string) {
  await owner.goto(settings());
  const add = owner.locator("#zones details").filter({ hasText: f.s_zone_add }).last();
  if (!(await add.evaluate((el) => (el as HTMLDetailsElement).open))) await add.locator("summary").click();
  const form = add.locator("form");
  await form.locator('input[name="name"]').fill(name);
  await form.locator('input[name="label"]').fill(label);
  await form.locator('select[name="kind"]').selectOption("town");
  await form.locator('input[name="value"]').fill(town);
  await form.locator('input[name="fee"]').fill(fee);
  await form.locator('input[name="minimum"]').fill("0,00");
  await form.getByRole("button", { name: f.s_zone_save }).click();
  await expect(owner.locator("#zones [data-food-zone]").filter({ hasText: name })).toHaveCount(1);
}

async function deleteZone(owner: Page, name: string) {
  await owner.goto(settings());
  const zone = owner.locator("#zones [data-food-zone]").filter({ hasText: name });
  if (!(await zone.count())) return;
  await zone.locator("summary").click();
  await zone.getByRole("button", { name: f.s_zone_delete }).click();
  await expect(owner.locator("#zones [data-food-zone]").filter({ hasText: name })).toHaveCount(0);
}

/** The cart card from the assistant, Donáška and the address typed (left with Enter). */
async function cardWithAddress(page: Page, address: string) {
  await page.goto(`/sk/shops/${SHOP}`);
  const box = page.locator("[data-assistant] textarea").first();
  await box.click();
  await box.fill(`Chcem si objednať 1× ${ITEM} s donáškou.`);
  await page.locator("[data-chat-send]").first().click();
  const panel = page.locator("[data-order-panel]");
  await expect(panel, "the cart card").toBeVisible({ timeout: 90_000 });
  await panel.locator('[data-order-kind="delivery"]').click();
  await panel.locator('input[name="address"]').fill(address);
  await panel.locator('input[name="address"]').press("Enter");
  return panel;
}

async function place(panel: ReturnType<Page["locator"]>) {
  await panel.locator("[data-order-continue]").click();
  await panel.locator('input[name="name"]').fill("E2E zóny");
  await panel.locator('input[name="phone"]').fill(PHONE);
  await panel.locator('input[name="consent"]').check();
  await panel.locator("[data-order-send-code]").click();
  const code = panel.locator("[data-order-test-code]");
  await expect(code).toBeVisible({ timeout: 20_000 });
  await panel.locator("[data-order-code]").fill((await code.getAttribute("data-order-test-code")) ?? "");
  await panel.locator("[data-order-place]").click();
}

test("a shop without zones: Donáška → the address → no question, no fee → the order", async ({ page, browser }) => {
  test.skip(!SHOP || !ITEM || !PHONE, "needs E2E_FOOD_SHOP, E2E_FOOD_ITEM and E2E_FOOD_PHONE");
  test.skip(!(await loginOwner(page)), "needs an owner login");
  await page.goto(settings());
  test.skip((await page.locator("#zones [data-food-zone]").count()) > 0, "the test shop has zones");
  await expect(page.locator("[data-zones-free]")).toHaveText(f.s_zones_free);
  const shopper = await browser.newContext({ ...test.info().project.use });
  const pg = await shopper.newPage();
  const console = watchConsole(pg);
  const panel = await cardWithAddress(pg, "Hocikde 1, Ďaleko");
  await expect(panel.locator("[data-order-zones]")).toHaveCount(0);
  await expect(panel.locator("[data-order-fee]")).toHaveCount(0);
  await expect(panel.locator("[data-order-continue]")).toBeEnabled();
  await place(panel);
  await expect(pg.locator("[data-order-done]")).toBeVisible({ timeout: 20_000 });
  console.check();
  await shopper.close();
});

test("two town zones: the matching one chosen, another → the line, fixed → the order with its fee; the feed names it", async ({ page, browser }) => {
  test.skip(!SHOP || !ITEM || !PHONE, "needs E2E_FOOD_SHOP, E2E_FOOD_ITEM and E2E_FOOD_PHONE");
  test.skip(!(await loginOwner(page)), "needs an owner login");
  await addZone(page, "E2E zóna A", LABEL_A, TOWN_A, "1,50");
  await addZone(page, "E2E zóna B", LABEL_B, TOWN_B, "2,50");
  try {
    const shopper = await browser.newContext({ ...test.info().project.use });
    const pg = await shopper.newPage();
    const console = watchConsole(pg);
    const panel = await cardWithAddress(pg, `Hlavná 1, ${TOWN_A}`);
    await expect(panel.locator("[data-order-zones] legend")).toHaveText(c.order_zone_question);
    const a = panel.locator("[data-order-zone]").filter({ hasText: LABEL_A });
    const b = panel.locator("[data-order-zone]").filter({ hasText: LABEL_B });
    await expect(a).toHaveAttribute("data-order-zone-on", "");
    await expect(b).not.toHaveAttribute("data-order-zone-on", "");
    await expect(a).toContainText("+ 1,50");
    // another zone: refused with the zone's name, never its fee
    await b.click();
    await expect(panel.getByRole("alert")).toHaveText(c.order_err_zone_mismatch.replace("{zone}", LABEL_B));
    await expect(panel.locator("[data-order-fee]")).toHaveCount(0);
    // back to the right one: its fee in the total
    await a.click();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(panel.locator("[data-order-fee]")).toContainText(LABEL_A);
    await expect(panel.locator("[data-order-fee]")).toContainText("1,50");
    await place(panel);
    const done = pg.locator("[data-order-done]");
    await expect(done).toBeVisible({ timeout: 20_000 });
    const number = Number(await done.getAttribute("data-order-done"));
    console.check();
    await shopper.close();
    // the owner's board names the zone (Nové)
    await page.goto(`/sk/dashboard/assistant/orders?shop=${SHOP}&col=new`);
    const card = page.locator(`[data-board-col="new"] [data-food-order="${number}"]`).first();
    await expect(card.locator("[data-food-zone]")).toContainText(LABEL_A);
  } finally {
    await deleteZone(page, "E2E zóna A");
    await deleteZone(page, "E2E zóna B");
  }
});
