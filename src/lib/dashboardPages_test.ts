// The owner menu's map (back-end layout, 2026-11-03): every owner page belongs to exactly one menu item, the old
// addresses forward with their query, ?shop= stays on every shop page's link. Run with `npm run test:content`.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  forwardUrl,
  isBareScreen,
  isWorkScreen,
  menuHref,
  menuItemFor,
  menuOwners,
  movedFrom,
  OWNER_MENU,
  sectionUrl,
  withoutLang,
} from "./dashboardPages.ts";

const ROOT = new URL("../app/[lang]/(account)/", import.meta.url);

/** Every page.tsx of the owner area as an address after "/<lang>" ("[id]" → a made-up id). */
async function ownerRoutes(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: URL, parts: string[]) {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) await walk(new URL(`${encodeURIComponent(e.name)}/`, dir), [...parts, e.name]);
      else if (e.name === "page.tsx") {
        out.push(`/${parts.map((p) => (p.startsWith("[") ? "x0" : p)).join("/")}`.replace(/\/$/, "") || "/");
      }
    }
  }
  await walk(ROOT, []);
  return out.sort();
}

Deno.test("every owner page belongs to exactly one menu item", async () => {
  const routes = await ownerRoutes();
  assert(routes.length > 30, `found ${routes.length} pages`);
  for (const route of routes) {
    const owners = menuOwners(route);
    assert(owners.length > 0, `${route} belongs to no menu item`);
    // the most specific owner is alone at its level: no two items claim the same address
    if (owners.length > 1) assert(owners[0].score > owners[1].score, `${route} is claimed by ${owners[0].item.key} and ${owners[1].item.key}`);
  }
});

Deno.test("each item owns its own page, and the keys are unique", () => {
  assertEquals(new Set(OWNER_MENU.map((m) => m.key)).size, OWNER_MENU.length);
  for (const m of OWNER_MENU) assertEquals(menuItemFor(m.path, m.query?.at ?? "")?.key, m.key, m.path);
});

Deno.test("addresses to items (Hlavné, Stránka obchodu, Účet a nastavenia)", () => {
  const cases: [string, string, string][] = [
    ["/dashboard/sklad", "", "sklad"],
    ["/dashboard/sklad/sale/x0", "", "sklad"],
    ["/dashboard/sklad/terminal", "", "sklad"],
    ["/dashboard/assistant/orders", "", "food"],
    ["/dashboard/assistant/orders/x0", "", "food"],
    ["/dashboard/bookings", "", "bookings"],
    ["/dashboard/contacts/x0", "", "crm"],
    ["/dashboard/conversations/x0", "", "crm"],
    ["/dashboard/assistant", "", "crm"],
    ["/dashboard/assistant", "conversations", "crm"],
    ["/dashboard/assistant", "cloud", "crm"],
    ["/dashboard/assistant", "settings", "assistant"],
    ["/dashboard/assistant/folders", "", "assistant"],
    ["/dashboard", "", "shop"],
    ["/dashboard/sections/x0", "", "content"],
    ["/dashboard/items/x0", "", "translations"],
    ["/sync", "", "export"],
    ["/dashboard/legal", "", "legal"],
    ["/password", "", "password"],
    ["/dashboard/ai", "", "ai"],
    ["/admin/domains", "", "admin_domains"],
  ];
  for (const [path, at, key] of cases) assertEquals(menuItemFor(path, at)?.key, key, `${path}?at=${at}`);
  assertEquals(menuItemFor("/shops/x0"), null);
  assertEquals(menuItemFor("/login"), null);
});

Deno.test("work screens use the rail, the QR terminal has no menu", () => {
  for (const p of ["/dashboard/sklad/sale", "/dashboard/sklad/sale/x0", "/dashboard/sklad/receipts/new", "/dashboard/sklad/receipts/x0", "/dashboard/sklad/counts/x0", "/dashboard/assistant/orders"]) {
    assert(isWorkScreen(p), p);
  }
  for (const p of ["/dashboard/sklad", "/dashboard/sklad/receipts", "/dashboard/sklad/counts", "/dashboard/sklad/counts/x0/diff", "/dashboard/assistant/orders/x0", "/dashboard"]) {
    assert(!isWorkScreen(p), p);
  }
  assert(isBareScreen("/dashboard/sklad/terminal"));
  assert(!isBareScreen("/dashboard/sklad"));
});

Deno.test("the language is cut off the address", () => {
  assertEquals(withoutLang("/sk/dashboard/sklad"), "/dashboard/sklad");
  assertEquals(withoutLang("/zh-hans/dashboard"), "/dashboard");
  assertEquals(withoutLang("/sr-cyrl/sync/"), "/sync");
  assertEquals(withoutLang("/hu"), "/");
});

Deno.test("?shop= stays on every shop page's link, never on the account's own pages", () => {
  for (const m of OWNER_MENU) {
    const href = menuHref(m, "sk", "davide");
    assert(href.startsWith(`/sk${m.path}`), href);
    assertEquals(new URL(href, "https://x").searchParams.get("shop"), m.shop ? "davide" : null, `${m.key}: ${href}`);
    // without a shop in the address nothing is added
    assertEquals(new URL(menuHref(m, "sk", null), "https://x").searchParams.get("shop"), null);
  }
  assertEquals(menuHref(OWNER_MENU.find((m) => m.key === "assistant")!, "sk", "davide"), "/sk/dashboard/assistant?shop=davide&at=settings");
});

Deno.test("old addresses forward with every query parameter (sections that moved or were renamed)", () => {
  const old: [page: Parameters<typeof movedFrom>[0], at: string, to: string][] = [
    ["dashboard", "private", "/sk/dashboard/assistant/folders"],
    ["assistant", "docs", "/sk/dashboard/assistant/folders"],
    ["dashboard", "sections", "/sk/dashboard/content"],
    ["dashboard", "languages", "/sk/sync"],
    ["dashboard", "columns", "/sk/sync"],
    ["translations", "files", "/sk/sync"],
    ["translations", "translations", "/sk/dashboard/translations"],
    ["dashboard", "cloud", "/sk/dashboard/assistant"],
    ["dashboard", "imports", "/sk/sync"],
    ["assistant", "assistant", "/sk/dashboard/assistant"],
  ];
  for (const [page, at, to] of old) {
    assert(movedFrom(page, at), `${page} ?at=${at} is forwarded`);
    const url = new URL(forwardUrl("sk", at, { shop: "davide", at, ok: "1" }), "https://x");
    assertEquals(url.pathname, new URL(to, "https://x").pathname, `${page} ?at=${at}`);
    assertEquals(url.searchParams.get("shop"), "davide");
    assertEquals(url.searchParams.get("ok"), "1");
  }
  // a section on its own page is not forwarded
  assert(!movedFrom("sync", "export"));
  assert(!movedFrom("assistant", "conversations"));
  assertEquals(sectionUrl("sk", "cloud", { shop: "davide" }), "/sk/dashboard/assistant?shop=davide&at=cloud#cloud");
});
