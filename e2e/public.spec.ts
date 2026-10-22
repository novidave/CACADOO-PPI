import { expect, test } from "@playwright/test";
import { SHOP, watchConsole } from "./helpers";

test("AI search → shop → product", async ({ page }) => {
  const c = watchConsole(page);
  await page.goto("/sk");
  const box = page.locator("[data-chat-input]");
  await box.fill("káva");
  const pressed = Date.now();
  await box.press("Enter");
  // The question shows at once (tap feedback), the cards follow (AI or the plain results).
  await expect(page.locator("[data-chat-question]")).toBeVisible();
  expect(Date.now() - pressed).toBeLessThan(1500);
  // A card on this site (a shop with its own domain links there instead).
  const card = page.locator("[data-chat-cards] a[href^='/'][href*='/items/']").first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(page).toHaveURL(/\/items\//);
  // Availability is written out (from the database; a stale shop says it is not available), the shop is one tap away.
  await expect(page.locator("main")).toContainText(/na sklade|Vypredané|nie je dostupná/);
  const shopLink = page.locator(`main a[href^='/'][href*='/shops/']`).first();
  await shopLink.click();
  await expect(page).toHaveURL(/\/shops\//);
  await expect(page.locator("h1")).toBeVisible();
  c.check();
});

test("shop page: map, status dot, slider, assistant, access key", async ({ page }) => {
  const c = watchConsole(page);
  await page.goto(`/sk/shops/${SHOP}`);
  // The status in words next to its dot (never colour alone).
  const status = page.locator("[data-status]").first();
  await expect(status.locator("[data-status-dot]")).toBeVisible();
  await expect(status.locator("span.font-semibold").first()).not.toBeEmpty();
  // The map's box is there at once (space reserved), the map itself comes later or on a tap.
  const map = page.locator("[data-map]").first();
  await expect(map).toBeVisible();
  const before = await map.boundingBox();
  await map.tap();
  await expect(map).toHaveAttribute("data-map", "live");
  expect((await map.boundingBox())?.height).toBe(before?.height);
  // The slider (when the shop has content): next slide and the counter.
  const slider = page.locator("[data-content-slider]");
  if (await slider.count()) {
    const next = slider.locator("[data-slider-next]");
    if (await next.isVisible()) {
      const counter = slider.locator("[data-slider-counter]");
      const first = await counter.innerText();
      await next.tap();
      await expect(counter).not.toHaveText(first);
    }
  }
  // The assistant (paid shops): typing works before and after its code arrives; the key dropdown opens.
  const assistant = page.locator("[data-assistant]");
  if (await assistant.count()) {
    const field = assistant.locator("textarea");
    await field.tap();
    await field.pressSequentially("mlieko", { delay: 20 });
    await expect(field).toHaveValue("mlieko");
    const keys = page.locator("[data-key-access]");
    if (await keys.count()) {
      await keys.locator("summary").tap();
      await expect(keys).toHaveAttribute("open", "");
    }
  }
  c.check();
});

test("blog post", async ({ page }) => {
  const c = watchConsole(page);
  await page.goto(`/sk/shops/${SHOP}/blog`);
  const post = page.locator(`main a[href*='/blog/']`).first();
  test.skip((await post.count()) === 0, "this shop has no posts");
  await post.click();
  await expect(page).toHaveURL(/\/blog\/[a-z0-9-]+/);
  await expect(page.locator("article h1, main h1").first()).toBeVisible();
  // Structured data for search engines is in the first HTML.
  expect(await page.locator('script[type="application/ld+json"]').count()).toBeGreaterThan(0);
  c.check();
});

test("language switch", async ({ page }) => {
  const c = watchConsole(page);
  await page.goto(`/sk/shops/${SHOP}`);
  await page.locator("[data-language-picker]").first().tap();
  const dialog = page.locator("[data-language-dialog]");
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-language-search]").fill("english");
  await dialog.locator('a[data-language="en"]').tap();
  await expect(page).toHaveURL(/\/en\//);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  c.check();
});
