// The owner menu's map (back-end layout, 2026-11-03): every owner page belongs to exactly one menu item, the old
// addresses forward with their query, ?shop= stays on every shop page's link. Run with `npm run test:content`.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  assistantTabUrl,
  bookingPartUrl,
  forwardUrl,
  isBareScreen,
  ITEM_TABS,
  menuHref,
  menuItemFor,
  menuOwners,
  movedFrom,
  OWNER_MENU,
  sectionUrl,
  tabHref,
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
    ["/dashboard/crm", "", "crm"],
    ["/dashboard/crm", "conversations", "crm"],
    ["/dashboard/contacts/x0", "", "crm"],
    ["/dashboard/conversations/x0", "", "crm"],
    ["/dashboard/assistant", "", "assistant"],
    ["/dashboard/assistant", "settings", "assistant"],
    ["/dashboard/assistant/documents", "", "assistant"],
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

Deno.test("the QR terminal has no menu; every other owner page has it (no work screens since 2026-11-04)", () => {
  assert(isBareScreen("/dashboard/sklad/terminal"));
  for (const p of ["/dashboard/sklad", "/dashboard/sklad/sale", "/dashboard/sklad/receipts/x0", "/dashboard/sklad/counts/x0", "/dashboard/assistant/orders", "/dashboard"]) {
    assert(!isBareScreen(p), p);
  }
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
  assertEquals(menuHref(OWNER_MENU.find((m) => m.key === "crm")!, "sk", "davide"), "/sk/dashboard/crm?shop=davide");
});

Deno.test("old addresses forward with every query parameter (sections that moved or were renamed)", () => {
  const old: [page: Parameters<typeof movedFrom>[0], at: string, to: string][] = [
    // back-end layout L2: Asistent's Prehľad and Konverzácie are CRM, its documents and folders two AI asistent tabs
    ["assistant", "overview", "/sk/dashboard/crm"],
    ["assistant", "conversations", "/sk/dashboard/crm"],
    ["assistant", "cloud", "/sk/dashboard/crm"],
    ["assistant", "private", "/sk/dashboard/assistant/folders"],
    ["assistant", "docs", "/sk/dashboard/assistant/documents"],
    ["folders", "docs", "/sk/dashboard/assistant/documents"],
    ["dashboard", "private", "/sk/dashboard/assistant/folders"],
    ["dashboard", "sections", "/sk/dashboard/content"],
    ["dashboard", "languages", "/sk/sync"],
    ["dashboard", "columns", "/sk/sync"],
    ["translations", "files", "/sk/sync"],
    ["translations", "translations", "/sk/dashboard/translations"],
    ["dashboard", "cloud", "/sk/dashboard/crm"],
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
  assert(!movedFrom("crm", "conversations"));
  assert(!movedFrom("folders", "folders"));
  assertEquals(sectionUrl("sk", "cloud", { shop: "davide" }), "/sk/dashboard/crm?shop=davide&at=cloud#cloud");
  assertEquals(sectionUrl("sk", "conversations", { shop: "davide" }), "/sk/dashboard/crm?shop=davide&at=conversations#conversations");
});

Deno.test("the items' tabs (L2): Rezervácie's booking parts, CRM, AI asistent, Objednávky jedla; the old Asistent tabs", () => {
  assertEquals(tabHref("sk", "bookings", "rules", "davide"), "/sk/dashboard/bookings?shop=davide&tab=rules");
  assertEquals(tabHref("sk", "crm", "templates", "davide"), "/sk/dashboard/contacts?shop=davide&view=templates");
  assertEquals(tabHref("hu", "assistant", "folders", "davide"), "/hu/dashboard/assistant/folders?shop=davide");
  assertEquals(tabHref("sk", "food", "menu", "davide"), "/sk/dashboard/assistant/orders/settings?shop=davide&view=menu");
  // a booking settings part of update 63 goes back to its Rezervácie tab (the calendar and the messages to Nastavenia)
  assertEquals(bookingPartUrl("sk", "services", { shop: "davide", ok: "1" }), "/sk/dashboard/bookings?shop=davide&ok=1&tab=services&part=services#services");
  assertEquals(bookingPartUrl("sk", "calendar", { shop: "davide" }), "/sk/dashboard/bookings?shop=davide&tab=settings&part=calendar#calendar");
  assertEquals(bookingPartUrl("sk", "messages", { shop: "davide" }), "/sk/dashboard/bookings?shop=davide&tab=settings&part=messages#messages");
  // links that still name an old Asistent tab land on its new place
  assertEquals(assistantTabUrl("sk", "overview", "davide"), "/sk/dashboard/crm?shop=davide");
  assertEquals(assistantTabUrl("sk", "conversations", "davide"), "/sk/dashboard/crm?shop=davide&at=conversations");
  assertEquals(assistantTabUrl("sk", "bookings", "davide"), "/sk/dashboard/bookings?shop=davide");
  assertEquals(assistantTabUrl("sk", "settings", "davide"), "/sk/dashboard/assistant?shop=davide");
  // every tab of a tabbed item is owned by that item
  for (const [item, tabs] of Object.entries(ITEM_TABS)) {
    for (const tab of tabs) {
      const href = new URL(tabHref("sk", item as keyof typeof ITEM_TABS, tab.key, "davide"), "https://x");
      assertEquals(menuItemFor(withoutLang(href.pathname), href.searchParams.get("at") ?? "")?.key, item, `${item} → ${tab.key}`);
    }
  }
});
