import type { Locator, Page } from "@playwright/test";
import { expect, sk, SHOP, test, watchConsole } from "./helpers";

/**
 * The shop page's "Produkty / Zoznam" (2026-10-29): the stock dot adds to the visitor's list, both counters agree and
 * survive a reload, the Zoznam tab's stepper, swipe and "Kopírovať zoznam", reduced motion; no stock sentence in the
 * list (only on the product page). Runs on the Pixel 7 and on an iPhone-sized screen.
 */

const rows = (page: Page) => page.locator("[data-product-rows] > li");
const listTab = (page: Page) => page.locator("[data-list-tab]");
const tabCount = (page: Page) => page.locator("[data-tab-count]");
const listRows = (page: Page) => page.locator("[data-list-rows] > li");
const priced = (page: Page) => rows(page).filter({ has: page.locator(".ppi-row-price", { hasText: /\d/ }) });

/** A price as the page writes it ("9,90 €") → 9.9. */
const amount = (text: string) => Number(text.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3})/g, "").replace(",", "."));

async function addFrom(row: Locator, times = 1) {
  for (let i = 0; i < times; i++) await row.locator("[data-add-to-list]").click();
}

test.beforeEach(async ({ page }) => {
  await page.goto(`/sk/shops/${SHOP}`);
  await page.evaluate(() => {
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith("ppi.list.")) localStorage.removeItem(key);
    } catch {}
  });
  await page.reload();
  test.skip((await priced(page).count()) < 2, "this shop has fewer than two items with a price");
});

test("the stock dot is a round 20 px circle in a 32 px button, the search has one border", async ({ page }) => {
  const button = rows(page).first().locator("[data-add-to-list]");
  const box = await button.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(32);
  expect(box!.height).toBeGreaterThanOrEqual(32);
  const look = await button.evaluate((b) => {
    const dot = b.querySelector("[data-stock-dot]") as HTMLElement;
    const s = getComputedStyle(b);
    const d = getComputedStyle(dot);
    const r = dot.getBoundingClientRect();
    return { bg: s.backgroundColor, border: s.borderTopWidth, w: r.width, h: r.height, radius: d.borderRadius };
  });
  expect(look.bg).toBe("rgba(0, 0, 0, 0)");
  expect(look.border).toBe("0px");
  expect(look.w).toBe(20);
  expect(look.h).toBe(20);
  expect(look.radius).toBe("50%");

  const input = page.getByRole("searchbox", { name: sk.shop.search_items });
  const borders = await input.evaluate((el) => [getComputedStyle(el).borderTopWidth, getComputedStyle(el.parentElement!).borderTopWidth]);
  expect(borders).toEqual(["0px", "1px"]);
  // Quicksand on the buttons and the field too
  for (const el of [input, listTab(page)]) expect(await el.evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/quicksand/i);
});

