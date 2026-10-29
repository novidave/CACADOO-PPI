import { expect, sk, SHOP, test, watchConsole } from "./helpers";

const rowsOf = (page: import("@playwright/test").Page) => page.locator("[data-product-rows] > li");
const firstWord = async (page: import("@playwright/test").Page) =>
  ((await rowsOf(page).first().locator(".ppi-row-name").textContent()) ?? "").trim().split(/\s+/)[0];

/** "Produkty": the rows are filtered while the visitor types, the page does not move, × and Esc clear. */
test("shop search filters live and keeps the page where it is", async ({ page }) => {
  const console = watchConsole(page);
  await page.goto(`/sk/shops/${SHOP}`);
  const input = page.getByRole("searchbox", { name: sk.shop.search_items });
  await input.scrollIntoViewIfNeeded();
  // the search box in the middle of the screen, the page well below its top
  await input.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - window.innerHeight / 2));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(200);
  const all = await rowsOf(page).count();
  const word = await firstWord(page);
  test.skip(word.length < 2, "this shop has no items");

  // typed, no Enter: the list changes by itself, the address keeps the words
  await input.pressSequentially(word, { delay: 30 });
  await expect(page).toHaveURL(new RegExp(`[?&]q=${encodeURIComponent(word).replace(/%20/g, "\\+")}`));
  await expect(rowsOf(page).first()).toContainText(word, { ignoreCase: true });
  await expect(rowsOf(page).first().locator("mark").first()).toBeVisible();
  await expect(page.locator("[data-search-results]")).toContainText(/Nájdené: \d+ produkt/);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - before), "the page did not move").toBeLessThan(4);
  expect(await rowsOf(page).count()).toBeLessThanOrEqual(all);

  // × clears: the whole list again
  await page.getByRole("button", { name: sk.shop.search_clear }).click();
  await expect(input).toHaveValue("");
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(rowsOf(page)).toHaveCount(all);

  // Esc clears too
  await input.fill(word);
  await expect(page).toHaveURL(/[?&]q=/);
  await input.press("Escape");
  await expect(input).toHaveValue("");
  await expect(rowsOf(page)).toHaveCount(all);

  // nothing found: "Pre „…“ sme nič nenašli"
  await page.route(`**/api/shops/${SHOP}/search?*`, (route) => route.fulfill({ json: { q: "qqqzzz", kind: null, total: 0, rows: [] } }));
  await input.fill("qqqzzz");
  await expect(page.locator("[data-search-results]")).toContainText(sk.shop.search_none.replace("{q}", "qqqzzz"));
  console.check();
});

/** A typo (one letter changed in the middle) still finds the product (update 54). */
test("shop search forgives a typo", async ({ page }) => {
  await page.goto(`/sk/shops/${SHOP}`);
  const word = await firstWord(page);
  test.skip(word.length < 4, "this shop has no item with a long enough first word");
  const typo = word.slice(0, 2) + (word[2].toLowerCase() === "x" ? "y" : "x") + word.slice(3);
  const answer = page.waitForResponse((r) => r.url().includes("/search?") && new URL(r.url()).searchParams.get("q") === typo);
  await page.getByRole("searchbox", { name: sk.shop.search_items }).fill(typo);
  await answer;
  await expect(rowsOf(page).filter({ hasText: new RegExp(word, "i") }).first()).toBeVisible();
});

/** An older, slower answer never replaces the newest one. */
test("shop search shows only the newest answer", async ({ page }) => {
  await page.route(`**/api/shops/${SHOP}/search?*`, async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    const row = (name: string) => ({ id: "00000000-0000-0000-0000-000000000001", name, original: null, price: 1, currency: "EUR", priceText: "1,00 €", stock: "available", nameMarks: null, originalMarks: null });
    // the first text answers late, the second at once
    if (q === "ka") await new Promise((r) => setTimeout(r, 1200));
    await route.fulfill({ json: { q, kind: "match", total: 1, rows: [row(q === "ka" ? "OLD ANSWER" : "NEW ANSWER")] } });
  });
  await page.goto(`/sk/shops/${SHOP}`);
  const input = page.getByRole("searchbox", { name: sk.shop.search_items });
  await input.fill("ka");
  await page.waitForTimeout(300); // the first request has left
  await input.fill("kav");
  await expect(rowsOf(page).first()).toContainText("NEW ANSWER");
  await page.waitForTimeout(1500); // the old answer arrives (or was cancelled) — never shown
  await expect(rowsOf(page).first()).toContainText("NEW ANSWER");
});

/** Without JavaScript the search is a plain GET form: the list is filtered on the server; no Zoznam tab. */
test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("shop search works as a plain form", async ({ page }) => {
    await page.goto(`/sk/shops/${SHOP}`);
    await expect(page.locator(".ppi-tabs")).toBeHidden();
    const word = await firstWord(page);
    test.skip(!word, "this shop has no items");
    await page.getByRole("searchbox", { name: sk.shop.search_items }).fill(word);
    await page.getByRole("button", { name: sk.search.button }).first().click();
    await expect(page).toHaveURL(new RegExp(`[?&]q=`));
    await expect(rowsOf(page).first()).toContainText(word, { ignoreCase: true });
    await expect(page.locator("[data-search-results]")).toBeVisible();
  });
});
