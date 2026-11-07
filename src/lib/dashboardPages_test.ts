// The owner menu's map (back-end layout, 2026-11-03): every owner page belongs to exactly one menu item, the old
// addresses forward with their query, ?shop= stays on every shop page's link. Run with `npm run test:content`.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  menuFor,
  itemQueryFor,
  assistantTabUrl,
  bookingPartUrl,
  forwardUrl,
  crmForward,
  hoursSmsForward,
  isBareScreen,
  ITEM_TABS,
  menuHref,
  menuItemFor,
  menuOwners,
  movedFrom,
  OWNER_MENU,
  sectionUrl,
  smsTelegramTab,
  tabHref,
  telegramForwardScript,
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
    ["/dashboard/sms-telegram", "", "sms_tg"],
    ["/dashboard/hours-sms", "", "sms_tg"],
    ["/admin/domains", "", "admin"],
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
  // 2026-11-07: the cloud folder is Prehľad's last card; Konverzácie is CRM itself
  assertEquals(sectionUrl("sk", "cloud", { shop: "davide" }), "/sk/dashboard/crm?shop=davide&at=overview#cloud");
  assertEquals(sectionUrl("sk", "conversations", { shop: "davide", ok: "1" }), "/sk/dashboard/crm?shop=davide&ok=1");
});

Deno.test("the items' tabs (L2): Rezervácie's booking parts, CRM, AI asistent, Objednávky jedla; the old Asistent tabs", () => {
  assertEquals(tabHref("sk", "bookings", "rules", "davide"), "/sk/dashboard/bookings?shop=davide&tab=rules");
  assertEquals(tabHref("sk", "crm", "templates", "davide"), "/sk/dashboard/contacts?shop=davide&view=templates");
  assertEquals(tabHref("hu", "assistant", "folders", "davide"), "/hu/dashboard/assistant/folders?shop=davide");
  // update 79: the Menu tab has its own address
  assertEquals(tabHref("sk", "food", "menu", "davide"), "/sk/dashboard/assistant/orders/menu?shop=davide");
  // a booking settings part of update 63 goes back to its Rezervácie tab (the calendar and the messages to Nastavenia)
  assertEquals(bookingPartUrl("sk", "services", { shop: "davide", ok: "1" }), "/sk/dashboard/bookings?shop=davide&ok=1&tab=services&part=services#services");
  assertEquals(bookingPartUrl("sk", "calendar", { shop: "davide" }), "/sk/dashboard/bookings?shop=davide&tab=settings&part=calendar#calendar");
  assertEquals(bookingPartUrl("sk", "messages", { shop: "davide" }), "/sk/dashboard/bookings?shop=davide&tab=settings&part=messages#messages");
  // links that still name an old Asistent tab land on its new place
  // 2026-11-07: CRM opens on Konverzácie, Prehľad is ?at=overview
  assertEquals(assistantTabUrl("sk", "overview", "davide"), "/sk/dashboard/crm?shop=davide&at=overview");
  assertEquals(assistantTabUrl("sk", "conversations", "davide"), "/sk/dashboard/crm?shop=davide");
  assertEquals(assistantTabUrl("sk", "bookings", "davide"), "/sk/dashboard/bookings?shop=davide");
  assertEquals(assistantTabUrl("sk", "settings", "davide"), "/sk/dashboard/assistant?shop=davide");
  // every tab of a tabbed item is owned by that item — except Objednávky jedla's Menu, which a restaurant reaches from
  // its own "Menu" item (update 79); in the menu of a shop with stock it is Objednávky jedla's again
  for (const [item, tabs] of Object.entries(ITEM_TABS)) {
    for (const tab of tabs) {
      const href = new URL(tabHref("sk", item as keyof typeof ITEM_TABS, tab.key, "davide"), "https://x");
      const path = withoutLang(href.pathname);
      const at = href.searchParams.get("at") ?? "";
      // the tab group "smstg" is the menu item "sms_tg" (SMS a Telegram, 2026-11-07)
      const key = item === "smstg" ? "sms_tg" : item;
      const own = item === "food" && tab.key === "menu" ? "food_menu" : key;
      assertEquals(menuItemFor(path, at)?.key, own, `${item} → ${tab.key}`);
      assertEquals(menuItemFor(path, at, "goods")?.key, key, `${item} → ${tab.key} (goods)`);
    }
  }
});

