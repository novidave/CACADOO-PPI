import type { Page } from "@playwright/test";
import { expect, sk, SHOP, test, watchConsole } from "./helpers";

/**
 * The shop page's contact buttons (update 51, Screen 11): real links, press and hold. A quick tap only says "Držte
 * stlačené", letting go early or sliding off cancels; a mouse held 1.2 s opens the link, a finger held 1.2 s sees
 * "Pustite" and the link opens ON RELEASE — a real click on the link inside the touchend handler (2026-11-04: a phone
 * hands a link to its Maps / phone / e-mail app only from a gesture, never from a timer); Enter / Space open it at
 * once; no shadows, no context menu, no text selection. Navigovať on Android = a geo: link. Runs on Pixel 7 and on an
 * iPhone-sized screen.
 */

interface Recorded {
  opened: string[];
  /** our own clicks on a hold link: where to, whether inside a touchend, and the target at that moment */
  followed: { href: string | null; inRelease: boolean; target: string | null }[];
  inRelease: boolean;
  /** let the recorded clicks navigate (else they are recorded only) */
  allow: boolean;
}

/** window.open and the hold links' own clicks are recorded, not followed (the test stays on the page). */
async function record(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Recorded;
    w.opened = [];
    w.followed = [];
    w.inRelease = false;
    w.allow = false;
    window.open = ((url?: string | URL) => {
      w.opened.push(String(url));
      return null;
    }) as typeof window.open;
    // true while a touchend is being handled (window capture is first, window bubble last)
    window.addEventListener("touchend", () => (w.inRelease = true), true);
    window.addEventListener("touchend", () => (w.inRelease = false));
    document.addEventListener(
      "click",
      (e) => {
        const a = (e.target as Element | null)?.closest?.("a[data-hold-link]");
        if (!a || e.isTrusted) return;
        w.followed.push({ href: a.getAttribute("href"), inRelease: w.inRelease, target: a.getAttribute("target") });
        if (!w.allow) e.preventDefault();
      },
      true,
    );
  });
  return {
    opened: () => page.evaluate(() => (window as unknown as Recorded).opened),
    followed: () => page.evaluate(() => (window as unknown as Recorded).followed),
    allow: () => page.evaluate(() => void ((window as unknown as Recorded).allow = true)),
  };
}

test("contact buttons: hold to open, a tap does nothing", async ({ page }) => {
  const console = watchConsole(page);
  const rec = await record(page);
  await page.goto(`/sk/shops/${SHOP}`);
  const group = page.locator("[data-contact-buttons]");
  test.skip((await group.count()) === 0, "this shop has no contact links");
  // a new tab (window.open) or this tab (the link's own click): every way a hold link opens
  const opened = async () => [...(await rec.opened()), ...(await rec.followed()).map((f) => f.href ?? "")];

  const buttons = group.locator("a[data-contact]");
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

  // every button is a real link (works without JavaScript; Navigovať on Android = geo:)
  expect(await tab.getAttribute("href")).toMatch(/^(https:\/\/|geo:)/);

  // a quick tap: "Držte stlačené" for a moment, nothing opens
  await tab.click();
  await expect(tab).toHaveAttribute("data-phase", "hint");
  await expect(tab.locator(".ppi-cb-layer")).toHaveText(sk.contact_buttons.hold);
  await page.waitForTimeout(1500);
  await expect(tab).toHaveAttribute("data-phase", "idle");
  expect(await opened()).toEqual([]);

  // let go after 0.6 s: nothing, the label comes back
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(tab).toHaveAttribute("data-phase", "holding");
  await expect(tab.locator(".ppi-cb-layer")).toHaveText(sk.contact_buttons.hold);
  await page.waitForTimeout(600);
  await page.mouse.up();
  await expect(tab).toHaveAttribute("data-phase", "idle", { timeout: 2000 });
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

  // the keyboard: Enter opens at once (never a hold on a keyboard), with the done state
  await tab.focus();
  await page.keyboard.press("Enter");
  await expect(tab).toHaveAttribute("data-phase", "done");
  expect((await opened()).length).toBe(2);
  await expect(tab).toHaveAttribute("data-phase", "idle", { timeout: 3500 });

  // every label fits on one line (never cut or wrapped)
  for (const b of await buttons.all()) {
    const fits = await b.evaluate((el) => {
      const label = el.querySelector(".ppi-cb-layer")!.getBoundingClientRect();
      return label.width <= el.clientWidth - 24 + 1 && label.height <= 24 && el.getBoundingClientRect().height === 50;
    });
    expect(fits, (await b.getAttribute("data-contact")) ?? "").toBe(true);
  }
  console.check();
});

