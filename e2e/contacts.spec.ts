import { expect, sk, SHOP, test, watchConsole } from "./helpers";

/**
 * The shop page's contact buttons (update 51): press and hold. A quick tap does nothing, letting go early or sliding
 * off cancels, holding 1.2 s opens the link; no shadows, no context menu, no text selection.
 */
test("contact buttons: hold to open, a tap does nothing", async ({ page }) => {
  const console = watchConsole(page);
  // window.open is recorded, not followed (the test stays on the page)
  await page.addInitScript(() => {
    const w = window as unknown as { opened: string[] };
    w.opened = [];
    window.open = ((url?: string | URL) => {
      w.opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await page.goto(`/sk/shops/${SHOP}`);
  const group = page.locator("[data-contact-buttons]");
  test.skip((await group.count()) === 0, "this shop has no contact links");
  const opened = () => page.evaluate(() => (window as unknown as { opened: string[] }).opened);

  const buttons = group.locator("button[data-contact]");
  const keys = await buttons.evaluateAll((all) => all.map((b) => (b as HTMLElement).dataset.contact));
  const order = ["facebook", "booking", "web", "email", "navigate", "phone"];
  expect(keys).toEqual(order.filter((k) => keys.includes(k)));

  // the look: 50 px, no shadow, touch without a menu or selection
  const first = buttons.first();
  const style = await first.evaluate((b) => {
    const s = getComputedStyle(b);
    return { height: s.height, shadow: s.boxShadow, touch: s.touchAction, select: s.userSelect, radius: s.borderRadius };
  });
  expect(style).toEqual({ height: "50px", shadow: "none", touch: "none", select: "none", radius: "10px" });
  // Chromium drops -webkit-touch-callout from its style objects: read the stylesheets' text (Safari applies it)
  const css = await page.evaluate(async () => {
    const hrefs = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'), (l) => l.href);
    const texts = await Promise.all(hrefs.map((h) => fetch(h).then((r) => r.text())));
    return texts.some((t) => /\.ppi-cb\{[^}]*-webkit-touch-callout:none/.test(t.replace(/\s+/g, "")));
  });
  expect(css, "-webkit-touch-callout: none").toBe(true);

  // a link that opens in a new tab: Facebook, booking, web or directions
  const tab = buttons.and(page.locator('[data-contact="facebook"], [data-contact="booking"], [data-contact="web"], [data-contact="navigate"]')).first();
  const box = (await tab.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // a quick tap: nothing
  await tab.click();
  await page.waitForTimeout(1500);
  expect(await opened()).toEqual([]);

  // let go after 0.6 s: nothing, the label comes back
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(tab).toHaveAttribute("data-phase", "holding");
  await expect(tab.locator(".ppi-cb-layer:not([data-leaving])")).toHaveText(sk.contact_buttons.hold);
  await page.waitForTimeout(600);
  await page.mouse.up();
  await expect(tab).toHaveAttribute("data-phase", "idle");
  await page.waitForTimeout(900);
  expect(await opened()).toEqual([]);

  // slide off while holding: nothing
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.mouse.move(at.x, box.y + box.height + 40);
  await expect(tab).toHaveAttribute("data-phase", "idle");
  await page.mouse.up();
  await page.waitForTimeout(1200);
  expect(await opened()).toEqual([]);

  // hold 1.2 s: it opens, says so (also to screen readers), then comes back
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(tab).toHaveAttribute("data-phase", "done", { timeout: 2000 });
  await page.mouse.up();
  expect((await opened()).length).toBe(1);
  await expect(tab.locator(".ppi-cb-badge svg")).toBeVisible();
  await expect(page.locator("[data-contact-announce]")).toContainText(":");
  await expect(tab).toHaveAttribute("data-phase", "idle", { timeout: 3500 });

  // the keyboard: hold Space
  await tab.focus();
  await page.keyboard.down(" ");
  await page.waitForTimeout(1350);
  await page.keyboard.up(" ");
  expect((await opened()).length).toBe(2);
  await expect(tab).toHaveAttribute("data-phase", "idle", { timeout: 3500 });

  // every label fits on one line (never cut or wrapped)
  for (const b of await buttons.all()) {
    const fits = await b.evaluate((el) => {
      const label = el.querySelector(".ppi-cb-layer:not([data-leaving])")!.getBoundingClientRect();
      return label.width <= el.clientWidth - 24 + 1 && label.height <= 24 && el.getBoundingClientRect().height === 50;
    });
    expect(fits, (await b.getAttribute("data-contact")) ?? "").toBe(true);
  }
  console.check();
});

/**
 * A finger, as on a real phone: no user gesture to open a pop-up (touchstart gives none, no click after a long press).
 * So on a phone the link loads in the SAME tab the moment the hold completes — no pop-up, no gesture needed, never
 * blocked. A short touch and a touch that slides off load nothing.
 */
test("contact buttons: a finger hold opens the link in the same tab", async ({ page, context }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { opened: string[] };
    w.opened = [];
    window.open = ((url?: string | URL) => {
      w.opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await page.goto(`/sk/shops/${SHOP}`);
  const group = page.locator("[data-contact-buttons]");
  test.skip((await group.count()) === 0, "this shop has no contact links");
  const tab = group.locator('[data-contact="facebook"], [data-contact="booking"], [data-contact="web"], [data-contact="navigate"]').first();
  // the link's page, answered here (no request leaves the test machine)
  const target = await tab.evaluate((el) => el.getAttribute("data-contact"));
  const visited: string[] = [];
  await context.route(
    (url) => !url.href.startsWith(new URL(page.url()).origin),
    (route) => {
      if (route.request().isNavigationRequest()) visited.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "text/html", body: "<p>opened</p>" });
    },
  );
  const box = (await tab.boundingBox())!;
  const at = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
  const cdp = await context.newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", points = at) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : points });

  // a short touch: nothing
  await touch("touchStart");
  await page.waitForTimeout(200);
  await touch("touchEnd");
  await page.waitForTimeout(1500);
  expect(visited).toEqual([]);

  // slide off: nothing
  await touch("touchStart");
  await page.waitForTimeout(300);
  await touch("touchMove", [{ x: at[0].x, y: box.y + box.height + 60 }]);
  await expect(tab).toHaveAttribute("data-phase", "idle");
  await page.waitForTimeout(1300);
  await touch("touchEnd");
  expect(visited).toEqual([]);

  // hold: at 1.2 s the link loads in this tab while the finger is still down; no pop-up
  await touch("touchStart");
  await expect.poll(() => visited.length, { timeout: 3000 }).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { opened?: string[] }).opened ?? [])).toEqual([]);
  await touch("touchEnd").catch(() => {});
  expect(target).toBeTruthy();
});
