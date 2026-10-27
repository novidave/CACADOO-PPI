import { expect, loginOwner, sk, test, watchConsole } from "./helpers";
import { unzip } from "../src/lib/xlsx";

// These checks upload a stock file and approve its columns: only on a shop made for testing, named explicitly.
const SHOP = process.env.E2E_OWNER_SHOP ?? "";

// A small stock file in the columns the test shop's approved mapping knows (Kód; Názov tovaru; EAN; Značka; Množstvo; Cena).
const CSV = "Kód;Názov tovaru;EAN;Značka;Množstvo;Cena s DPH\nE2E1;Test káva e2e;;;5;3,90\nE2E2;Test čaj e2e;;;0;1,90\n";

test.beforeEach(async ({ page }) => {
  test.skip(!SHOP, "no test shop named (E2E_OWNER_SHOP): these checks change its stock and columns");
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

test("translations folder (update 45): files of their own, a downloaded file reads back unchanged", async ({ page }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  // The folder pickers give folders of the browser's private file system (no dialog in a test).
  await page.addInitScript(() => {
    const w = window as unknown as { showDirectoryPicker: (o?: { id?: string }) => Promise<FileSystemDirectoryHandle> };
    w.showDirectoryPicker = async (o) => (await navigator.storage.getDirectory()).getDirectoryHandle(o?.id === "ppi-translations" ? "e2e-preklady" : "e2e-iny", { create: true });
    const proto = FileSystemHandle.prototype as unknown as Record<string, unknown>;
    if (!proto.queryPermission) proto.queryPermission = async () => "granted";
    if (!proto.requestPermission) proto.requestPermission = async () => "granted";
  });
  await page.goto(`/sk/sync?shop=${SHOP}&at=trfolder#trfolder`);
  await page.locator('[data-translation-folder]:not([data-translation-folder="starting"]), [data-review-unavailable]').first().waitFor({ timeout: 30_000 });
  test.skip((await page.locator("[data-translation-folder]").count()) === 0, "database update 45 is not applied");
  if (await page.locator("[data-translation-connect]").count()) await page.locator("[data-translation-connect]").tap();
  const box = page.locator("[data-translation-folder]");
  await expect(box).toHaveAttribute("data-translation-folder", "watching");
  // written (a line per file), or nothing to write for a shop without an approved stock file
  await page.locator("[data-translation-lines], [data-translation-message]").first().waitFor({ timeout: 60_000 });
  const message = page.locator("[data-translation-message]");
  test.skip((await message.count()) > 0 && (await message.innerText()).includes(sk.export_folder.nothing_yet.slice(0, 20)), "the test shop has no approved stock file");
  await expect(page.locator("[data-translation-lines]")).toContainText(".xlsx", { timeout: 60_000 });
  await expect(box).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
  const names = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-preklady");
    const out: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) out.push(name);
    return out;
  });
  expect(names.some((n) => /^sklad\.[a-z-]+\.xlsx$/.test(n))).toBe(true);

  // without the folder: the ZIP, and one of its files uploaded back as it is = no changes
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("[data-translation-download]").tap()]);
  const zip = new Uint8Array(await (await download.createReadStream()).toArray().then((parts) => Buffer.concat(parts)));
  const files = await unzip(zip);
  const [name, bytes] = [...files.entries()][0];
  await page.locator("[data-translation-upload-input]").setInputFiles({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(bytes) });
  await expect(page.locator("[data-translation-hand-result]")).toContainText(sk.export_folder.file_no_changes.replace("{file}", name), { timeout: 30_000 });
  c.check();
});
