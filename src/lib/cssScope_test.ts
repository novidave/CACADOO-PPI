// The shop page's stylesheets never reach the owner's or the admin's pages by a shared class name (2026-11-05).
// shopPage.css and unified.css are loaded by public pages and by a few owner previews (the Menu editor draws the public
// Menu); after a client-side navigation their rules stay on the page, so a class the owner shell also uses would be
// restyled — the owner tab row once turned into the shop page's grey two-column "Produkty / Zoznam" box. Every class
// name of those two files is the public page's alone. Run with `npm run test:content`.
import { assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("../", import.meta.url);

async function classesOf(path: string): Promise<Set<string>> {
  const css = await Deno.readTextFile(new URL(path, ROOT));
  return new Set([...css.matchAll(/\.(ppi-[a-z0-9-]+)/g)].map((m) => m[1]));
}

async function* files(dir: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(dir)) {
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) yield* files(url);
    else if (/\.(tsx?|css)$/.test(entry.name)) yield url;
  }
}

Deno.test("no owner or admin page uses a class name of the shop page's stylesheets", async () => {
  const shop = new Set([...(await classesOf("components/shopPage.css")), ...(await classesOf("components/unified.css"))]);
  const dirs = ["app/[lang]/(account)/", "app/[lang]/(admin)/", "components/owner/", "components/admin/"];
  const clashes: string[] = [];
  for (const dir of dirs) {
    for await (const file of files(new URL(dir, ROOT))) {
      const text = await Deno.readTextFile(file);
      for (const m of text.matchAll(/(?<![\w-])(ppi-[a-z0-9-]+)(?![\w-])/g)) {
        if (shop.has(m[1])) clashes.push(`${file.pathname.split("/src/")[1]}: ${m[1]}`);
      }
    }
  }
  assertEquals(clashes, [], "rename these: the shop page's stylesheet would restyle them");
});

Deno.test("the owner tab row has its own class, and globals.css hides only its scrollbar", async () => {
  const head = await Deno.readTextFile(new URL("components/owner/PageHead.tsx", ROOT));
  const globals = await Deno.readTextFile(new URL("app/globals.css", ROOT));
  assertEquals(/className="ppi-item-tabs /.test(head), true);
  assertEquals(/^\.ppi-tabs\b/m.test(globals), false, "globals.css must not style the shop page's .ppi-tabs");
});
