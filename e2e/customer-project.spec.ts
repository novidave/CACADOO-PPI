import { expect, loginOwner, sk, test, watchConsole } from "./helpers";

/**
 * Customer projects (update 95). The owner (E2E_OWNER_SHOP, Pro) writes "Stav projektu" for a contact with a checked
 * number (E2E_PROJECT_CONTACT, its number E2E_PROJECT_PHONE) and switches "Zákazník sa môže pýtať asistenta na svoj
 * projekt" on. On the shop page the assistant's answer asks for the number (the chat is a test stub: no AI is called;
 * the conversation is a real one), the project form sends the SMS code (needs SMS_PROVIDER test +
 * BOOKING_TEST_CODES=on: the code comes back to the page), the code opens the project for THIS conversation (the
 * HttpOnly cookie) and the question goes again with it; "Nová konverzácia" locks it — the cookie is gone and the next
 * question needs the code again. Skipped without these settings.
 */

const SHOP = process.env.E2E_OWNER_SHOP ?? "";
const CONTACT = process.env.E2E_PROJECT_CONTACT ?? "";
const PHONE = process.env.E2E_PROJECT_PHONE ?? "";

const reply = (answer: string, conversation: { id: string; token: string }, verifyProject = false) => ({
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
  verifyProject,
  conversation,
});

test("a customer's project: the owner's status, the shopper's SMS code, locked again by a new conversation", async ({ page, context }) => {
  test.skip(!SHOP || !CONTACT || !PHONE, "needs E2E_OWNER_SHOP, E2E_PROJECT_CONTACT and E2E_PROJECT_PHONE");
  test.skip(!(await loginOwner(page)), "needs an owner login");
  const errors = watchConsole(page);

  // the owner: status + the switch on
  await page.goto(`/sk/dashboard/contacts/${CONTACT}?tab=project`);
  const panel = page.locator('[data-tab-panel="project"]');
  await expect(panel).toBeVisible();
  test.skip((await panel.locator("[data-project-status]").count()) === 0, "the contact's number is not checked or update 95 is missing");
  const status = `Montáž v piatok ${Date.now()}`;
  await panel.locator("[data-project-status]").fill(status);
  await panel.locator("[data-project-status-form] button[type=submit]").click();
  await expect(panel.getByText(sk.project.saved)).toBeVisible();
  const enabled = panel.locator("[data-project-enabled]");
  if (!(await enabled.isChecked())) await enabled.click();
  await expect(enabled).toBeChecked();

  // the shopper: a real conversation, the chat stubbed
  await page.goto(`/sk/shops/${SHOP}`);
  const assistant = page.locator("[data-assistant]");
  test.skip((await assistant.count()) === 0, "this shop has no assistant");
  const start = await page.request.post(`/api/shops/${SHOP}/conversation`, { data: { action: "start", lang: "sk" } });
  test.skip(!start.ok(), "the conversation archive is off");
  const conversation = (await start.json()) as { id: string; token: string };
  const asked: { message: string; cookie: boolean }[] = [];
  await page.route("**/api/shops/*/chat", async (route) => {
    const cookie = ((await route.request().allHeaders()).cookie ?? "").includes(`ppi_proj_${SHOP}=`);
    asked.push({ message: route.request().postDataJSON().message, cookie });
    const open = cookie;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reply(open ? status : "Overte svoje číslo.", conversation, !open)),
    });
  });
  const field = assistant.locator("#assistant-question");
  await field.fill("Ako je na tom môj projekt?");
  await assistant.locator("[data-chat-send]").click();
  const form = assistant.locator("[data-project-panel]");
  await expect(form).toBeVisible();
  await form.locator("input[name=phone]").fill(PHONE);
  await form.locator("[data-project-send]").click();
  const code = form.locator("[data-project-test-code]");
  test.skip(!(await code.isVisible({ timeout: 10_000 }).catch(() => false)), "no test codes on this site (SMS_PROVIDER test + BOOKING_TEST_CODES=on)");
  const digits = ((await code.textContent()) ?? "").replace(/\D/g, "").slice(-6);
  await form.locator("input[name=code]").fill(digits);
  await form.locator("[data-project-unlock]").click();
  await expect(assistant.locator("[data-project-open]")).toBeVisible();
  // the question again, now with this conversation's project session (the HttpOnly cookie, never in the page)
  await expect.poll(() => asked.at(-1)?.cookie).toBe(true);
  await expect(assistant.getByText(status)).toBeVisible();
  expect(await page.evaluate(() => document.cookie.includes("ppi_proj_"))).toBe(false);

  // "Nová konverzácia" locks it: the cookie goes, the next question needs the code again
  const locked = page.waitForRequest((r) => r.url().endsWith("/project") && r.method() === "POST");
  await assistant.locator("[data-chat-gdpr] summary").click();
  await assistant.locator('[data-chat-action="clear"]').click();
  await locked;
  await expect.poll(async () => (await context.cookies()).some((c) => c.name === `ppi_proj_${SHOP}`)).toBe(false);
  await field.fill("A teraz?");
  await assistant.locator("[data-chat-send]").click();
  await expect(assistant.locator("[data-project-panel]")).toBeVisible();
  expect(asked.at(-1)?.cookie).toBe(false);

  // the owner switches it off again
  await page.goto(`/sk/dashboard/contacts/${CONTACT}?tab=project`);
  await page.locator("[data-project-enabled]").click();
  await expect(page.locator("[data-project-enabled]")).not.toBeChecked();
  errors.check();
});
