import { expect, sk, SHOP, test, watchConsole } from "./helpers";

/** "Tovar v obchode": searching changes the list in place — the page does not jump to the top. */
test("shop items search keeps the page where it is", async ({ page }) => {
  const console = watchConsole(page);
  await page.goto(`/sk/shops/${SHOP}`);
  const input = page.getByRole("searchbox", { name: sk.shop.search_items });
  await input.scrollIntoViewIfNeeded();
  // the search box in the middle of the screen, the page well below its top
  await input.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - window.innerHeight / 2));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(200);
  const items = page.locator("#items li");
  const all = await items.count();
  const word = ((await items.first().locator("a").first().textContent()) ?? "").trim().split(/\s+/)[0];
  test.skip(!word, "this shop has no items");

  await input.fill(word);
  await input.press("Enter");
  await expect(page).toHaveURL(new RegExp(`[?&]q=${encodeURIComponent(word).replace(/%20/g, "\\+")}`));
  await expect(page.locator("#items li").first()).toContainText(word, { ignoreCase: true });
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - before), "the page did not move").toBeLessThan(4);
  expect(await page.locator("#items li").count()).toBeLessThanOrEqual(all);
  await expect(input).toHaveValue(word);

  // an empty search shows the whole list again, still in place
  await input.fill("");
  await input.press("Enter");
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(page.locator("#items li")).toHaveCount(all);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThan(4);
  console.check();
});
