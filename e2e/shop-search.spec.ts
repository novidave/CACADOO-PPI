import { expect, sk, SHOP, test, watchConsole } from "./helpers";

/** "Tovar v obchode": searching changes the list in place — the page does not jump to the top. */
test("shop items search keeps the page where it is", async ({ page }) => {
  const console = watchConsole(page);
  await page.goto(`/sk/shops/${SHOP}`);
  const input = page.getByRole("combobox", { name: sk.shop.search_items });
  await input.scrollIntoViewIfNeeded();
  // the search box in the middle of the screen, the page well below its top
  await input.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - window.innerHeight / 2));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(200);
  const items = page.locator("#items > ul li");
  const all = await items.count();
  const word = ((await items.first().locator("a").first().textContent()) ?? "").trim().split(/\s+/)[0];
  test.skip(!word, "this shop has no items");

  await input.fill(word);
  await input.press("Enter");
  await expect(page).toHaveURL(new RegExp(`[?&]q=${encodeURIComponent(word).replace(/%20/g, "\\+")}`));
  await expect(page.locator("#items > ul li").first()).toContainText(word, { ignoreCase: true });
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - before), "the page did not move").toBeLessThan(4);
  expect(await page.locator("#items > ul li").count()).toBeLessThanOrEqual(all);
  await expect(input).toHaveValue(word);
  // "Výsledky pre „…“ (N)" + "Zrušiť"
  await expect(page.locator("[data-search-results]")).toContainText(word);

  // "Zrušiť" shows the whole list again
  await page.getByRole("link", { name: sk.shop.search_clear }).click();
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(page.locator("#items > ul li")).toHaveCount(all);
  console.check();
});

/** The dropdown (update 54): suggestions from 2 letters, ↑ ↓ Enter Esc, only the newest answer, typos still found. */
test("shop search dropdown: suggestions, keyboard, newest answer only", async ({ page }) => {
  const console = watchConsole(page);
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes(`/api/shops/${SHOP}/search`)) asked.push(new URL(r.url()).searchParams.get("q") ?? "");
  });
  await page.goto(`/sk/shops/${SHOP}`);
  const input = page.getByRole("combobox", { name: sk.shop.search_items });
  const word = ((await page.locator("#items > ul li a").first().textContent()) ?? "").trim().split(/\s+/)[0];
  test.skip(word.length < 4, "this shop has no item with a long enough first word");

  // one letter: nothing is asked
  await input.pressSequentially(word.slice(0, 1));
  await page.waitForTimeout(400);
  expect(asked).toHaveLength(0);

  // typed quickly: only the last text is asked (200 ms after the last key), and its answer is shown
  await input.pressSequentially(word.slice(1), { delay: 30 });
  const list = page.getByRole("listbox", { name: sk.shop.search_suggestions });
  await expect(list).toBeVisible();
  expect(asked.at(-1)).toBe(word);
  expect(asked.length).toBeLessThanOrEqual(2);
  const options = list.getByRole("option");
  expect(await options.count()).toBeGreaterThan(0);
  expect(await page.locator("[data-suggestion]").count()).toBeLessThanOrEqual(8);
  await expect(list.locator("mark").first()).toBeVisible();
  await expect(page.locator("[data-suggestions-all]")).toBeVisible();

  // ↓ chooses the first suggestion, Esc closes, ↓ opens again
  await input.press("ArrowDown");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute("aria-activedescendant", /.+/);
  await input.press("Escape");
  await expect(list).toBeHidden();
  await input.press("ArrowDown");
  await expect(list).toBeVisible();

  // a typo (one letter changed in the middle) still finds the product
  const typo = word.slice(0, 2) + (word[2].toLowerCase() === "x" ? "y" : "x") + word.slice(3);
  const typoAnswer = page.waitForResponse((r) => r.url().includes("/search?") && new URL(r.url()).searchParams.get("q") === typo);
  await input.fill(typo);
  await typoAnswer;
  await expect(page.locator("[data-suggestion]").filter({ hasText: new RegExp(word, "i") }).first()).toBeVisible();

  // Enter on the chosen suggestion opens the product
  await input.fill(word);
  await expect(page.locator("[data-suggestion]").first()).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/sk\/items\//);
  console.check();
});

/** An older, slower answer never replaces the newest one. */
test("shop search dropdown shows only the newest answer", async ({ page }) => {
  await page.route(`**/api/shops/${SHOP}/search?*`, async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    const item = (name: string) => ({ id: "00000000-0000-0000-0000-000000000001", name, original: null, price: "1,00 €", stock: "available", availability: "1 ks na sklade", category: null, matched: [] });
    // the first text answers late, the second at once
    if (q === "ka") await new Promise((r) => setTimeout(r, 1200));
    await route.fulfill({ json: { q, kind: "match", total: 1, items: [item(q === "ka" ? "OLD ANSWER" : "NEW ANSWER")] } });
  });
  await page.goto(`/sk/shops/${SHOP}`);
  const input = page.getByRole("combobox", { name: sk.shop.search_items });
  await input.fill("ka");
  await page.waitForTimeout(300); // the first request has left
  await input.fill("kav");
  await expect(page.locator("[data-suggestion]").first()).toContainText("NEW ANSWER");
  await page.waitForTimeout(1500); // the old answer arrives (or was cancelled) — never shown
  await expect(page.locator("[data-suggestion]").first()).toContainText("NEW ANSWER");
});

/** Without JavaScript the search is a plain GET form: the list is filtered on the server. */
test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("shop search works as a plain form", async ({ page }) => {
    await page.goto(`/sk/shops/${SHOP}`);
    const word = ((await page.locator("#items > ul li a").first().textContent()) ?? "").trim().split(/\s+/)[0];
    test.skip(!word, "this shop has no items");
    await page.getByRole("combobox", { name: sk.shop.search_items }).fill(word);
    await page.getByRole("button", { name: sk.search.button }).first().click();
    await expect(page).toHaveURL(new RegExp(`[?&]q=`));
    await expect(page.locator("#items > ul li").first()).toContainText(word, { ignoreCase: true });
    await expect(page.locator("[data-search-results]")).toBeVisible();
  });
});
