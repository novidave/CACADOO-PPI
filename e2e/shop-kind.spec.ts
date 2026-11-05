import { expect, loginOwner, test } from "./helpers";

/**
 * The kind of shop first (update 79): "Nový obchod" asks "Aký je to obchod?" before anything else; a restaurant gets
 * its own setup steps (Menu, Objednávky, Kuriéri, Náhľad a spustenie) and its menu starts with Menu and Objednávky jedla,
 * without the stock-file pages (Priečinok s exportom). The test shop is deleted at the end.
 * Needs an owner login (E2E_OWNER_EMAIL + E2E_OWNER_PASSWORD or E2E_OWNER_LOGIN_URL) whose account has room for one
 * more shop (5 at most); skipped without it.
 */
test("a new restaurant: the kind first, the food setup steps, no stock pages in the menu", async ({ page }) => {
  test.skip(!(await loginOwner(page)), "needs an owner login");
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto("/sk/dashboard?new=1");

  // the first question: two big cards (≥ 52 px), nothing chosen yet
  const cards = page.locator("[data-kind-card]");
  await expect(cards).toHaveCount(2);
  for (const box of [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()]) expect(box!.height).toBeGreaterThanOrEqual(52);
  const kindTop = (await page.locator("[data-new-shop-kind]").boundingBox())!.y;
  const nameTop = (await page.locator('input[name="name"]').boundingBox())!.y;
  expect(kindTop, "the kind is asked before the name").toBeLessThan(nameTop);

  await page.locator('[data-kind-card="food"]').click();
  const name = `E2E Bistro ${Date.now()}`;
  await page.fill('input[name="name"]', name);
  await page.fill('input[name="city"]', "Michalovce");
  await page.fill('input[name="country"]', "SK");
  await page.selectOption('select[name="timezone"]', "Europe/Bratislava");
  await page.locator('form:has([data-new-shop-kind]) button[type="submit"]').last().click();
  await page.waitForURL(/ok=created/);
  const slug = new URL(page.url()).searchParams.get("shop") ?? "";
  expect(slug).not.toBe("");

  try {
    // the restaurant's setup steps, decided in SQL
    const card = page.locator('[data-setup-card="food"]');
    await expect(card).toBeVisible();
    const steps = await card.locator("[data-setup-step]").evaluateAll((els) => els.map((e) => e.getAttribute("data-setup-step")));
    expect(steps).toEqual(["details", "hours", "menu", "orders", "couriers", "assistant", "launch"]);
    await expect(card.locator('[data-setup-skip="couriers"]')).toBeVisible();
    await expect(card.locator('[data-setup-skip="menu"]')).toHaveCount(0);

    // the menu: Menu and Objednávky jedla first in Hlavné, no Priečinok s exportom
    const keys = await page.locator("aside [data-nav-item]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav-item")));
    expect(keys.slice(0, 2)).toEqual(["food_menu", "food"]);
    expect(keys).not.toContain("export");
    // still reachable by its address, with the note
    await page.goto(`/sk/sync?shop=${slug}`);
    await expect(page.locator("[data-not-for-food]")).toBeVisible();
  } finally {
    // the test shop goes again
    await page.goto(`/sk/dashboard?shop=${slug}&at=delete#delete`);
    await page.locator('#delete input[name="confirm"]').check();
    await page.locator('#delete button[type="submit"]').click();
    await page.waitForURL(/ok=deleted|dashboard/);
  }
});
