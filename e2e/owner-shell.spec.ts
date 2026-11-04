import { expect, loginOwner, sk, test } from "./helpers";
import type { Page } from "@playwright/test";

/**
 * The owner area's shell (back-end layout, 2026-11-03; tabs and menu fixed 2026-11-04). Rezervácie is the model: switching
 * a tab never moves the title or the tab row, only what is under the tabs changes — every owner page with tabs behaves
 * the same (the tab row's box is identical on every tab and on the pages under them, ±0.5 px). At 1180×820 the 256 px
 * menu is open on every page (Predaj too) and "Zbaliť menu" folds it to the 76 px rail without moving a single icon,
 * remembered after a reload; at 820×1180 and 390×844 the top bar has the menu button on the left and the menu is a
 * panel from the left that Esc closes. "SMS tento mesiac" sits under the tabs on Kontakty. No page scrolls sideways.
 * Needs an owner login (E2E_OWNER_EMAIL + E2E_OWNER_PASSWORD or E2E_OWNER_LOGIN_URL) and E2E_OWNER_SHOP for the shop
 * pages; skipped without them. An item the shop does not use (no Sklad, food ordering off) is skipped with a note.
 */
const SIZES = [
  { name: "computer", width: 1180, height: 820 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
] as const;

const SHOP = process.env.E2E_OWNER_SHOP ?? "";
const q = SHOP ? `?shop=${encodeURIComponent(SHOP)}` : "";

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "no sideways scroll").toBeLessThanOrEqual(0);

type Box = { x: number; y: number; height: number };

/** The tab row's box in page coordinates (the page may be scrolled after a form). */
async function tabRow(page: Page, item: string): Promise<Box | null> {
  const row = page.locator(`[data-item-tabs="${item}"]`);
  if ((await row.count()) === 0) return null;
  return row.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, height: r.height };
  });
}

const near = (a: Box, b: Box) => Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.height - b.height) <= 0.5;

/** The tabs' own links, read from the tab row (so the test follows ITEM_TABS). */
async function tabLinks(page: Page, item: string): Promise<[string, string][]> {
  return page.$$eval(`[data-item-tabs="${item}"] a[data-tab]`, (links) =>
    links.map((a) => [a.getAttribute("data-tab") ?? "", a.getAttribute("href") ?? ""] as [string, string]),
  );
}

/** Every tab of an item and the extra pages under them: the same tab row everywhere. */
async function sameTabRow(page: Page, item: string, start: string, extra: (page: Page) => Promise<string[]> = async () => []) {
  await page.goto(start);
  const first = await tabRow(page, item);
  if (!first) {
    test.info().annotations.push({ type: "skipped", description: `${item}: no tab row on ${start} (not used by this shop)` });
    return;
  }
  expect(first.height, `${item}: the tab row is 56 px high`).toBeCloseTo(56, 0);
  const pages = [...(await tabLinks(page, item)).map(([, href]) => href), ...(await extra(page))];
  expect(pages.length).toBeGreaterThan(1);
  for (const href of pages) {
    await page.goto(href);
    const box = await tabRow(page, item);
    expect(box, `${item}: the tab row on ${href}`).not.toBeNull();
    expect(near(box!, first), `${item}: the tab row on ${href} ${JSON.stringify(box)} = ${JSON.stringify(first)}`).toBe(true);
    // the open tab is marked; nothing that differs between tabs sits above the tab row
    await expect(page.locator(`[data-item-tabs="${item}"] [aria-current="page"]`)).toHaveCount(1);
    const above = await page.evaluate((top) => {
      const sel = "[data-sms-usage], [role=status], [role=alert], [data-notice], [data-pro-only]";
      return [...document.querySelectorAll(sel)].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.height > 0 && r.bottom + window.scrollY <= top;
      }).length;
    }, box!.y);
    expect(above, `${item}: nothing tab-specific above the tabs on ${href}`).toBe(0);
    await noSideways(page);
  }
}

