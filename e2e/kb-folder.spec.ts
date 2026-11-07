import { expect, loginOwner, sk, test, watchConsole } from "./helpers";

/**
 * "Priečinok na počítači" (update 94): AI asistent → Dokumenty. A folder of the Origin Private File System stands in
 * for the PC folder (showDirectoryPicker answers it): link → a PDF in the folder appears among the documents → the
 * file changed → its document replaced (one document of that name) → the file deleted → "Chýba v priečinku" →
 * Odstrániť. Only on a Pro test shop (E2E_OWNER_SHOP) with an owner login; what it uploads it removes again.
 */

const SHOP = process.env.E2E_OWNER_SHOP ?? "";
const l = sk.kbfolder;

/** A one-page PDF with one line of text (pdf.js reads it). */
function pdf(text: string): string {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  return `${out}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test.beforeEach(async ({ page }) => {
  test.skip(!SHOP, "no test shop named (E2E_OWNER_SHOP)");
  test.skip(!(await loginOwner(page)), "no owner login configured (E2E_OWNER_EMAIL/PASSWORD or E2E_OWNER_LOGIN_URL)");
});

test("a PC folder: link, upload, replace, missing, remove", async ({ page }) => {
  const errors = watchConsole(page);
  const name = `e2e-kb-${Date.now()}.pdf`;
  await page.addInitScript(() => {
    (window as unknown as { __ppiKbSettleMs: number }).__ppiKbSettleMs = 0;
    const w = window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> };
    w.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-kb", { create: true });
  });
  const write = (text: string | null) =>
    page.evaluate(
      async ({ name, text }) => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-kb", { create: true });
        if (text === null) return dir.removeEntry(name);
        const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await w.write(text);
        await w.close();
      },
      { name, text },
    );
  await page.goto(`/sk/dashboard/assistant/documents?shop=${SHOP}`);
  const section = page.locator("[data-kb-section] li").first();
  await write(pdf("Cennik prvy"));
  const unlink = section.locator("[data-kb-unlink]");
  if (await unlink.isVisible()) await unlink.click();
  await section.locator("[data-kb-link]").click();
  await expect(section.locator("[data-kb-status]")).toContainText("Synchronizované", { timeout: 90_000 });
  const docName = name.replace(/\.pdf$/, "");
  await expect(page.getByText(docName).first()).toBeVisible({ timeout: 30_000 });

  // the file changed: its own document is replaced, never a second one
  await write(pdf("Cennik druhy"));
  await section.locator("[data-kb-check]").click();
  await expect(section.locator("[data-kb-status]")).toContainText("Synchronizované", { timeout: 90_000 });
  await page.reload();
  await expect(page.getByText(docName, { exact: true })).toHaveCount(1, { timeout: 30_000 });

  // the file deleted: "Chýba v priečinku", then Odstrániť
  await write(null);
  await page.locator("[data-kb-section] li").first().locator("[data-kb-check]").click();
  const missing = page.locator("[data-kb-section] li").first().locator("[data-kb-missing]");
  await expect(missing).toContainText(l.missing, { timeout: 60_000 });
  await missing.locator("[data-kb-remove]").first().click();
  await expect(missing).toHaveCount(0, { timeout: 30_000 });
  await page.locator("[data-kb-section] li").first().locator("[data-kb-unlink]").click();
  errors.check();
});
