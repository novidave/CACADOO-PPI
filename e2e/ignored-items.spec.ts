import { expect, loginOwner, sk, test, watchConsole } from "./helpers";

/**
 * "Ignorované produkty" (update 88, 2026-11-07): Priečinok s exportom → Nebezpečná zóna – sklad → Ignorované produkty.
 * Upraviť → round ticks → tick 2 → Vymazať → the dialog → gone from the list (and the shop page); the same file
 * uploaded again → still gone, the import card says "Ignorované: 2"; Obnoviť → the file again → back. At 1180×820 and
 * 390×844, nothing scrolls sideways and the page's title does not move. Only on a test shop whose stock comes from
 * files (E2E_OWNER_SHOP) with an owner login; its stock is changed and put back by the same file.
 */

const SHOP = process.env.E2E_OWNER_SHOP ?? "";
// The test shop's approved columns (see owner.spec.ts): Kód; Názov tovaru; EAN; Značka; Množstvo; Cena s DPH.
const CSV =
  "Kód;Názov tovaru;EAN;Značka;Množstvo;Cena s DPH\n" +
  "E2EI1;Test ignor jeden e2e;;;5;3,90\nE2EI2;Test ignor dva e2e;;;2;1,90\nE2EI3;Test ignor tri e2e;;;7;2,50\n";
const l = sk.ignored;

const SIZES = [
  { name: "tablet", width: 1180, height: 820 },
  { name: "phone", width: 390, height: 844 },
];

test.beforeEach(async ({ page }) => {
  test.skip(!SHOP, "no test shop named (E2E_OWNER_SHOP): this check changes its stock");
  test.skip(!(await loginOwner(page)), "no owner login configured (E2E_OWNER_EMAIL/PASSWORD or E2E_OWNER_LOGIN_URL)");
});

async function upload(page: import("@playwright/test").Page) {
  await page.goto(`/sk/sync?shop=${SHOP}`);
  const button = page.getByRole("button", { name: sk.sync.upload_file });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), button.click()]);
  // a new name each time: a file is never the same as the last one applied
  await chooser.setFiles({ name: `e2e-ignored-${Date.now()}.csv`, mimeType: "text/csv", buffer: Buffer.from(CSV, "utf8") });
  await expect(button).toBeEnabled({ timeout: 30_000 });
}

const noSideways = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const size of SIZES) {
  test(`ignored products at ${size.name}: delete 2, the same file keeps them out, restore brings them back`, async ({ page }) => {
    test.setTimeout(180_000);
    const c = watchConsole(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await upload(page);

    await page.goto(`/sk/sync?shop=${SHOP}&at=ignored#ignored`);
    const zone = page.locator("[data-ignored-items]");
    await expect(zone).toBeVisible();
    const title = await page.locator("h1").first().boundingBox();
    // clean start: anything of this test still ignored is restored first
    const leftover = zone.locator('[data-ignored-list] [data-ignore-row^="E2EI"]');
    if ((await leftover.count()) > 0) {
      await zone.locator("[data-ignored-edit]").click();
      for (const row of await leftover.all()) await row.locator("label").click();
      await zone.locator("[data-ignored-restore]").click();
      await expect(zone.locator("[data-ignored-restored]")).toBeVisible();
      await upload(page);
      await page.goto(`/sk/sync?shop=${SHOP}&at=ignored#ignored`);
    }

    await zone.locator("[data-ignore-search]").fill("ignor e2e");
    const one = zone.locator('[data-ignore-list] [data-ignore-row="E2EI1"]');
    const two = zone.locator('[data-ignore-list] [data-ignore-row="E2EI2"]');
    await expect(one).toBeVisible();
    await expect(two).toBeVisible();

    // Upraviť: the rows slide 44 px, round ticks
    const body = one.locator("[data-ignore-row-body] > span").first();
    const before = (await body.boundingBox())!.x;
    await zone.locator("[data-ignore-edit]").click();
    await expect(one.locator("[data-ignore-tick]")).toHaveAttribute("data-ignore-tick", "off");
    await expect.poll(async () => Math.round((await body.boundingBox())!.x - before)).toBeGreaterThanOrEqual(40);
    const tick = one.locator("[data-ignore-tick]");
    const tb = (await tick.boundingBox())!;
    expect(Math.round(tb.width)).toBe(24);
    expect(await tick.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe("rgb(37, 99, 235)");

    // tick 2 (a tap on the row ticks it)
    await one.locator("label").click();
    await two.locator("label").click();
    await expect(one.locator("[data-ignore-tick]")).toHaveAttribute("data-ignore-tick", "on");
    expect(await one.locator("[data-ignore-tick]").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(37, 99, 235)");
    const deleteButton = size.width < 640 ? zone.locator("[data-ignore-delete-phone]") : zone.locator("[data-ignore-delete]");
    await expect(deleteButton).toHaveText(l.delete_n.replace("{n}", "2"));
    if (size.width < 640) await expect(zone.locator("[data-ignore-phone-bar]")).toContainText(l.selected_n.replace("{n}", "2"));
    expect(await noSideways(page)).toBe(true);

    // the dialog: Esc = back, nothing removed
    await deleteButton.click();
    const dialog = page.locator("[data-ignore-dialog]");
    await expect(dialog).toContainText(l.dialog_title_few.replace("{n}", "2"));
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(one).toBeVisible();
    await deleteButton.click();
    await dialog.locator("[data-ignore-confirm]").click();
    await expect(page.locator("[data-ignore-toast]")).toContainText(l.toast.replace("{n}", "2"));
    await expect(one).toHaveCount(0);
    await expect(two).toHaveCount(0);
    await expect(zone.locator('[data-ignored-list] [data-ignore-row="E2EI1"]')).toBeVisible();
    expect(Math.abs((await page.locator("h1").first().boundingBox())!.y - title!.y)).toBeLessThanOrEqual(0.5);

    // the same file again: still out, "Ignorované: 2" on the import card
    await upload(page);
    await expect(page.locator("[data-import-ignored]").first()).toHaveText(sk.imports.ignored.replace("{n}", "2"));
    await page.goto(`/sk/sync?shop=${SHOP}&at=ignored#ignored`);
    await zone.locator("[data-ignore-search]").fill("ignor e2e");
    await expect(zone.locator('[data-ignore-list] [data-ignore-row="E2EI3"]')).toBeVisible();
    await expect(one).toHaveCount(0);

    // Obnoviť → the file again → back
    await zone.locator("[data-ignored-edit]").click();
    await zone.locator('[data-ignored-list] [data-ignore-row="E2EI1"] label').click();
    await zone.locator('[data-ignored-list] [data-ignore-row="E2EI2"] label').click();
    await zone.locator("[data-ignored-restore]").click();
    await expect(zone.locator("[data-ignored-restored]")).toContainText(l.restored.replace("{n}", "2"));
    await upload(page);
    await page.goto(`/sk/sync?shop=${SHOP}&at=ignored#ignored`);
    await zone.locator("[data-ignore-search]").fill("ignor e2e");
    await expect(one).toBeVisible();
    await expect(two).toBeVisible();
    expect(await noSideways(page)).toBe(true);
    c.check();
  });
}
