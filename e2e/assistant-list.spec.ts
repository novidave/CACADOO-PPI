import type { Page } from "@playwright/test";
import { expect, sk, SHOP, test, watchConsole } from "./helpers";

/**
 * The shop page's "Zoznam" inside the shop assistant (2026-11-04): the round blue bubble in the chat bar counts the
 * pieces of the page's list live, pressing it puts the list into the message as a chip (× takes it back), and the
 * request carries only ids, names and pieces — never a price, a total or the address. The answer comes from a test
 * stub (no AI is called). Runs only on a shop with the assistant (paid plan) and an item with a price.
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

  // the assistant's code comes with the first touch; an empty list: no bubble in the chat bar
  await assistant.locator("textarea").tap();
  const bubble = assistant.locator('[data-chat-list-button="bar"]');
  await expect(assistant.locator("[data-chat-send]")).toBeVisible();
  await expect(bubble).toHaveCount(0);

  // two pieces on the page → "2" in the chat bar at once (the same store as Zoznam)
  const add = priced(page).first().locator("[data-add-to-list]");
  await add.click();
  await expect(bubble).toHaveText("1");
  await add.click();
  await expect(bubble).toHaveText("2");
  await expect(bubble).toHaveAttribute("aria-label", sk.chat.list_attach_n.replace("{n}", "2"));
  const box = await bubble.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);

  let sent: Record<string, unknown> | null = null;
  await page.route("**/api/shops/*/chat", async (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(STUB) });
  });

  // pressed: the list chip in the input bar; × takes it back; pressed again: it is there again
  await bubble.tap();
  const chip = assistant.locator("[data-list-chip]");
  await expect(chip).toContainText(sk.chat.list_mine);
  await expect(chip).toContainText(sk.chat.list_pieces.replace("{n}", "2"));
  await chip.locator("[data-list-chip-remove]").tap();
  await expect(chip).toHaveCount(0);
  await bubble.tap();
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
