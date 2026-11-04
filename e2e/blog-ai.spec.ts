import { expect, loginOwner, test, watchConsole } from "./helpers";

/**
 * The blog editor's AI and the safe text format (update 77): write → "Skrášliť článok" (the AI stubbed: the request to
 * the translate function is answered here) → "Použiť" → the preview → publish → the post page draws the same marks
 * (a subheading, a list, bold). Needs an owner login and E2E_OWNER_SHOP (a test shop with the plan and the AI key);
 * skipped otherwise (the post stays on the test shop).
 */

const SHOP = process.env.E2E_OWNER_SHOP;

test("write → Skrášliť (stub) → Použiť → publish → the page shows the same format", async ({ page }) => {
  test.skip(!SHOP, "E2E_OWNER_SHOP is not set");
  test.skip(!(await loginOwner(page)), "no owner login");
  const c = watchConsole(page);
  await page.goto(`/sk/dashboard/blog/new?shop=${SHOP}`);
  const editor = page.locator("[data-blog-editor]");
  const title = `E2E skrášlenie ${Date.now()}`;
  await editor.locator('input[name="title"]').fill(title);
  await editor.locator('textarea[name="body"]').fill("Máme nové farby. Biela aj čierna, od pondelka.");
  const ai = editor.locator("[data-blog-ai]");
  test.skip((await ai.count()) === 0 || (await ai.locator("[data-blog-ai-pro]").count()) > 0, "no AI key or no plan on this shop");

  const pretty = "Máme nové farby.\n\n## Čo máme\n- **Biela**\n- Čierna\n\nOd pondelka.";
  let asked: Record<string, unknown> | null = null;
  await page.route("**/functions/v1/translate", async (route) => {
    asked = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ title_suggestion: "", body: pretty, language: "sk", photos: 0, left: 19 }) });
  });
  await ai.locator("[data-blog-ai-beautify]").click();
  const proposal = ai.locator('[data-blog-ai-proposal="beautify"]');
  await expect(proposal).toBeVisible();
  expect(asked).not.toBeNull();
  expect((asked as unknown as { action: string; style: string }).action).toBe("blog_beautify");
  expect((asked as unknown as { style: string }).style).toBe("friendly");
  await expect(proposal.locator("[data-blog-sub]")).toHaveText("Čo máme");
  await proposal.locator("[data-blog-ai-apply]").click();
  await expect(editor.locator('textarea[name="body"]')).toHaveValue(pretty);
  await expect(ai.locator("[data-blog-ai-undo]")).toBeVisible();
  // the live preview draws the marks at both widths
  await expect(editor.locator("[data-blog-preview] [data-blog-sub]")).toHaveCount(2);
  await expect(editor.locator("[data-blog-preview] strong").first()).toHaveText("Biela");

  // publish on the web only, then the post page shows the same blocks
  await editor.locator("[data-publish]").click();
  const dialog = page.locator("[data-publish-dialog]");
  if (await dialog.isVisible().catch(() => false)) await dialog.locator('[data-choice="web"]').click();
  await expect(editor.locator("[data-publish-result]")).toBeVisible();
  const view = editor.locator("[data-publish-result] a").first();
  const href = await view.getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(href!);
  const article = page.locator("[data-blog-text]");
  await expect(article.locator("[data-blog-sub]")).toHaveText("Čo máme");
  await expect(article.locator("[data-blog-list] li")).toHaveCount(2);
  await expect(article.locator("strong")).toHaveText("Biela");
  await expect(page.getByText("## Čo máme")).toHaveCount(0);
  c.check();
});
