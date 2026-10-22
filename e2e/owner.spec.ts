import { expect, test } from "@playwright/test";
import { loginOwner, SHOP, sk, watchConsole } from "./helpers";

// A small stock file in the columns the test shop's approved mapping knows (Kód; Názov tovaru; EAN; Značka; Množstvo; Cena).
const CSV = "Kód;Názov tovaru;EAN;Značka;Množstvo;Cena s DPH\nE2E1;Test káva e2e;;;5;3,90\nE2E2;Test čaj e2e;;;0;1,90\n";

test.beforeEach(async ({ page }) => {
  test.skip(!(await loginOwner(page)), "no owner login configured (E2E_OWNER_EMAIL/PASSWORD or E2E_OWNER_LOGIN_URL)");
});

test("stock upload + column approval", async ({ page }) => {
  const c = watchConsole(page);
  await page.goto(`/sk/sync?shop=${SHOP}`);
  const upload = page.getByRole("button", { name: sk.sync.upload_file });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), upload.tap()]);
  await chooser.setFiles({ name: "e2e-stock.csv", mimeType: "text/csv", buffer: Buffer.from(CSV, "utf8") });
  // Feedback at once ("Nahrávam súbor…"), then the result of the upload.
  await expect(page.getByRole("button", { name: sk.sync.uploading_file })).toBeVisible({ timeout: 2000 }).catch(() => {});
  await expect(upload).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('[role="status"]').first()).not.toBeEmpty();

  // The columns: approving the mapping (as it stands) answers with the saved message.
  await page.goto(`/sk/dashboard/translations?shop=${SHOP}&at=columns`);
  const form = page.locator("#columns form").first();
  test.skip((await form.count()) === 0, "no column proposal to approve");
  const send = form.locator('button[type="submit"]').first();
  await send.tap();
  await expect(page).toHaveURL(/ok=columns|err=/, { timeout: 30_000 });
  expect(page.url()).toContain("ok=columns");
  c.check();
});

test("Produkty search", async ({ page }) => {
  const c = watchConsole(page);
  await page.goto(`/sk/dashboard/translations?shop=${SHOP}&at=items`);
  const items = page.locator("#items");
  const search = items.locator('form[role="search"] input[name="q"]');
  await search.fill("káva");
  await search.press("Enter");
  await expect(page).toHaveURL(/q=k%C3%A1va|q=káva/);
  const rows = items.locator("[data-item-row]");
  await expect(rows.first()).toBeVisible();
  for (const text of await rows.allInnerTexts()) expect(text.toLowerCase()).toMatch(/k[aá]v/);
  // Every row: one link "Popis a preklady" and what the shopper sees.
  expect(await items.locator("[data-item-detail]").count()).toBe(await rows.count());
  expect(await items.locator("[data-shopper-sees]").count()).toBe(await rows.count());
  c.check();
});