Deno.test("the menu by kind of shop (update 79): a restaurant sees Menu and Objednávky jedla first, no stock-file pages", () => {
  const goods = menuFor("goods").map((m) => m.key);
  const food = menuFor("food").map((m) => m.key);
  // a shop with stock: exactly as before (without the restaurant's Menu), in the same order
  assertEquals(goods, OWNER_MENU.filter((m) => m.key !== "food_menu").map((m) => m.key));
  assertEquals(menuFor(null).map((m) => m.key), goods, "no kind = goods");
  // a restaurant: Menu and Objednávky jedla first in Hlavné, Priečinok s exportom out of the menu
  const main = menuFor("food").filter((m) => m.group === "main").map((m) => m.key);
  assertEquals(main.slice(0, 2), ["food_menu", "food"]);
  assert(!food.includes("export"), "a restaurant has no Priečinok s exportom in its menu");
  for (const key of ["sklad", "crm", "bookings", "shop", "content", "blog", "assistant", "translations", "plan", "legal"]) {
    assert(food.includes(key as never), `${key} stays in a restaurant's menu`);
  }
  assertEquals(new Set(food).size, food.length);
  // the pages stay reachable by address: /sync is still Priečinok s exportom
  assertEquals(menuItemFor("/sync", "", "food")?.key, "export");
  // "Jazyky a inventár" of a restaurant opens its page texts (Tovar is for stock files)
  const tr = OWNER_MENU.find((m) => m.key === "translations")!;
  assertEquals(itemQueryFor(tr, "food"), { at: "texts" });
  assertEquals(menuHref(tr, "sk", "bistro", "food"), "/sk/dashboard/translations?shop=bistro&at=texts");
  assertEquals(menuHref(tr, "sk", "davide", "goods"), "/sk/dashboard/translations?shop=davide");
  // the Menu tab: Menu for a restaurant, Objednávky jedla for a shop with stock
  assertEquals(menuItemFor("/dashboard/assistant/orders/menu", "", "food")?.key, "food_menu");
  assertEquals(menuItemFor("/dashboard/assistant/orders/menu", "", "goods")?.key, "food");
  assertEquals(menuItemFor("/dashboard/assistant/orders", "", "food")?.key, "food");
});

Deno.test("SMS a Telegram (2026-11-07): one item, two tabs, the old addresses forward with their query", () => {
  const item = OWNER_MENU.find((m) => m.key === "sms_tg")!;
  assertEquals(item.group, "account");
  assertEquals(item.path, "/dashboard/sms-telegram");
  assert(item.shop, "the page works on one shop");
  assert(!OWNER_MENU.some((m) => (m.key as string) === "hours_sms"), "no separate hours item any more");
  assertEquals(ITEM_TABS.smstg.map((t) => t.key), ["sms", "telegram"]);
  assertEquals(tabHref("sk", "smstg", "sms", "davide"), "/sk/dashboard/sms-telegram?shop=davide&tab=sms");
  assertEquals(tabHref("sk", "smstg", "telegram", "davide"), "/sk/dashboard/sms-telegram?shop=davide&tab=telegram");
  assertEquals(smsTelegramTab(undefined), "sms");
  assertEquals(smsTelegramTab("telegram"), "telegram");
  assertEquals(smsTelegramTab("nonsense"), "sms");
  // /dashboard/hours-sms?shop=x → /dashboard/sms-telegram?shop=x (the Google sign-in's ?ok= along)
  const hours = new URL(hoursSmsForward("sk", { shop: "x" }), "https://x");
  assertEquals(hours.pathname, "/sk/dashboard/sms-telegram");
  assertEquals(hours.searchParams.get("shop"), "x");
  assertEquals(hours.searchParams.get("tab"), "sms");
  assertEquals(hours.hash, "#hours-sms");
  const google = new URL(hoursSmsForward("hu", { shop: "x", ok: "google_connected", pick: "1", tab: "telegram" }), "https://x");
  assertEquals(google.searchParams.get("ok"), "google_connected");
  assertEquals(google.searchParams.get("pick"), "1");
  assertEquals(google.searchParams.getAll("tab"), ["sms"], "always the SMS tab");
  // /dashboard/ai#telegram → ?tab=telegram (a script: the anchor never reaches the server)
  const script = telegramForwardScript("sk");
  assert(script.startsWith("(function(){try{") && script.endsWith("}catch(e){}})();"));
  assert(script.includes('"/sk/dashboard/sms-telegram"') && script.includes('q.set("tab","telegram")') && script.includes("#telegram"));
});

Deno.test("Súkromné priečinky a MCP keeps /dashboard/ai and its item", () => {
  const item = OWNER_MENU.find((m) => m.key === "ai")!;
  assertEquals(item.path, "/dashboard/ai");
  assertEquals(menuItemFor("/dashboard/ai")?.key, "ai");
});

Deno.test("CRM (2026-11-07): Konverzácie first, Prehľad last; the old addresses forward with their query", () => {
  assertEquals(ITEM_TABS.crm.map((t) => t.key), ["conversations", "contacts", "templates", "messages", "overview"]);
  assertEquals(tabHref("sk", "crm", "conversations", "davide"), "/sk/dashboard/crm?shop=davide");
  assertEquals(tabHref("sk", "crm", "overview", "davide"), "/sk/dashboard/crm?shop=davide&at=overview");
  assertEquals(crmForward("sk", { shop: "davide", at: "conversations", cq: "ral" }), "/sk/dashboard/crm?shop=davide&cq=ral");
  assertEquals(crmForward("sk", { shop: "davide", at: "cloud", ok: "1" }), "/sk/dashboard/crm?shop=davide&ok=1&at=overview#cloud");
  assertEquals(crmForward("sk", { shop: "davide", at: "overview" }), null);
  assertEquals(crmForward("sk", { shop: "davide" }), null);
  assertEquals(menuItemFor("/dashboard/conversations/x0")?.key, "crm", "the old conversation page still belongs to CRM");
});
