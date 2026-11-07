import { expect, loginOwner, sk, test, watchConsole } from "./helpers";

/**
 * "Štýl asistenta" (database update 92, 2026-11-07): on AI asistent → Nastavenia a restaurant chooses "Čašník" and a
 * name, the shop page's chat header shows the name, and a goods shop is never offered "Čašník". The restaurant's own
 * style and name are put back at the end. The AI is never called (only the settings and the page's header).
 *
 * Needs an owner login with E2E_FOOD_SHOP (a test restaurant with the Pro plan) and E2E_OWNER_SHOP (a goods shop);
 * skipped otherwise.
 */
const FOOD = process.env.E2E_FOOD_SHOP ?? "";
const GOODS = process.env.E2E_OWNER_SHOP ?? "";
const a = sk.asst;

test.describe("assistant style", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!FOOD, "needs E2E_FOOD_SHOP (a test restaurant)");
    test.skip(!(await loginOwner(page)), "needs an owner login");
  });

  test("Čašník + Marco saved, the chat header shows the name, a goods shop has no Čašník", async ({ page }) => {
    const c = watchConsole(page);
    await page.goto(`/sk/dashboard/assistant?shop=${encodeURIComponent(FOOD)}`);
    const style = page.locator("[data-assistant-style]");
    test.skip((await style.count()) === 0, "database update 92 is not applied or the restaurant has no plan");
    const was = await page.locator('input[name="was_style"]').inputValue();
    const wasName = await page.locator('input[name="was_assistant_name"]').inputValue();

    await style.getByText(a.style_waiter, { exact: true }).click();
    await expect(page.locator('[data-style-sample="waiter"]')).toBeVisible();
    await expect(page.locator('[data-style-sample="plain"]')).toBeHidden();
    await page.locator("[data-assistant-name]").fill("Marco");
    await page.locator("[data-assistant-form] [data-save-bar] button[type=submit]").click();
    await expect(page.locator("[data-assistant-notice]")).toBeVisible();
    await expect(page.locator('input[name="assistant_style"][value="waiter"]')).toBeChecked();
    await expect(page.locator("[data-assistant-name]")).toHaveValue("Marco");

    // the shop page: the chat's header title is the name (the server's first view, no AI call)
    await page.goto(`/sk/shops/${encodeURIComponent(FOOD)}`);
    const assistant = page.locator("#assistant");
    if (await assistant.count()) await expect(assistant.locator(".ppi-ai-head")).toContainText("Marco");

    // put the restaurant's own choice back
    await page.goto(`/sk/dashboard/assistant?shop=${encodeURIComponent(FOOD)}`);
    await page.locator(`input[name="assistant_style"][value="${was}"]`).check({ force: true });
    await page.locator("[data-assistant-name]").fill(wasName);
    await page.locator("[data-assistant-form] [data-save-bar] button[type=submit]").click();
    await expect(page.locator("[data-assistant-notice]")).toBeVisible();

    // a goods shop: no "Čašník"
    if (GOODS) {
      await page.goto(`/sk/dashboard/assistant?shop=${encodeURIComponent(GOODS)}`);
      if (await page.locator("[data-assistant-style]").count()) {
        await expect(page.locator('input[name="assistant_style"][value="waiter"]')).toHaveCount(0);
        await expect(page.locator('input[name="assistant_style"][value="plain"]')).toHaveCount(1);
      }
    }
    c.check();
  });
});
