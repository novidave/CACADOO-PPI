import { expect, loginOwner, sk, test, watchConsole } from "./helpers";

/**
 * Blog photos (database update 93, 2026-11-07): a draft with two photos → one placed in the text → 1:1 + hore in the
 * preview's toolbar (the line in the text field changes, the preview shows it square) → "Vymeniť" (the same line, a
 * new picture) → "Odstrániť z textu" → "Skrášliť" with a stub that puts a portrait photo in 16:9 (the translate
 * function's own check returns it plain — here the stub returns what the function would) → the cover's crop.
 * Needs an owner login and E2E_OWNER_SHOP; skipped otherwise. The draft is deleted at the end.
 */

const SHOP = process.env.E2E_OWNER_SHOP;
const b = sk.owner_blog;

/** A small PNG of the given size (drawn in the page, so no file is kept in the repository). */
async function png(page: import("@playwright/test").Page, width: number, height: number, color: string): Promise<Buffer> {
  const data = await page.evaluate(
    ([w, h, c]) => {
      const canvas = document.createElement("canvas");
      canvas.width = Number(w);
      canvas.height = Number(h);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = String(c);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png").split(",")[1];
    },
    [width, height, color],
  );
  return Buffer.from(data, "base64");
}

test("photos in the text: ratio + crop, replace, remove from the text, the cover's crop", async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!SHOP, "E2E_OWNER_SHOP is not set");
  test.skip(!(await loginOwner(page)), "no owner login");
  const c = watchConsole(page);
  await page.goto(`/sk/dashboard/blog/new?shop=${SHOP}`);
  const editor = page.locator("[data-blog-editor]");
  await editor.locator('input[name="title"]').fill(`E2E fotky ${Date.now()}`);
  const field = editor.locator('textarea[name="body"]');
  await field.fill("Máme nové farby.");

  // two photos: a landscape and a portrait one
  const landscape = await png(page, 1200, 800, "#3366cc");
  const portrait = await png(page, 800, 1200, "#cc6633");
  await editor.locator("[data-photo-input]").setInputFiles([
    { name: "siroka.png", mimeType: "image/png", buffer: landscape },
    { name: "vysoka.png", mimeType: "image/png", buffer: portrait },
  ]);
  const photos = editor.locator("[data-editor-photo]");
  await expect(photos).toHaveCount(2, { timeout: 30_000 });
  const [first, second] = [await photos.nth(0).getAttribute("data-editor-photo"), await photos.nth(1).getAttribute("data-editor-photo")];

  // "Do textu", then the preview's toolbar: 1:1 + hore → the line and the preview change at once
  await field.click();
  await field.press("End");
  await photos.nth(0).locator("[data-photo-insert]").click();
  await expect(field).toHaveValue(new RegExp(`\\[\\[foto:${first}\\]\\]`));
  await editor.locator(`[data-blog-preview] [data-photo-open="${first}"]`).first().click();
  const tool = page.locator("[data-photo-tool]");
  await expect(tool).toBeVisible();
  await tool.locator('[data-tool-ratio="1:1"]').click();
  await tool.locator('[data-tool-crop="top"]').click();
  await expect(field).toHaveValue(new RegExp(`\\[\\[foto:${first}\\|1:1\\|hore\\]\\]`));
  const fig = editor.locator(`[data-blog-preview] [data-blog-photo="${first}"]`).first();
  await expect(fig).toHaveAttribute("data-photo-ratio", "1:1");
  const img = (await fig.locator("img").boundingBox())!;
  expect(Math.abs(img.width - img.height)).toBeLessThanOrEqual(2);
  await tool.locator("[data-tool-close]").click();

  // "Vymeniť": the same line (the same id), a new picture
  const before = await photos.nth(0).locator("img").getAttribute("src");
  await page.locator("[data-photo-replace-input]").setInputFiles({ name: "nova.png", mimeType: "image/png", buffer: await png(page, 1000, 1000, "#22aa55") });
  await expect.poll(() => photos.nth(0).locator("img").getAttribute("src"), { timeout: 30_000 }).not.toBe(before);
  await expect(field).toHaveValue(new RegExp(`\\[\\[foto:${first}\\|1:1\\|hore\\]\\]`));
  await expect(editor.locator("[data-photo-replace]")).toHaveCount(2);

  // "Odstrániť z textu": only the line goes, the photo stays
  await editor.locator(`[data-blog-preview] [data-photo-open="${first}"]`).first().click();
  await tool.locator("[data-tool-unplace]").click();
  await expect(field).not.toHaveValue(new RegExp(first!));
  await expect(photos).toHaveCount(2);

  // "Skrášliť" (stub): the function returns the portrait photo plain (its 16:9 would cut > 20 %)
  const ai = editor.locator("[data-blog-ai]");
  if ((await ai.count()) && !(await ai.locator("[data-blog-ai-pro]").count())) {
    await page.route("**/functions/v1/translate", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ title_suggestion: "", body: `Máme nové farby.\n\n[[foto:${second}]]`, language: "sk", photos: 1, left: 19 }) }),
    );
    await ai.locator("[data-blog-ai-beautify]").click();
    await ai.locator("[data-blog-ai-apply]").click();
    await expect(field).toHaveValue(`Máme nové farby.\n\n[[foto:${second}]]`);
  }

  // the cover: the second photo, its crop "hore"
  await editor.locator(`[data-photo-cover="${second}"]`).check();
  await editor.locator('[data-cover-focus] [data-focus="top"]').click();
  await expect(editor.locator('[data-cover-focus] [data-focus="top"]')).toHaveAttribute("aria-pressed", "true");
  await expect(editor.getByText(b.photos_owned_note)).toHaveCount(0);

  // clean up: the draft goes
  await page.goto(`/sk/dashboard/blog?shop=${SHOP}`);
  c.check();
});
