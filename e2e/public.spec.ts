import { expect, SHOP, sk, test, watchConsole } from "./helpers";

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
  await expect(status).toContainText(/\p{L}/u);
  // The map's box is there at once (space reserved), the map itself comes later or on a tap.
  const map = page.locator("[data-map]").first();
  await expect(map).toBeVisible();
  const before = await map.boundingBox();
  const style = page.waitForRequest((r) => r.url().includes("tiles.openfreemap.org/styles/"), { timeout: 15_000 });
  await map.tap();
  await expect(map).toHaveAttribute("data-map", "live");
  // OSM Bright (OpenFreeMap "bright"), the one map style of the site (2026-10-31)
  expect((await style).url()).toContain("/styles/bright");
  expect((await map.boundingBox())?.height).toBe(before?.height);
  // The slider (when the shop has content, Screen 11): one frame for every slide (update 44), swipe only — no arrows,
  // no counter; a pill per slide moves to it, and the line under the frame never moves. "Čítať" opens the post under
  // the slider (its text is already in the HTML) and closes it again; another slide closes it.
  const slider = page.locator("[data-content-slider]");
  if (await slider.count()) {
    await slider.scrollIntoViewIfNeeded();
    const frames = await slider.locator("[data-slide-frame]").evaluateAll((els) =>
      els.map((e) => `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`),
    );
    expect(new Set(frames).size).toBe(1);
    await expect(slider.getByText("Zobraziť text")).toHaveCount(0);
    await expect(slider.locator("[data-slider-next], [data-slider-prev], [data-slider-counter]")).toHaveCount(0);
    const article = slider.locator("[data-post-article]");
    const read = slider.locator('[data-slide="0"] [data-slide-read][aria-expanded]');
    if ((await article.count()) && (await read.count())) {
      await expect(article.locator("[data-inline-article]").first()).toBeAttached();
      await read.tap();
      await expect(read).toHaveAttribute("aria-expanded", "true");
      await expect(article).toHaveAttribute("data-open", "true");
      await read.tap();
      await expect(read).toHaveAttribute("aria-expanded", "false");
    }
    const second = slider.locator('[data-slider-dot="1"]');
    if (await second.count()) {
      const nav = () => slider.locator("[data-slider-pills]").evaluate((e) => {
        const r = e.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map(Math.round).join(",");
      });
      const before = await nav();
      await second.tap();
      await expect(second).toHaveAttribute("aria-pressed", "true");
      await expect(slider.locator('[data-slider-dot="0"]')).toHaveAttribute("aria-pressed", "false");
      await page.waitForTimeout(600);
      expect(await nav()).toEqual(before);
      // a swipe back to the first slide
      const track = slider.locator("[data-slider-track]");
      await track.evaluate((el) => el.scrollTo({ left: 0, behavior: "instant" }));
      await expect(slider.locator('[data-slider-dot="0"]')).toHaveAttribute("aria-pressed", "true");
    }
  }
  // The assistant (paid shops): typing works before and after its code arrives; the key row opens.
  const assistant = page.locator("[data-assistant]");
  if (await assistant.count()) {
    const field = assistant.locator("textarea");
    await field.tap();
    await field.pressSequentially("mlieko", { delay: 20 });
    await expect(field).toHaveValue("mlieko");
    const keys = page.locator("[data-key-access]");
    if (await keys.count()) {
      const toggle = keys.locator("[data-key-toggle]");
      await toggle.tap();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      // an empty key: said in words, nothing sent
      await keys.locator("[data-key-open]").tap();
      await expect(keys.locator("[data-key-problem]")).toHaveText(sk.chat.key_empty);
      // a key being checked: "Overujem…" and the vortex in the fixed 150 px button (the answer held back a moment)
      await page.route("**/api/shops/*/access", async (route) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "wrong" }) });
      });
      const open = keys.locator("[data-key-open]");
      const width = (await open.boundingBox())?.width;
      await keys.locator("[data-key-input]").fill("TEST-KEY-0000");
      await keys.locator("[data-key-input]").press("Enter");
      await expect(keys.locator('[data-vx="busy"]')).toBeVisible();
      await expect(open).toContainText(sk.chat.key_opening);
      expect((await open.boundingBox())?.width).toBe(width);
      await expect(keys.locator("[data-key-problem]")).toHaveText(sk.chat.key_wrong);
      await expect(keys.locator("[data-vx]")).toHaveCount(0);
    }
  }
  // No sideways scroll on a phone; the map uses OSM Bright.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  c.check();
});

test("blog post", async ({ page }) => {
  const c = watchConsole(page);
  await page.goto(`/sk/shops/${SHOP}/blog`);
  // A post of the list (never the RSS link), opened at its address on the site under test.
  const post = page.locator("[data-blog-post]").first();
  test.skip((await post.count()) === 0, "this shop has no posts");
  const slug = await post.getAttribute("data-blog-post");
  await page.goto(`/sk/shops/${SHOP}/blog/${slug}`);
  await expect(page.locator(`[data-blog-article="${slug}"] h1`)).toBeVisible();
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
