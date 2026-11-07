import type { Page } from "@playwright/test";
import { expect, sk, SHOP, test, watchConsole } from "./helpers";

/**
 * The shop page's "Zoznam" inside the shop assistant (2026-11-04; the button in the header since 2026-11-05): the list
 * button left of the GDPR pill counts the pieces of the page's list live (its bubble), pressing it puts the list into the
 * message as a chip (× takes it back), and the request carries only ids, names and pieces — never a price, a total or the
 * address. The chat bar has only "Pridať fotku alebo súbor" and "Poslať". The answer comes from a test stub (no AI is
 * called). Runs only on a shop with the assistant (paid plan) and an item with a price; E2E_FOOD_SHOP (a restaurant)
 * checks that a restaurant's page has no list button.
 */

const priced = (page: Page) =>
  page.locator("[data-product-rows] > li").filter({ has: page.locator(".ppi-row-price", { hasText: /\d/ }) });

const STUB = {
  answer: "Testovacia odpoveď k zoznamu.",
  cards: [],
  list: [],
  photo: null,
  sources: [],
  pictures: [],
  docPrices: [],
  callShop: null,
  askContact: false,
  booking: null,
  requestContact: false,
  booked: null,
  order: null,
  conversation: null,
};

test("the shopping list goes into the assistant's message: live bubble, chip, ×, the request (test AI)", async ({ page }) => {
  const c = watchConsole(page);
  // the server's first view never shows a number (the list lives in the browser)
  const first = await (await page.request.get(`/sk/shops/${SHOP}`)).text();
  expect(first).not.toContain("data-list-bubble");
  await page.goto(`/sk/shops/${SHOP}`);
  await page.evaluate(() => {
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith("ppi.list.")) localStorage.removeItem(key);
    } catch {}
  });
  await page.reload();
  const assistant = page.locator("[data-assistant]");
  test.skip((await assistant.count()) === 0, "this shop has no assistant");
  test.skip((await priced(page).count()) < 1, "this shop has no item with a price");

  // the first view: the list button in the header, left of the GDPR pill (8 px), an empty bubble; the title's box
  const head = assistant.locator('[data-chat-list-button="head"]');
  const title = assistant.locator("[data-chat-title]");
  const gdpr = assistant.locator(".ppi-gdpr-btn");
  await expect(head).toHaveCount(1);
  // the title's box inside the assistant's card (the page may scroll when the field is tapped)
  const titleBox = () =>
    title.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const card = el.closest("[data-assistant]")!.getBoundingClientRect();
      return { x: r.x - card.x, y: r.y - card.y, width: r.width, height: r.height };
    });
  // the card pops in (a short scale animation): measure once it has its full size
  await expect.poll(async () => (await assistant.boundingBox())?.width ?? 0).toBeGreaterThan(300);
  await expect.poll(async () => assistant.evaluate((el) => el.getAnimations().filter((x) => x.playState === "running").length)).toBe(0);
  const before = await titleBox();
  // 2026-11-07: the welcome is static, outside the log; idle = nothing to scroll (no scrollbar, no ▲▼ arrows)
  const welcomeBox = () =>
    assistant.locator("[data-chat-welcome]").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const card = el.closest("[data-assistant]")!.getBoundingClientRect();
      return { x: r.x - card.x, y: r.y - card.y, width: r.width, height: r.height };
    });
  await expect(assistant.locator("[data-chat-log] [data-chat-welcome]")).toHaveCount(0);
  const idleLog = () =>
    assistant.locator("[data-chat-log]").evaluate((el) => ({ scroll: el.scrollHeight === el.clientHeight, overflow: getComputedStyle(el).overflowY }));
  expect(await idleLog()).toEqual({ scroll: true, overflow: "visible" });
  const welcomeBefore = await welcomeBox();
  const [btn, pill] = [(await head.boundingBox())!, (await gdpr.boundingBox())!];
  expect(btn.width).toBeCloseTo(34, 0);
  expect(btn.height).toBeCloseTo(34, 0);
  expect(btn.x + btn.width).toBeLessThan(pill.x);
  expect(pill.x - (btn.x + btn.width)).toBeCloseTo(8, 0);
  expect(Math.abs(btn.y + btn.height / 2 - (pill.y + pill.height / 2))).toBeLessThanOrEqual(1);
  // the touch area: 44 px around the 34 px box (a ::before that takes no room)
  const touch = await head.evaluate((el) => {
    const s = getComputedStyle(el, "::before");
    return el.getBoundingClientRect().width - 2 * parseFloat(s.left);
  });
  expect(touch).toBeGreaterThanOrEqual(44);
  // the header never overflows (the title shortens with an ellipsis)
  expect(await assistant.locator(".ppi-ai-head").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  // the assistant's code comes with the first touch: the header does not move, the empty list shows no bubble
  await assistant.locator("textarea").tap();
  await expect(assistant.locator("[data-chat-input]")).toHaveCount(1);
  const after = await titleBox();
  for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(after[k] - before[k]), `${k}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`).toBeLessThanOrEqual(0.5);
  // the welcome does not move either when the chat's code takes over, and the idle log still has nothing to scroll
  const welcomeAfter = await welcomeBox();
  for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(welcomeAfter[k] - welcomeBefore[k]), `welcome ${k}`).toBeLessThanOrEqual(0.5);
  expect(await idleLog()).toEqual({ scroll: true, overflow: "visible" });
  await expect(assistant.locator("[data-chat-log] [data-chat-welcome]")).toHaveCount(0);
  const bubble = head.locator(".ppi-ai-bubble");
  await expect(bubble).toBeHidden();
  // the chat bar: only "Pridať fotku alebo súbor" and "Poslať", on one row
  const bar = assistant.locator("[data-chat-bar]");
  await expect(bar.locator("[data-chat-list-button]")).toHaveCount(0);
  await expect(bar.locator("button")).toHaveCount(2);
  const [attachBox, sendBox] = [(await bar.locator("[data-chat-attach]").boundingBox())!, (await bar.locator("[data-chat-send]").boundingBox())!];
  expect(Math.abs(attachBox.y - sendBox.y)).toBeLessThanOrEqual(1);

  // pressed at 0: the hint, nothing attached
  await head.tap();
  await expect(assistant.locator("[data-chat-list-empty]")).toHaveText(sk.chat.list_empty_hint);
  await expect(assistant.locator("[data-list-chip]")).toHaveCount(0);

  // two pieces on the page → "2" on the header button at once (the same store as Zoznam), never over the GDPR pill
  const add = priced(page).first().locator("[data-add-to-list]");
  await add.click();
  await expect(bubble).toHaveText("1");
  await add.click();
  await expect(bubble).toHaveText("2");
  await expect(head).toHaveAttribute("aria-label", sk.chat.list_attach_n.replace("{n}", "2"));
  const dot = (await bubble.boundingBox())!;
  expect(dot.x + dot.width).toBeLessThanOrEqual((await gdpr.boundingBox())!.x);

  let sent: Record<string, unknown> | null = null;
  await page.route("**/api/shops/*/chat", async (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(STUB) });
  });

  // pressed: the list chip above the field; × takes it back; pressed again: it is there again
  await head.tap();
  const chip = assistant.locator("[data-list-chip]");
  await expect(chip).toContainText(sk.chat.list_mine);
  await expect(chip).toContainText(sk.chat.list_pieces.replace("{n}", "2"));
  await chip.locator("[data-list-chip-remove]").tap();
  await expect(chip).toHaveCount(0);
  await head.tap();
  await expect(chip).toHaveCount(1);

  // sent without words: the list is the message
  await assistant.locator("[data-chat-send]").tap();
  await expect(assistant.getByText(STUB.answer)).toBeVisible();
  expect(sent).not.toBeNull();
  const body = sent as unknown as { message: string; list: Record<string, unknown>[] };
  expect(body.message).toBe("");
  expect(body.list.reduce((n, line) => n + Number(line.qty), 0)).toBe(2);
  for (const line of body.list) expect(Object.keys(line).sort()).toEqual(["id", "name", "original", "qty"]);
  // the message shows the list it took ("2× …"), the chip is gone, the bubble still counts the page's list
  await expect(assistant.locator("[data-chat-sent-list]")).toContainText("2×");
  await expect(chip).toHaveCount(0);
  await expect(bubble).toHaveText("2");

  // the owner's {zoznam} in the welcome text (only when this shop's text has it): the same bubble, "0" when empty
  const welcome = assistant.locator('[data-chat-list-button="welcome"]');
  if (await welcome.count()) await expect(welcome).toHaveText("2");
  c.check();
});

test("a restaurant's page has no list button in the assistant's header", async ({ page }) => {
  const restaurant = process.env.E2E_FOOD_SHOP;
  test.skip(!restaurant, "needs E2E_FOOD_SHOP (a test restaurant)");
  await page.goto(`/sk/shops/${restaurant}`);
  const assistant = page.locator("[data-assistant]");
  test.skip((await assistant.count()) === 0, "this restaurant has no assistant");
  await expect(assistant.locator(".ppi-gdpr-btn")).toBeVisible();
  await expect(assistant.locator('[data-chat-list-button="head"]')).toHaveCount(0);
  await assistant.locator("textarea").tap();
  await expect(assistant.locator("[data-chat-input]")).toHaveCount(1);
  await expect(assistant.locator('[data-chat-list-button="head"]')).toHaveCount(0);
});