/** Sklad's pages under the tabs: the receipt editor, the first product's card, the counting phone of an open count. */
async function skladExtras(page: Page): Promise<string[]> {
  const out = [`/sk/dashboard/sklad/receipts/new${q}`];
  await page.goto(`/sk/dashboard/sklad/products${q}`);
  const card = page.locator('a[href*="/dashboard/sklad/products/"]:not([href*="/new"])').first();
  if (await card.count()) out.push((await card.getAttribute("href")) ?? "");
  await page.goto(`/sk/dashboard/sklad/counts${q}`);
  const counting = page.locator('[data-sklad-count-open] a[href*="/dashboard/sklad/counts/"]:not([href$="/diff"]):not([href*="/diff?"])').first();
  if ((await counting.count()) === 0 && (await page.locator("[data-sklad-count-start]").count()) > 0) {
    // no count running: start one (cancelled again at the end of the test)
    await page.locator("[data-sklad-count-start]").click();
    await page.waitForURL(/\/dashboard\/sklad\/counts\/[0-9a-f-]{36}/);
    out.push(page.url().replace(/^https?:\/\/[^/]+/, ""));
    test.info().annotations.push({ type: "started-count", description: page.url() });
  } else if (await counting.count()) {
    out.push((await counting.getAttribute("href")) ?? "");
  }
  return out.filter(Boolean);
}

/** A count this test started is cancelled again (its differences page). */
async function cancelStartedCount(page: Page) {
  const started = test.info().annotations.find((a) => a.type === "started-count")?.description;
  if (!started) return;
  const url = new URL(started);
  await page.goto(`${url.pathname}/diff${url.search}`);
  await page.getByRole("button", { name: sk.sklad.ic_cancel }).click();
  await page.waitForURL(/\/dashboard\/sklad\/counts\?/);
}