test("no stock sentence in the list; the dot says it to screen readers; the product page keeps it", async ({ page }) => {
  // (the shop's one line above the list, "Zásoby: …", says how fresh the whole file is; the products say nothing)
  const text = await page.locator("[data-product-rows]").innerText();
  for (const words of [sk.stock.stale, sk.stock.out_of_stock, "ks na sklade"]) expect(text).not.toContain(words);
  const label = await rows(page).first().locator("[data-add-to-list]").getAttribute("aria-label");
  expect(label).toMatch(new RegExp(`^${sk.shop.list_add.split("{name}")[0]}.+, (${sk.stock.dot_available}|${sk.stock.dot_sold_out}|${sk.stock.dot_no_info})$`));
  await rows(page).first().locator(".ppi-row-name").click();
  await expect(page).toHaveURL(/\/items\//);
  await expect(page.locator("main")).toContainText(sk.item.availability);
});

test("adding: counters on the dot and the tab agree, also after a reload", async ({ page }) => {
  const console = watchConsole(page);
  const [a, b] = [priced(page).nth(0), priced(page).nth(1)];
  await addFrom(a, 2);
  await addFrom(b);
  await expect(a.locator("[data-list-badge]")).toHaveText("2");
  await expect(b.locator("[data-list-badge]")).toHaveText("1");
  await expect(tabCount(page)).toHaveText("3");
  await expect(page.locator("[data-list-said]")).toContainText("Pridané do zoznamu");

  await page.reload();
  await expect(priced(page).nth(0).locator("[data-list-badge]")).toHaveText("2");
  await expect(tabCount(page)).toHaveText("3");

  // "9+" on the dot above nine
  for (let i = 0; i < 8; i++) await priced(page).nth(0).locator("[data-add-to-list]").click();
  await expect(priced(page).nth(0).locator("[data-list-badge]")).toHaveText("9+");
  await expect(tabCount(page)).toHaveText("11");
  console.check();
});

test("Zoznam: stepper, total, the bin at one, the empty list", async ({ page }) => {
  const a = priced(page).nth(0);
  const name = ((await a.locator(".ppi-row-name").textContent()) ?? "").trim();
  const price = amount((await a.locator(".ppi-row-price").textContent()) ?? "");
  await addFrom(a, 2);
  await expect(tabCount(page)).toHaveText("2");
  await listTab(page).click();
  const row = listRows(page).first();
  await expect(row).toContainText(name);
  await expect(row.locator("[data-qty]")).toHaveText("2");
  expect(amount((await row.locator("[data-line-price]").textContent()) ?? "")).toBeCloseTo(price * 2, 2);
  expect(amount((await page.locator("[data-list-total]").textContent()) ?? "")).toBeCloseTo(price * 2, 2);

  await row.locator('[data-step="plus"]').click();
  await expect(row.locator("[data-qty]")).toHaveText("3");
  await expect(tabCount(page)).toHaveText("3");
  await row.locator('[data-step="minus"]').click();
  await row.locator('[data-step="minus"]').click();
  await expect(row.locator("[data-qty]")).toHaveText("1");
  // at one the minus is a bin
  await expect(row.locator('[data-step="remove"]')).toHaveAttribute("aria-label", sk.shop.list_remove.replace("{name}", name));
  await row.locator('[data-step="remove"]').click();
  await expect(page.locator("[data-list-empty]")).toHaveText(sk.shop.list_empty);
  await expect(tabCount(page)).toHaveCount(0);

  // back on Produkty the dot has no counter any more
  await page.locator(".ppi-tab").first().click();
  await expect(priced(page).nth(0).locator("[data-list-badge]")).toHaveCount(0);
});

/** A finger swipe to the right from the row's name (never from the stepper), `share` of the row's width. */
async function swipe(page: Page, row: Locator, share: number) {
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  const x = box.x + box.width * 0.1;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (box.width * share * i) / 8, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test("Zoznam: a short swipe springs back, a long one deletes the row", async ({ page }) => {
  await addFrom(priced(page).nth(0));
  await addFrom(priced(page).nth(1));
  await expect(tabCount(page)).toHaveText("2");
  await listTab(page).click();
  await expect(listRows(page)).toHaveCount(2);

  await swipe(page, listRows(page).first(), 0.2);
  await expect(listRows(page)).toHaveCount(2);
  await expect(listRows(page).first().locator("[data-swipe-content]")).toHaveCSS("transform", /none|matrix\(1, 0, 0, 1, 0, 0\)/);

  await swipe(page, listRows(page).first(), 0.6);
  await expect(listRows(page)).toHaveCount(1);
  await expect(tabCount(page)).toHaveText("1");
  await expect(page.locator("[data-list-said]")).toContainText("Odstránené zo zoznamu");
});

test("Kopírovať zoznam: the shop's name and address, the lines and the total", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const shopName = ((await page.locator("h1").textContent()) ?? "").trim();
  const a = priced(page).nth(0);
  const name = ((await a.locator(".ppi-row-name").textContent()) ?? "").trim();
  await addFrom(a, 2);
  await listTab(page).click();
  const button = page.locator("[data-list-copy]");
  await button.click();
  await expect(button).toHaveText(sk.shop.list_copied);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split("\n");
  expect(lines[0]).toBe(`${sk.shop.list_title} – ${shopName}`);
  expect(text).toContain(`2× ${name}`);
  expect(text).toMatch(new RegExp(`\\n\\n${sk.shop.list_total}: .+$`));
  expect(text).not.toMatch(/https?:\/\//);
  await expect(button).toHaveText(sk.shop.list_copy, { timeout: 4000 });
});

test("Kopírovať zoznam: when copying fails the text is shown selected", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } });
    document.execCommand = () => false;
  });
  await page.reload();
  await addFrom(priced(page).nth(0));
  await listTab(page).click();
  await page.locator("[data-list-copy]").click();
  const area = page.locator("[data-list-manual]");
  await expect(area).toBeVisible();
  await expect(area).toHaveJSProperty("readOnly", true);
  expect(await area.evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart)).toBeGreaterThan(10);
});

test("reduced motion: no ball, the counters change at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await addFrom(priced(page).nth(0));
  await expect(tabCount(page)).toHaveText("1", { timeout: 200 });
  expect(await page.evaluate(() => [...document.body.children].filter((e) => getComputedStyle(e).position === "fixed" && e.getAttribute("aria-hidden") === "true").length)).toBe(0);
});

test("the list keeps working when storage is blocked", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get: () => { throw new Error("blocked"); } });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await addFrom(priced(page).nth(0));
  await expect(tabCount(page)).toHaveText("1");
  expect(errors).toEqual([]);
});

test("switching tabs never moves the page, also to an empty list", async ({ page }) => {
  const tab = listTab(page);
  // the tabs in the middle of the screen, the page well below its top
  await tab.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - window.innerHeight / 2));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(100);
  const top = async () => (await tab.boundingBox())!.y;
  const at = await top();
  await tab.click();
  await expect(page.locator("[data-list-empty]")).toBeVisible();
  expect(Math.abs((await top()) - at), "the tabs stay where they were").toBeLessThan(2);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThan(2);
  await page.locator(".ppi-tab").first().click();
  await tab.click();
  expect(Math.abs((await top()) - at)).toBeLessThan(2);
});

test("the list tab leaves one screen of room: scrolled to the end, the tabs touch the top of the screen", async ({ page }) => {
  for (const size of [null, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    if (size) await page.setViewportSize(size);
    await page.reload();
    const tab = listTab(page);
    await tab.scrollIntoViewIfNeeded();
    await tab.click();
    await expect(page.locator("[data-list-empty]")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const top = await page.locator(".ppi-tabs").evaluate((el) => el.getBoundingClientRect().top);
    // never endless (the tabs stop at the top) and always enough room (they get there)
    expect(Math.abs(top), `tabs at the top of a ${size ? `${size.width}×${size.height}` : "phone"} screen`).toBeLessThan(2);
  }
});
