import { expect, sk, SHOP, test, watchConsole } from "./helpers";

/**
 * The shop assistant's chat (2026-11-06, at the owner's request): a taller field while no question was asked, then the
 * log takes the phone's screen (the box's top at the top of the screen, the field one line), two-colour bubbles,
 * "Upraviť správu" making a branch with its "‹ 1/2 ›" pager and the header's "2 vetvy". The answers come from a test
 * stub (no AI is called). Runs on a shop with the assistant (paid plan); skipped otherwise.
 */

const reply = (answer: string) => ({
  answer,
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
});

test("assistant: idle field, the log takes the screen, bubbles, an edit makes a branch (test AI)", async ({ page }) => {
  const c = watchConsole(page);
  await page.goto(`/sk/shops/${SHOP}`);
  const assistant = page.locator("[data-assistant]");
  test.skip((await assistant.count()) === 0, "this shop has no assistant");
  const field = assistant.locator("#assistant-question");

  // idle: the field is about four lines high (server's first view and the chat alike)
  await expect(assistant).toHaveAttribute("data-chat", "idle");
  expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(120);
  await field.tap();
  await expect(assistant.locator("[data-chat-input]")).toHaveCount(1);
  await expect(assistant).toHaveAttribute("data-chat", "idle");
  expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(120);

  let n = 0;
  const asked: { message: string; history: { role: string; text: string }[] }[] = [];
  await page.route("**/api/shops/*/chat", async (route) => {
    asked.push(route.request().postDataJSON());
    n++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reply(`Odpoveď ${n}`)) });
  });

  // the first question: "on", the box's top at the screen's top, the log ≥ 60 % of the screen, the field one line
  await field.fill("Máte farbu na drevo?");
  await assistant.locator("[data-chat-send]").tap();
  await expect(assistant.getByText("Odpoveď 1")).toBeVisible();
  await expect(assistant).toHaveAttribute("data-chat", "on");
  await expect.poll(async () => Math.abs((await assistant.boundingBox())!.y), { timeout: 3000 }).toBeLessThanOrEqual(2);
  const viewport = page.viewportSize()!;
  // the chat area (the static welcome on top + the log under it, 2026-11-07) takes ≥ 60 % of the screen
  const chatArea = async () => {
    const [w, l] = [(await assistant.locator("[data-chat-welcome]").boundingBox())!, (await assistant.locator("[data-chat-log]").boundingBox())!];
    return l.y + l.height - w.y;
  };
  await expect.poll(chatArea).toBeGreaterThanOrEqual(viewport.height * 0.6);
  await expect.poll(async () => Math.round((await field.boundingBox())!.height)).toBeLessThanOrEqual(49);

  // 2026-11-07: the welcome stays at the top while the log scrolls under it (it is never inside the log)
  const welcome = assistant.locator("[data-chat-welcome]");
  await expect(assistant.locator("[data-chat-log] [data-chat-welcome]")).toHaveCount(0);
  const welcomeTop = (await welcome.boundingBox())!.y;
  await assistant.locator("[data-chat-log]").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  expect(Math.abs((await welcome.boundingBox())!.y - welcomeTop)).toBeLessThanOrEqual(0.5);
  expect(await welcome.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe("1px");

  // the bubbles: the shopper right (blue), the assistant left (orange); "Vy" / "Asistent" once per run
  const mine = assistant.locator('[data-chat-bubble="user"]').first();
  const theirs = assistant.locator('[data-chat-bubble="assistant"]').first();
  expect(await mine.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(239, 245, 255)");
  expect(await theirs.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 246, 238)");
  const log = (await assistant.locator("[data-chat-log]").boundingBox())!;
  const [mb, tb] = [(await mine.boundingBox())!, (await theirs.boundingBox())!];
  expect(log.x + log.width - (mb.x + mb.width)).toBeLessThan(4);
  expect(tb.x - log.x).toBeLessThan(4);
  // Inter inside the chat, Quicksand in the header
  expect(await mine.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/inter/i);
  expect(await assistant.locator("[data-chat-title]").evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/quicksand/i);

  // a second question, then edit the first one: Esc cancels, empty shows the error, a new text makes a branch
  await field.fill("A koľko stojí?");
  await assistant.locator("[data-chat-send]").tap();
  await expect(assistant.getByText("Odpoveď 2")).toBeVisible();
  const pencil = assistant.locator("[data-chat-edit-open]").first();
  await pencil.tap();
  const edit = assistant.locator("[data-chat-edit-field]");
  await expect(edit).toBeFocused();
  await edit.press("Escape");
  await expect(edit).toHaveCount(0);
  await pencil.tap();
  await edit.fill("   ");
  await edit.press("Enter");
  await expect(assistant.locator("[data-chat-edit-empty]")).toHaveText(sk.chat.edit_empty);
  await expect(edit).toHaveAttribute("aria-invalid", "true");
  await expect(assistant.locator(".ppi-msg-edit-hint")).toHaveText(sk.chat.edit_hint);
  await edit.fill("Máte lak na drevo?");
  await edit.press("Enter");
  await expect(assistant.getByText("Odpoveď 3")).toBeVisible();
  // only the path before the edited question went along (nothing: it was the first one)
  expect(asked[2].message).toBe("Máte lak na drevo?");
  expect(asked[2].history).toEqual([]);

  // "2/2" under the edited question, the old answers hidden, the header pill "2 vetvy"
  await expect(assistant.locator("[data-chat-branch-pos]").first()).toHaveText("2/2");
  await expect(assistant.getByText("Odpoveď 2")).toBeHidden();
  await expect(assistant.locator("[data-chat-branches]")).toHaveText("2 vetvy");
  // back to branch 1: its old answers come back as they were
  await assistant.locator("[data-chat-branch-prev]").first().tap();
  await expect(assistant.locator("[data-chat-branch-pos]").first()).toHaveText("1/2");
  await expect(assistant.getByText("Odpoveď 1")).toBeVisible();
  await expect(assistant.getByText("Odpoveď 2")).toBeVisible();
  await expect(assistant.getByText("Odpoveď 3")).toBeHidden();
  await expect(assistant.locator("[data-chat-branch-prev]").first()).toBeDisabled();

  // 2026-11-07: no link row under the chat; the GDPR panel holds the sentence and the conversation's actions
  await expect(assistant.locator("form [data-chat-action]")).toHaveCount(0);
  const panel = assistant.locator("[data-chat-gdpr]");
  await panel.locator("summary").tap();
  await expect(panel.locator("[data-chat-gdpr-short]")).toBeVisible();
  const clear = panel.locator('[data-chat-action="clear"]');
  await expect(clear).toHaveText(sk.chat.clear);
  expect((await clear.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  // the PDF row only inside the panel (and only when the shop allows it)
  await expect(assistant.locator("[data-conversation-pdf]:not([data-chat-gdpr] *)")).toHaveCount(0);
  // Esc closes the panel and the focus goes back to the pill
  await page.keyboard.press("Escape");
  await expect(panel).not.toHaveAttribute("open", "");
  await expect(panel.locator("summary")).toBeFocused();
  // "Nová konverzácia" starts over and closes the panel
  await panel.locator("summary").tap();
  await clear.tap();
  await expect(panel).not.toHaveAttribute("open", "");
  await expect(assistant.getByText("Odpoveď 1")).toHaveCount(0);
  await expect(assistant).toHaveAttribute("data-chat", "idle");
  await panel.locator("summary").tap();
  await expect(panel.locator('[data-chat-action="clear"]')).toHaveCount(0);

  // nothing scrolls sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  c.check();
});