for (const size of SIZES) {
  test.describe(`owner shell ${size.width}×${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    test.beforeEach(async ({ page }) => {
      test.skip(!(await loginOwner(page)), "no owner login configured (E2E_OWNER_EMAIL/PASSWORD or E2E_OWNER_LOGIN_URL)");
    });

    test("every menu item opens its page and is the current one; ?shop= stays", async ({ page }) => {
      const small = size.name !== "computer";
      await page.goto(`/sk/dashboard${q}`);
      const selector = small ? "[data-owner-panel] [data-panel-item]" : "#owner-menu [data-nav-item]";
      const attr = small ? "data-panel-item" : "data-nav-item";
      const links = await page.$$eval(selector, (as, a) => as.map((x) => [x.getAttribute(a) ?? "", x.getAttribute("href") ?? ""] as [string, string]), attr);
      expect(links.length).toBeGreaterThan(10);
      if (SHOP) expect(links.filter(([, href]) => new URL(href, "https://x").searchParams.get("shop") === SHOP).length).toBeGreaterThan(8);
      for (const [key, href] of links) {
        await page.goto(href);
        if (small) {
          await page.locator("[data-owner-menu-button]").click();
          await expect(page.locator(`[data-owner-panel] [data-panel-item="${key}"]`)).toHaveAttribute("aria-current", "page");
          await page.keyboard.press("Escape");
        } else {
          await expect(page.locator(`#owner-menu [data-nav-item="${key}"]`)).toHaveAttribute("aria-current", "page");
        }
        await noSideways(page);
      }
    });

    test("the tab row stays in one place on every tab (Rezervácie, Sklad, Objednávky jedla, CRM)", async ({ page }) => {
      test.skip(!SHOP, "needs E2E_OWNER_SHOP");
      test.setTimeout(240_000);
      await sameTabRow(page, "bookings", `/sk/dashboard/bookings${q}`);
      await sameTabRow(page, "sklad", `/sk/dashboard/sklad${q}`, skladExtras);
      await sameTabRow(page, "food", `/sk/dashboard/assistant/orders${q}`, async (p) => {
        await p.goto(`/sk/dashboard/assistant/orders${q}&f=done`);
        const order = p.locator('[data-food-order] a[href*="/dashboard/assistant/orders/"]').first();
        return (await order.count()) ? [(await order.getAttribute("href")) ?? ""] : [];
      });
      await sameTabRow(page, "crm", `/sk/dashboard/crm${q}`);
      await sameTabRow(page, "assistant", `/sk/dashboard/assistant${q}`);
      await cancelStartedCount(page);
    });

    test("SMS tento mesiac is right under the tabs on Kontakty, above Nový kontakt", async ({ page }) => {
      test.skip(!SHOP, "needs E2E_OWNER_SHOP");
      await page.goto(`/sk/dashboard/contacts${q}`);
      const usage = page.locator("[data-sms-usage]");
      if ((await usage.count()) === 0) {
        test.info().annotations.push({ type: "skipped", description: "no SMS usage on Kontakty (no Pro plan or before update 58)" });
        return;
      }
      const tabs = (await page.locator('[data-item-tabs="crm"]').boundingBox())!;
      const box = (await usage.boundingBox())!;
      expect(box.y, "under the tab row").toBeGreaterThanOrEqual(tabs.y + tabs.height);
      const add = page.locator("[data-new-contact]");
      if (await add.count()) expect(box.y + box.height, "above Nový kontakt").toBeLessThanOrEqual((await add.boundingBox())!.y);
      // only on Kontakty among the CRM tabs
      for (const path of ["/sk/dashboard/crm", "/sk/dashboard/contacts"]) {
        await page.goto(`${path}${q}${path.endsWith("contacts") ? "&view=templates" : ""}`);
        await expect(page.locator("[data-sms-usage]")).toHaveCount(0);
      }
    });

    if (size.name === "computer") {
      test("the menu is open on Predaj; Zbaliť menu folds it without moving an icon and is remembered", async ({ page }) => {
        await page.goto(`/sk/dashboard/sklad/sale${q}`);
        const aside = page.locator("#owner-menu");
        await expect(aside).toHaveAttribute("data-owner-nav", "open");
        expect((await aside.boundingBox())!.width).toBeCloseTo(256, 0);
        const button = page.locator("[data-nav-collapse]");
        await expect(button).toHaveAttribute("aria-expanded", "true");
        await expect(button).toHaveAttribute("aria-controls", "owner-menu");
        await expect(button).toHaveAccessibleName(sk.nav.collapse_menu);
        expect((await button.boundingBox())!.height).toBeCloseTo(48, 0);
        const icons = () =>
          page.$$eval("#owner-menu [data-nav-icon]", (els) =>
            els.filter((e) => e.getBoundingClientRect().height > 0).map((e) => {
              const r = e.getBoundingClientRect();
              return [Math.round(r.x * 2) / 2, Math.round(r.y * 2) / 2];
            }),
          );
        const tabs = await tabRow(page, "sklad");
        const before = await icons();
        expect(before.length).toBeGreaterThan(8);
        // the keyboard, as a person would (a mouse click would first scroll the sticky menu "into view")
        await button.focus();
        await page.keyboard.press("Enter");
        await expect(aside).toHaveAttribute("data-owner-nav", "collapsed");
        await expect.poll(async () => (await aside.boundingBox())!.width).toBeCloseTo(76, 0);
        expect(await icons(), "no icon moved").toEqual(before);
        await expect(button).toHaveAttribute("aria-expanded", "false");
        await expect(button).toHaveAccessibleName(sk.nav.expand_menu);
        // collapsed rows say what they are; labels are hidden
        for (const row of await page.locator("#owner-menu [data-nav-item], #owner-menu [data-nav-group]").all()) {
          expect(await row.getAttribute("title"), "a collapsed row has a title").toBeTruthy();
          expect(await row.getAttribute("aria-label"), "a collapsed row has an aria-label").toBeTruthy();
        }
        await expect(page.locator("#owner-menu [data-nav-label]").first()).toBeHidden();
        // the content takes the width, the tab row keeps its height and vertical place
        const wide = (await tabRow(page, "sklad"))!;
        expect(Math.abs(wide.y - tabs!.y)).toBeLessThanOrEqual(0.5);
        expect(wide.x).toBeLessThan(tabs!.x);
        await page.reload();
        await expect(aside).toHaveAttribute("data-owner-nav", "collapsed");
        await expect(page.locator("html")).toHaveAttribute("data-owner-nav", "collapsed");
        expect(await icons(), "the same icons after a reload").toEqual(before);
        await page.goto(`/sk/dashboard${q}`);
        await expect(aside).toHaveAttribute("data-owner-nav", "collapsed");
        await page.locator("[data-nav-collapse]").focus();
        await page.keyboard.press("Enter");
        await expect(aside).toHaveAttribute("data-owner-nav", "open");
        await page.reload();
        await expect(aside).toHaveAttribute("data-owner-nav", "open");
      });

      test("only one group is open; the group of the page opens by itself; the site header is hidden", async ({ page }) => {
        await page.goto("/sk/sync");
        const head = (g: string) => page.locator(`#owner-menu [data-nav-group="${g}"]`);
        await expect(head("account")).toHaveAttribute("aria-expanded", "true");
        await expect(head("page")).toHaveAttribute("aria-expanded", "false");
        await head("page").click();
        await expect(head("page")).toHaveAttribute("aria-expanded", "true");
        await expect(head("account")).toHaveAttribute("aria-expanded", "false");
        await expect(page.locator('#owner-menu [data-nav-list="account"] [data-nav-item]').first()).toBeHidden();
        await expect(page.locator("[data-site-header]")).toBeHidden();
      });

      test("the page pattern: a 28 px title and 56 px tabs everywhere, the save bar on Môj obchod", async ({ page }) => {
        for (const path of ["/sk/dashboard", "/sk/dashboard/legal", "/sk/dashboard/plan", "/sk/sync", "/sk/password", "/sk/dashboard/sklad/sale"]) {
          await page.goto(path + q);
          await expect(page.locator("h1").first()).toHaveCSS("font-size", "28px");
        }
        await expect(page.locator('[data-page-head="compact"]')).toHaveCount(0);
        await page.goto(`/sk/dashboard${q}`);
        const bar = page.locator("[data-save-bar]");
        if (await bar.count()) {
          await expect(bar.getByRole("button").last()).toHaveCSS("min-height", "52px");
          const name = page.locator('input[name="name"]');
          await name.fill(`${await name.inputValue()} x`);
          await expect(bar.locator("[data-unsaved]")).toHaveAttribute("data-unsaved", "1");
          await bar.getByRole("button").first().click();
          await expect(bar.locator("[data-unsaved]")).toHaveAttribute("data-unsaved", "0");
        }
      });
    } else {
      test("the menu button is on the left; the panel comes from the left and closes with Esc, outside or X", async ({ page }) => {
        await page.goto(`/sk/dashboard/sklad/sale${q}`);
        await expect(page.locator("#owner-menu")).toBeHidden();
        const button = page.locator("[data-owner-menu-button]");
        const b = (await button.boundingBox())!;
        expect(b.x, "the button on the left").toBeLessThan(20);
        expect(b.width).toBeCloseTo(48, 0);
        const title = (await page.locator("[data-owner-topbar] strong").boundingBox())!;
        expect(title.x, "the title after the button").toBeGreaterThan(b.x + b.width);
        const panel = page.locator("[data-owner-panel]");
        await button.click();
        await expect(panel).toBeVisible();
        await expect(button).toHaveAttribute("aria-expanded", "true");
        const p = (await panel.boundingBox())!;
        expect(p.x, "from the left edge").toBeLessThanOrEqual(0.5);
        expect(p.width).toBeLessThanOrEqual(Math.min(320, size.width * 0.85) + 0.5);
        expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[data-owner-panel]"))), "the focus moves into the panel").toBe(true);
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
        await expect(button).toBeFocused();
        // a tap on the dimmed page closes it (clear of a scrollbar strip on the right)
        await button.click();
        await expect(panel).toBeVisible();
        await page.mouse.click(size.width - 40, size.height / 2);
        await expect(panel).toBeHidden();
        await button.click();
        await page.locator("[data-owner-panel-close]").click();
        await expect(panel).toBeHidden();
        await expect(button).toBeFocused();
        await noSideways(page);
      });
    }
  });
}
