import { expect, SHOP, sk, test, watchConsole } from "./helpers";

test("AI search → shop → product", async ({ page }) => {
  const c = watchConsole(page);
  await page.goto("/sk");
  const box = page.locator("[data-chat-input]");
  await box.fill("interiérová farba");
  const pressed = Date.now();
  await box.press("Enter");
  // The question shows at once (tap feedback), the cards follow (AI or the plain results).
  await expect(page.locator("[data-chat-question]")).toBeVisible();
  expect(Date.now() - pressed).toBeLessThan(1500);
  // A product card: on this site, or on the shop's own domain when it has a live one (https://<domain>/sk/items/<id>).
  // The own-domain address is opened as the same path on the site under test, so the preview itself is checked.
  const card = page.locator("[data-chat-cards] a[href*='/items/']").first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const href = (await card.getAttribute("href")) ?? "";
  if (href.startsWith("/")) await card.click();
  else await page.goto(new URL(href).pathname);
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
  // 2026-11-04: no "Preložené automaticky · Zobraziť originál" on customer pages
  await expect(page.getByText(sk.translation.machine)).toHaveCount(0);
  await expect(page.locator("[data-show-original]")).toHaveCount(0);
  // ONE opening hours card: the coming holidays / special days inside it (then a thin line), no separate card
  await expect(page.locator("[data-hours]")).toHaveCount(1);
  await expect(page.locator("[data-special-days]")).toHaveCount(0);
  const upcoming = page.locator("[data-hours] [data-hours-upcoming]");
  await expect(page.locator("[data-hours] [data-hours-divider]")).toHaveCount(await upcoming.count());
  // closed: only the short words in the pill ("Otvára …"), the full status is its name
  const pill = page.locator("[data-status-pill]");
  if ((await pill.getAttribute("data-status-short")) !== null) {
    await expect(pill).toHaveAttribute("data-status", "closed");
    await expect(pill).toHaveAttribute("aria-label", new RegExp(`^${sk.status.closed}`));
    await expect(pill).not.toContainText("·");
    await expect(pill.locator("[data-status-dot][data-opening]")).toHaveCount(1);
  }
  // the same gap between every card of the page, from the details to the products
  const gaps = await page.locator("[data-shop-page]").evaluate((col) => {
    const kids = [...col.children].filter((el) => {
      const s = getComputedStyle(el);
      return el.getBoundingClientRect().height > 0 && s.position !== "absolute" && s.position !== "fixed" && s.display !== "none";
    });
    return kids.slice(1).map((el, i) => Math.round(el.getBoundingClientRect().top - kids[i].getBoundingClientRect().bottom));
  });
  expect(new Set(gaps).size, `gaps between the cards: ${gaps.join(", ")}`).toBe(1);
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
  // Artboard 12's background: decoration only, behind the cards, never something to tap or read.
  const zoo = page.locator("[data-shop-backdrop]");
  await expect(zoo).toHaveAttribute("aria-hidden", "true");
  expect(await zoo.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe("none");
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
    // the slider's top at the top of the screen (or the page scrolled as far as it goes: a short page)
    const atTop = () =>
      slider.evaluate((el) => Math.abs(el.getBoundingClientRect().top) <= 1 || window.scrollY >= document.documentElement.scrollHeight - innerHeight - 1);
    // the article folds for 450 ms while the page scrolls: wait until the slider stands still
    const settled = async () => {
      let last = Number.NaN;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(150);
        const now = await slider.evaluate((el) => Math.round(el.getBoundingClientRect().top));
        if (now === last) return;
        last = now;
      }
    };
    const read = slider.locator('[data-slide="0"] [data-slide-read][aria-expanded]');
    if ((await article.count()) && (await read.count())) {
      await expect(article.locator("[data-inline-article]").first()).toBeAttached();
      await read.tap();
      await expect(read).toHaveAttribute("aria-expanded", "true");
      await expect(article).toHaveAttribute("data-open", "true");
      // the open post offers "Všetky novinky" (a hold link to the blog), no longer "Opýtať sa asistenta"
      const allNews = article.locator("[data-post-all-news]").first();
      if (await allNews.count()) await expect(allNews).toHaveAttribute("href", /\/blog/);
      // closing it brings the slider's top back to the top of the screen and the focus to its "Čítať"
      await page.evaluate(() => window.scrollBy(0, 400));
      await article.locator("[data-post-close]").first().tap();
      await expect(read).toHaveAttribute("aria-expanded", "false");
      await settled();
      expect(await atTop(), "the slider's top at the top of the screen").toBe(true);
      await expect(read).toBeFocused();
      // the "Zavrieť" on the slide does the same
      await read.tap();
      await expect(read).toHaveAttribute("aria-expanded", "true");
      await page.evaluate(() => window.scrollBy(0, 300));
      await read.tap();
      await expect(read).toHaveAttribute("aria-expanded", "false");
      await settled();
      expect(await atTop(), "the slider's top at the top of the screen").toBe(true);
    }
    const second = slider.locator('[data-slider-dot="1"]');
    if (await second.count()) {
      const nav = () => slider.locator("[data-slider-pills]").evaluate((e) => {
        const r = e.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map(Math.round).join(",");
      });
      const before = await nav();
      // TEMP diagnostics: who scrolls the page during the tap
      await page.evaluate(() => {
        const w = window as unknown as { __log: string[] };
        w.__log = [];
        const at = () => `${Math.round(performance.now())}`;
        const stack = () => (new Error().stack ?? "").split("\n").slice(2, 5).map((l) => l.trim().slice(0, 120)).join(" | ");
        addEventListener("scroll", () => w.__log.push(`${at()} scroll y=${Math.round(scrollY)}`), { passive: true });
        const wrap = (obj: object, name: string) => {
          const o = obj as Record<string, (...a: unknown[]) => unknown>;
          const orig = o[name];
          o[name] = function (this: unknown, ...a: unknown[]) {
            const el = this instanceof Element ? this.outerHTML.slice(0, 80) : "window";
            w.__log.push(`${at()} ${name}(${JSON.stringify(a).slice(0, 80)}) on ${el} :: ${stack()}`);
            return orig.apply(this, a);
          };
        };
        wrap(Element.prototype, "scrollIntoView");
        wrap(HTMLElement.prototype, "focus");
        wrap(window, "scrollTo");
        wrap(window, "scrollBy");
        wrap(Element.prototype, "scrollTo");
      });
      const diag = await second.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const vv = window.visualViewport;
        return {
          rect: [r.x, r.y, r.width, r.height].map(Math.round),
          hit: t === el ? "self" : (t?.outerHTML ?? "null").slice(0, 200),
          scrollY: Math.round(scrollY),
          vv: vv ? [vv.offsetTop, vv.pageTop, vv.height, vv.scale].map((n) => Math.round(n * 100) / 100) : null,
          active: document.activeElement?.outerHTML.slice(0, 120),
          docH: document.documentElement.scrollHeight,
          innerH: innerHeight,
        };
      });
      await second.tap();
      await expect(second).toHaveAttribute("aria-pressed", "true");
      await expect(slider.locator('[data-slider-dot="0"]')).toHaveAttribute("aria-pressed", "false");
      await page.waitForTimeout(600);
      const log = await page.evaluate(() => (window as unknown as { __log: string[] }).__log.slice(0, 40));
      expect(await nav(), JSON.stringify({ diag, log }, null, 1)).toEqual(before);
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
