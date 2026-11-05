import { expect, loginOwner, sk, test, watchConsole } from "./helpers";

/**
 * A restaurant's Menu end to end (update 80): the owner uploads a menu (a small PDF; the AI's reading is stubbed in the
 * browser, so the test never spends an AI call), edits a price in the review table and saves it to the menu (one
 * transaction); the restaurant page's "Jedlá" box shows the dish with that price, its row opens the dish's page, whose
 * "Objednať" opens the assistant with the dish in the cart card (priced by food_quote) and the order is placed with the
 * SMS test code.
 *
 * Runs only against a test restaurant made for it (it adds dishes and places an order):
 *   E2E_FOOD_SHOP     the shop's slug: kind food, Pro plan, Sklad as the stock source, "Objednávky jedla" on with
 *                     pickup and cash, room for two more Sklad products
 *   E2E_FOOD_PHONE    a mobile number; the site must run with SMS_PROVIDER unset or "test" and BOOKING_TEST_CODES=on
 * plus the owner's login (E2E_OWNER_EMAIL + E2E_OWNER_PASSWORD, or E2E_OWNER_LOGIN_URL). The new dish is hidden again
 * at the end (Sklad products are never deleted).
 */

const SHOP = process.env.E2E_FOOD_SHOP ?? "";
const PHONE = process.env.E2E_FOOD_PHONE ?? "";
const m = sk.menu;
const c = sk.chat;

/** The smallest PDF that is a PDF (the AI's answer is stubbed; the browser only reads its text). */
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
    "4 0 obj<</Length 88>>stream\nBT /F1 12 Tf 20 150 Td (Polievky) Tj 0 -20 Td (Kapustnica E2E 3,20 EUR alergeny 9) Tj ET\nendstream endobj\n" +
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

test.setTimeout(240_000);

test("a restaurant: import a menu, edit a price, the Jedlá box shows it, the dish page's Objednať → the order with the SMS test code", async ({ page, browser }) => {
  test.skip(!SHOP || !PHONE, "needs E2E_FOOD_SHOP and E2E_FOOD_PHONE (a test restaurant)");
  test.skip(!(await loginOwner(page)), "needs an owner login");
  const dish = `Kapustnica E2E ${Date.now() % 100000}`;

  // 1. the import: the AI's proposal (stubbed), the owner changes the price, "Uložiť do menu"
  await page.route("**/api/owner/menu/read", (route) =>
    route.fulfill({ json: { left: 9, rows: [{ category: "Polievky E2E", name: dish, description: "S klobásou", price: "3.20", variants: [], allergens: [9], tags: [] }] } }),
  );
  await page.goto(`/sk/dashboard/assistant/orders/menu?shop=${SHOP}`);
  const card = page.locator("[data-menu-import-card]");
  if (!(await card.evaluate((el) => (el as HTMLDetailsElement).open))) await card.locator("summary").click();
  await card.locator("[data-menu-import-file]").setInputFiles({ name: "menu.pdf", mimeType: "application/pdf", buffer: PDF });
  const review = card.locator("[data-menu-import-review]");
  await expect(review, "the review table").toBeVisible({ timeout: 30_000 });
  await expect(review.locator("[data-import-name]").first()).toHaveValue(dish);
  await review.locator("[data-import-price]").first().fill("3,40");
  await review.locator("[data-menu-import-save]").click();
  await expect(page.locator("[data-menu-notice]")).toContainText(m.ok_imported.replace("{n}", "1"), { timeout: 20_000 });
  const row = page.locator("[data-dish]", { hasText: dish }).first();
  await expect(row).toBeVisible();
  await expect(row.locator("[data-inline-price]")).toHaveValue("3,40");
  const dishId = (await row.getAttribute("data-dish")) ?? "";

  try {
    // 2. the restaurant page (update 84): the dish is a row of the "Jedlá / Zoznam" box with the confirmed price and a
    //    green dot (available, not tracked); its link opens the dish's page with "Objednať"
    const shopper = await browser.newContext({ ...test.info().project.use });
    const pg = await shopper.newPage();
    const console = watchConsole(pg);
    let rowSeen = false;
    for (let i = 0; i < 8 && !rowSeen; i++) {
      await pg.goto(`/sk/shops/${SHOP}#items`);
      rowSeen = (await pg.locator(`[data-product="${dishId}"]`).count()) > 0;
      if (!rowSeen) await pg.waitForTimeout(10_000); // the public cache is refreshed by the save; a minute at most
    }
    const shown = pg.locator(`[data-product="${dishId}"]`);
    await expect(shown).toBeVisible();
    await expect(shown).toContainText("3,40");
    await expect(shown.locator("[data-stock-dot]")).toHaveAttribute("data-stock-dot", "available");
    await expect(pg.locator(".ppi-tab").first()).toContainText(sk.shop.tab_dishes);
    await expect(pg.locator("[data-shop-stock-line]"), "no stock line for dishes").toHaveCount(0);
    await shown.locator(".ppi-row-name").click();
    await expect(pg.locator("[data-dish-page] h1")).toContainText(dish);
    await expect(pg.locator("[data-dish-page] [data-item-price]")).toContainText("3,40");

    // 3. Objednať → the assistant with the dish in the cart card → the page's form → the SMS test code
    await pg.locator("[data-dish-order]").first().click();
    const panel = pg.locator("[data-order-panel]");
    await expect(panel, "the cart card with the dish").toBeVisible({ timeout: 90_000 });
    await expect(panel.locator("li").first()).toContainText(dish);
    const pickup = panel.getByRole("button", { name: c.order_pickup, exact: true });
    if (await pickup.count()) await pickup.click();
    await panel.getByRole("button", { name: c.order_pay_cash }).click();
    await panel.locator("[data-order-continue]").click();
    await panel.locator('input[name="name"]').fill("E2E zákazník");
    await panel.locator('input[name="phone"]').fill(PHONE);
    await panel.locator('input[name="consent"]').check();
    await panel.locator("[data-order-send-code]").click();
    const testCode = panel.locator("[data-order-test-code]");
    await expect(testCode, "the site shows the SMS test code (BOOKING_TEST_CODES=on, no SMS provider)").toBeVisible({ timeout: 20_000 });
    await panel.locator("[data-order-code]").fill((await testCode.getAttribute("data-order-test-code")) ?? "");
    await panel.locator("[data-order-place]").click();
    await expect(pg.locator("[data-order-done]")).toBeVisible({ timeout: 20_000 });
    console.check();
    await shopper.close();
  } finally {
    // the test dish leaves the menu (its Sklad product stays, as every Sklad product)
    await page.goto(`/sk/dashboard/assistant/orders/menu?shop=${SHOP}`);
    const again = page.locator(`[data-dish="${dishId}"]`);
    if ((await again.count()) && (await again.locator("[data-dish-hidden]").count()) === 0) await again.locator("[data-dish-hide]").click();
  }
});