/**
 * A finger, as on a real phone: the hold fills for 1.2 s, then "Pustite" — nothing opens while the finger is down. The
 * link opens when it lets go: a real click on the link inside the touchend handler, in this tab (the phone may hand it
 * to its app). A short touch, a touch that slides off while holding and one that slides off after "Pustite" open
 * nothing.
 */
test("contact buttons: a finger hold opens the link on release, in the same tab", async ({ page, context }) => {
  const rec = await record(page);
  await page.goto(`/sk/shops/${SHOP}`);
  const group = page.locator("[data-contact-buttons]");
  test.skip((await group.count()) === 0, "this shop has no contact links");
  const nav = group.locator('[data-contact="navigate"]');
  const tab = (await nav.count()) ? nav : group.locator('[data-contact="facebook"], [data-contact="booking"], [data-contact="web"]').first();
  test.skip((await tab.count()) === 0, "this shop has no link to open");
  const href = (await tab.getAttribute("href")) ?? "";

  // Navigovať: geo: on Android when the shop has a map position, the Google Maps link elsewhere
  const android = await page.evaluate(() => /\bAndroid\b/i.test(navigator.userAgent));
  if ((await tab.getAttribute("data-contact")) === "navigate") {
    if (android) expect(href, "Android with a map position gets geo:").not.toMatch(/destination=-?\d+(\.\d+)?,-?\d+/);
    else expect(href).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\//);
    if (href.startsWith("geo:")) {
      expect(href).toMatch(/^geo:-?\d+(\.\d+)?,-?\d+(\.\d+)?\?q=-?\d+(\.\d+)?,-?\d+(\.\d+)?(\([^()]*\))?$/);
      expect(await tab.getAttribute("target")).toBeNull();
    }
  }

  // the link's page, answered here (no request leaves the test machine)
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
  const off = [{ x: at[0].x, y: box.y + box.height + 60 }];
  const cdp = await context.newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", points = at) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : points });

  // a short touch: "Držte stlačené", nothing
  await touch("touchStart");
  await page.waitForTimeout(200);
  await touch("touchEnd");
  await expect(tab).toHaveAttribute("data-phase", "hint");
  await page.waitForTimeout(1500);
  expect(await rec.followed()).toEqual([]);

  // slide off while holding: nothing
  await touch("touchStart");
  await page.waitForTimeout(300);
  await touch("touchMove", off);
  await expect(tab).toHaveAttribute("data-phase", "idle");
  await page.waitForTimeout(1300);
  await touch("touchEnd");
  expect(await rec.followed()).toEqual([]);

  // held 1.3 s: "Pustite" with the check, still nothing opened while the finger is down
  await touch("touchStart");
  await page.waitForTimeout(1300);
  await expect(tab).toHaveAttribute("data-phase", "ready");
  await expect(tab.locator(".ppi-cb-layer")).toHaveText(sk.contact_buttons.release);
  await expect(tab.locator(".ppi-cb-badge svg")).toBeVisible();
  expect(await rec.followed()).toEqual([]);
  expect(visited).toEqual([]);
  // … then slides off: nothing, also when it lets go
  await touch("touchMove", off);
  await expect(tab).toHaveAttribute("data-phase", "idle");
  await touch("touchEnd");
  await page.waitForTimeout(400);
  expect(await rec.followed()).toEqual([]);

  // held 1.3 s and released: the link's own click, inside the touchend handler, in this tab (no target)
  await touch("touchStart");
  await page.waitForTimeout(1300);
  await expect(tab).toHaveAttribute("data-phase", "ready");
  expect(await rec.followed()).toEqual([]);
  await touch("touchEnd");
  expect(await rec.followed()).toEqual([{ href, inRelease: true, target: null }]);
  await expect(tab).toHaveAttribute("data-phase", "done");
  await expect(page.locator("[data-contact-announce]")).toContainText(":");
  expect(await rec.opened(), "no pop-up").toEqual([]);
  await expect(tab).toHaveAttribute("data-phase", "idle", { timeout: 3500 });

  // an https link really loads in this tab on the release (geo: is handed to the phone's app, not loaded here)
  if (href.startsWith("https://")) {
    await rec.allow();
    await touch("touchStart");
    await page.waitForTimeout(1300);
    expect(visited).toEqual([]);
    await touch("touchEnd");
    await expect.poll(() => visited.length, { timeout: 3000 }).toBe(1);
    expect(visited[0]).toBe(href);
  }
});
