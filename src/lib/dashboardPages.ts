/**
 * Môj obchod's pages and their sections (back-end layout L2, 2026-11-03): "Môj obchod" (details, logo, plan, delete),
 * "Obsah stránky" (the slider and its library, update 38), "CRM" (/dashboard/crm: Prehľad and the conversations with
 * their cloud folder; Kontakty and Šablóny on /dashboard/contacts), "Rezervácie" (/dashboard/bookings: Kalendár, Služby,
 * Zdroje, Pravidlá, Blokované časy, Nastavenia — the booking parts of update 63's Asistent → Nastavenia), "AI asistent"
 * (/dashboard/assistant: Nastavenia; Dokumenty on /dashboard/assistant/documents; Súkromné priečinky on
 * /dashboard/assistant/folders), "Jazyky a inventár" (update 40: "Tovar" with the products' translations, update 62:
 * "Texty stránky") and "Priečinok s exportom" (the stock folder, update 45's review after an upload with the languages
 * and the columns, the translations folder, the last stock files and, update 43, the danger zone of the stock). A form
 * sends the owner back to the page and section ("at") it came from; a section that moved keeps working under its old
 * name (old links, e-mails, the cloud sign-in coming back with ?at=cloud).
 */
export const ASSISTANT_SECTIONS = ["settings"];
/** CRM (/dashboard/crm): Prehľad and the conversations with the cloud folder they are copied to. */
export const CRM_SECTIONS = ["overview", "conversations", "cloud"];
/** AI asistent → Dokumenty (/dashboard/assistant/documents): the documents and pictures the assistant answers from. */
export const DOC_SECTIONS = ["docs"];
/** AI asistent → Súkromné priečinky (/dashboard/assistant/folders): the folders and their access keys. */
export const FOLDER_SECTIONS = ["folders"];

/**
 * The tabs of a menu item, in their order (the back-end layout): plain links under the page's heading. Sklad: Prehľad ·
 * Predaj · Produkty · Príjemky · Inventúra · Pohyby · Nastavenia; Objednávky jedla: Objednávky · Menu · Nastavenia
 * ("Kuriéri" comes with the courier app); Rezervácie: Kalendár · Služby · Zdroje · Pravidlá · Blokované časy · Nastavenia;
 * CRM: Prehľad · Konverzácie · Kontakty · Šablóny · Správy; AI asistent: Nastavenia · Dokumenty · Súkromné priečinky.
 */
export interface ItemTab {
  key: string;
  path: string;
  query?: Record<string, string>;
}
export const ITEM_TABS = {
  sklad: [
    { key: "overview", path: "/dashboard/sklad" },
    { key: "sale", path: "/dashboard/sklad/sale" },
    { key: "products", path: "/dashboard/sklad/products" },
    { key: "receipts", path: "/dashboard/sklad/receipts" },
    { key: "counts", path: "/dashboard/sklad/counts" },
    { key: "movements", path: "/dashboard/sklad/movements" },
    { key: "settings", path: "/dashboard/sklad/settings" },
  ],
  food: [
    { key: "orders", path: "/dashboard/assistant/orders" },
    // update 75 (couriers): Objednávky · Kuriéri · Menu · Nastavenia, as the canvas
    { key: "couriers", path: "/dashboard/assistant/orders/couriers" },
    // update 79: the Menu tab has its own address (owned by the "Menu" item food_menu, which restaurants see in Hlavné)
    { key: "menu", path: "/dashboard/assistant/orders/menu" },
    { key: "settings", path: "/dashboard/assistant/orders/settings" },
  ],
  bookings: [
    { key: "calendar", path: "/dashboard/bookings" },
    { key: "services", path: "/dashboard/bookings", query: { tab: "services" } },
    { key: "resources", path: "/dashboard/bookings", query: { tab: "resources" } },
    { key: "rules", path: "/dashboard/bookings", query: { tab: "rules" } },
    { key: "blocks", path: "/dashboard/bookings", query: { tab: "blocks" } },
    { key: "settings", path: "/dashboard/bookings", query: { tab: "settings" } },
  ],
  crm: [
    { key: "overview", path: "/dashboard/crm" },
    { key: "conversations", path: "/dashboard/crm", query: { at: "conversations" } },
    { key: "contacts", path: "/dashboard/contacts" },
    { key: "templates", path: "/dashboard/contacts", query: { view: "templates" } },
    // 2026-11-04: one place to write to any contact (recipient search, the composer, every sent message)
    { key: "messages", path: "/dashboard/crm/messages" },
  ],
  assistant: [
    { key: "settings", path: "/dashboard/assistant" },
    { key: "documents", path: "/dashboard/assistant/documents" },
    { key: "folders", path: "/dashboard/assistant/folders" },
  ],
} satisfies Record<string, ItemTab[]>;
export type TabbedItem = keyof typeof ITEM_TABS;

/** A tab's link with the open shop: "/sk/dashboard/bookings?shop=davide&tab=rules". */
export function tabHref(lang: string, item: TabbedItem, key: string, shop: string, extra: Record<string, string> = {}): string {
  const tab: ItemTab = ITEM_TABS[item].find((x) => x.key === key) ?? ITEM_TABS[item][0];
  return `/${lang}${tab.path}?${new URLSearchParams({ shop, ...(tab.query ?? {}), ...extra })}`;
}

/** Rezervácie's tabs that hold update 63's booking settings, by the old Nastavenia part's name. */
export const BOOKING_TAB_OF_PART: Record<string, string> = {
  services: "services",
  resources: "resources",
  rules: "rules",
  blocks: "blocks",
  calendar: "settings",
  messages: "settings",
};

/** Where a booking settings form goes back to: its Rezervácie tab with the message and the part's anchor. */
export function bookingPartUrl(lang: string, part: string, query: Record<string, string>): string {
  const tab = BOOKING_TAB_OF_PART[part] ?? "settings";
  return `/${lang}/dashboard/bookings?${new URLSearchParams({ ...query, tab, part })}#${part}`;
}

/**
 * The old Asistent tabs (update 63) by name, now on their menu items' pages: "/sk/dashboard/contacts?shop=davide&view=templates".
 * Kept for the links that name a tab (Prehľad's numbers, old forms).
 */
export const ASSISTANT_TABS = ["overview", "orders", "conversations", "contacts", "bookings", "templates", "settings"] as const;
export type AssistantTab = (typeof ASSISTANT_TABS)[number];
export function assistantTabUrl(lang: string, tab: AssistantTab, shop: string, extra: Record<string, string> = {}): string {
  if (tab === "overview" || tab === "conversations" || tab === "contacts" || tab === "templates") return tabHref(lang, "crm", tab, shop, extra);
  if (tab === "bookings") return tabHref(lang, "bookings", "calendar", shop, extra);
  if (tab === "orders") return tabHref(lang, "food", "orders", shop, extra);
  return tabHref(lang, "assistant", "settings", shop, extra);
}
/**
 * "Priečinok s exportom": the stock folder, "Po nahratí súboru" (update 45: the review card, the languages and the
 * stock file's columns), "Preklady v priečinku" (update 45: the translations folder and the stock files in other
 * languages), "Posledné nahrané súbory" (back here since update 43) and "Nebezpečná zóna – sklad".
 */
export const EXPORT_SECTIONS = ["source", "api", "pos", "export", "review", "trfolder", "imports", "conversations-pc", "danger", "ignored"];
export const CONTENT_SECTIONS = ["content", "library", "sections"];
/**
 * "Jazyky a inventár" (update 40): "Tovar" = the products and every translation of them, "Texty stránky" = the
 * page's other texts in every language (update 62; it was "Preklady", which also listed the products). Languages,
 * columns and files moved to "Priečinok s exportom" in update 45.
 */
export const TRANSLATION_SECTIONS = ["items", "texts"];

/** Old names of sections that were merged into another one (the anchor and the open dropdown follow). */
const MERGED: Record<string, string> = {
  // back-end layout L2: "Súkromné priečinky" are their own tab of AI asistent
  private: "folders",
  // update 63: the assistant's own settings are one tab "Nastavenia" with the reminders and the bookings' setup
  assistant: "settings",
  sections: "content",
  languages: "review",
  columns: "review",
  files: "trfolder",
  translations: "texts",
};

/** The section a name stands for now ("private" → "docs"; "cloud" is a part of "conversations" with its own anchor). */
export function sectionId(at: string): string {
  return MERGED[at] ?? at;
}

export function sectionPath(lang: string, name: string): string {
  const at = sectionId(name);
  if (ASSISTANT_SECTIONS.includes(at)) return `/${lang}/dashboard/assistant`;
  if (CRM_SECTIONS.includes(at)) return `/${lang}/dashboard/crm`;
  if (DOC_SECTIONS.includes(at)) return `/${lang}/dashboard/assistant/documents`;
  if (FOLDER_SECTIONS.includes(at)) return `/${lang}/dashboard/assistant/folders`;
  if (EXPORT_SECTIONS.includes(at)) return `/${lang}/sync`;
  if (CONTENT_SECTIONS.includes(at)) return `/${lang}/dashboard/content`;
  if (TRANSLATION_SECTIONS.includes(at)) return `/${lang}/dashboard/translations`;
  return `/${lang}/dashboard`;
}

/** The page of a section with its query and anchor: "/sk/dashboard/assistant?shop=x&at=cloud#cloud". */
export function sectionUrl(lang: string, at: string, query: Record<string, string>): string {
  const id = sectionId(at);
  const params = new URLSearchParams({ ...query, ...(id ? { at: id } : {}) });
  return `${sectionPath(lang, at)}?${params}${id ? `#${id}` : ""}`;
}

const PAGE_SECTIONS: Record<"dashboard" | "sync" | "assistant" | "crm" | "documents" | "folders" | "content" | "translations", string[]> = {
  dashboard: [],
  sync: EXPORT_SECTIONS,
  assistant: ASSISTANT_SECTIONS,
  crm: CRM_SECTIONS,
  documents: DOC_SECTIONS,
  folders: FOLDER_SECTIONS,
  content: CONTENT_SECTIONS,
  translations: TRANSLATION_SECTIONS,
};

/** Whether an address asks a page for a section that is elsewhere now, or by its old name (then it is forwarded). */
export function movedFrom(page: keyof typeof PAGE_SECTIONS, at: string): boolean {
  if (!at) return false;
  if (MERGED[at]) return true;
  return [...ASSISTANT_SECTIONS, ...CRM_SECTIONS, ...DOC_SECTIONS, ...FOLDER_SECTIONS, ...EXPORT_SECTIONS, ...CONTENT_SECTIONS, ...TRANSLATION_SECTIONS].includes(at) &&
    !PAGE_SECTIONS[page].includes(at);
}

/** The same address on the section's page now (every query parameter kept, `at` and the anchor renamed). */
export function forwardUrl(lang: string, at: string, sp: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const one of [v].flat()) if (typeof one === "string") query.append(k, k === "at" ? sectionId(one) : one);
  }
  return `${sectionPath(lang, at)}?${query}#${sectionId(at)}`;
}

// ---------------------------------------------------------------- the owner menu (back-end layout, 2026-11-03)
//
// One map for the whole login-only area: every owner address belongs to exactly one menu item, the item to one group,
// and an address says whether the page is a work screen (the compact rail even on a wide screen) or has no menu at all
// (the QR terminal). The menu (@/components/owner/OwnerNav), the forwards above and dashboardPages_test.ts read it.

export type MenuGroup = "main" | "page" | "account";
/** The kind of shop (update 79): a shop with stock or a restaurant; the menu shows what each one uses. */
export type ShopKind = "goods" | "food";
export const SHOP_KINDS: ShopKind[] = ["goods", "food"];
export type MenuKey =
  | "food_menu"
  | "sklad"
  | "food"
  | "bookings"
  | "crm"
  | "pomocnik"
  | "shop"
  | "content"
  | "blog"
  | "assistant"
  | "translations"
  | "export"
  | "plan"
  | "legal"
  | "password"
  | "hours_sms"
  | "ai"
  | "admin";

/** An address an item owns, after "/<lang>": the page and everything under it, or (`exact`) only the page; `at` = only
 * with one of these ?at= values (no `at` given = any, "" = none). */
export interface MenuRoute {
  path: string;
  exact?: boolean;
  at?: string[];
}

export interface MenuItem {
  key: MenuKey;
  group: MenuGroup;
  /** The item's own page after "/<lang>", with the query it opens with. */
  path: string;
  query?: Record<string, string>;
  owns: MenuRoute[];
  /** The page works on one shop: its link keeps ?shop=. */
  shop: boolean;
  admin?: boolean;
  /** Which count the item's badge shows. */
  badge?: "food" | "crm";
  /** Only for these kinds of shop (update 79); none = every shop. */
  kinds?: ShopKind[];
}

export const OWNER_MENU: MenuItem[] = [
  // update 79: a restaurant's menu (dishes, prices, categories) — the Menu tab of Objednávky jedla
  { key: "food_menu", group: "main", path: "/dashboard/assistant/orders/menu", owns: [{ path: "/dashboard/assistant/orders/menu" }], shop: true, kinds: ["food"] },
  { key: "sklad", group: "main", path: "/dashboard/sklad", owns: [{ path: "/dashboard/sklad" }], shop: true },
  { key: "food", group: "main", path: "/dashboard/assistant/orders", owns: [{ path: "/dashboard/assistant/orders" }], shop: true, badge: "food" },
  { key: "bookings", group: "main", path: "/dashboard/bookings", owns: [{ path: "/dashboard/bookings" }], shop: true },
  {
    key: "crm",
    group: "main",
    path: "/dashboard/crm",
    owns: [{ path: "/dashboard/crm" }, { path: "/dashboard/contacts" }, { path: "/dashboard/conversations" }],
    shop: true,
    badge: "crm",
  },
  // 2026-11-04: the AI pomocník — on a computer a switch in the menu (a panel on the right), on a phone its own page
  { key: "pomocnik", group: "main", path: "/dashboard/pomocnik", owns: [{ path: "/dashboard/pomocnik" }], shop: true },
  { key: "shop", group: "page", path: "/dashboard", owns: [{ path: "/dashboard", exact: true }], shop: true },
  { key: "content", group: "page", path: "/dashboard/content", owns: [{ path: "/dashboard/content" }, { path: "/dashboard/sections" }], shop: true },
  { key: "blog", group: "page", path: "/dashboard/blog", owns: [{ path: "/dashboard/blog" }], shop: true },
  { key: "assistant", group: "page", path: "/dashboard/assistant", owns: [{ path: "/dashboard/assistant" }], shop: true },
  { key: "translations", group: "page", path: "/dashboard/translations", owns: [{ path: "/dashboard/translations" }, { path: "/dashboard/items" }], shop: true },
  // the stock file's folder, Zdroj zásob, the inventory program, the POS agent: not for a restaurant (update 79)
  { key: "export", group: "account", path: "/sync", owns: [{ path: "/sync" }], shop: true, kinds: ["goods"] },
  { key: "plan", group: "account", path: "/dashboard/plan", owns: [{ path: "/dashboard/plan" }], shop: true },
  { key: "legal", group: "account", path: "/dashboard/legal", owns: [{ path: "/dashboard/legal" }], shop: true },
  { key: "password", group: "account", path: "/password", owns: [{ path: "/password" }], shop: false },
  { key: "hours_sms", group: "account", path: "/dashboard/hours-sms", owns: [{ path: "/dashboard/hours-sms" }], shop: true },
  { key: "ai", group: "account", path: "/dashboard/ai", owns: [{ path: "/dashboard/ai" }], shop: false },
  // the admin area (2026-11-05): its own shell and menu (@/lib/adminPages); here only the way in, for is_admin
  { key: "admin", group: "account", path: "/admin", owns: [{ path: "/admin" }], shop: false, admin: true },
];

export const MENU_GROUPS: MenuGroup[] = ["main", "page", "account"];

/** Hlavné of a restaurant starts with these (update 79); every other item keeps its place. */
const FOOD_FIRST: MenuKey[] = ["food_menu", "food"];

/**
 * The menu of one kind of shop (update 79): goods = OWNER_MENU as before (without the restaurant's Menu); food = Menu
 * and Objednávky jedla first in Hlavné, no stock-file pages (Priečinok s exportom). The pages themselves stay reachable
 * by their address.
 */
export function menuFor(kind: ShopKind | null | undefined): MenuItem[] {
  const k: ShopKind = kind === "food" ? "food" : "goods";
  const items = OWNER_MENU.filter((m) => !m.kinds || m.kinds.includes(k));
  if (k !== "food") return items;
  const first = FOOD_FIRST.flatMap((key) => items.filter((m) => m.key === key));
  return [...first, ...items.filter((m) => !FOOD_FIRST.includes(m.key))];
}

/** The link of "Jazyky a inventár" for a restaurant: its page texts first (the Tovar list is for stock files). */
export function itemQueryFor(item: MenuItem, kind: ShopKind | null | undefined): Record<string, string> | undefined {
  if (kind === "food" && item.key === "translations") return { at: "texts" };
  return item.query;
}

/** "/sk/dashboard/sklad/sale" → "/dashboard/sklad/sale" (the address without its language). */
export function withoutLang(pathname: string): string {
  const rest = pathname.replace(/^\/[a-z]{2,3}(?:-[a-z]{2,4})?(?=\/|$)/i, "");
  return rest === "" ? "/" : rest.replace(/\/+$/, "") || "/";
}

function routeScore(route: MenuRoute, path: string, at: string): number {
  const inside = route.exact ? path === route.path : path === route.path || path.startsWith(`${route.path}/`);
  if (!inside) return -1;
  if (route.at && !route.at.includes(at)) return -1;
  // the longer address wins; an exact page or an ?at= rule wins over a page that owns everything under it
  return route.path.length * 4 + (route.exact ? 2 : 0) + (route.at ? 1 : 0);
}

/** Every item that owns the address, the most specific first (the first one is the address's item). */
export function menuOwners(path: string, at = ""): { item: MenuItem; score: number }[] {
  return OWNER_MENU.flatMap((item) => {
    const score = Math.max(...item.owns.map((r) => routeScore(r, path, at)));
    return score < 0 ? [] : [{ item, score }];
  }).sort((a, b) => b.score - a.score);
}

/**
 * The menu item an address belongs to ("/dashboard/sklad/sale" → Sklad); null outside the owner area. With a kind of
 * shop: the most specific item that kind's menu shows (a shop with stock on the Menu tab → Objednávky jedla).
 */
export function menuItemFor(path: string, at = "", kind?: ShopKind | null): MenuItem | null {
  const owners = menuOwners(path, at);
  if (kind) {
    const shown = new Set(menuFor(kind).map((m) => m.key));
    const visible = owners.find((o) => shown.has(o.item.key));
    if (visible) return visible.item;
  }
  return owners[0]?.item ?? null;
}

/** An item's link: its page with its query and, for a shop page, the open shop (a restaurant's own query, update 79). */
export function menuHref(item: MenuItem, lang: string, shop: string | null, kind?: ShopKind | null): string {
  const query = new URLSearchParams({ ...(item.shop && shop ? { shop } : {}), ...(itemQueryFor(item, kind) ?? {}) });
  const q = query.toString();
  return `/${lang}${item.path}${q ? `?${q}` : ""}`;
}

/**
 * No menu at all: the QR terminal faces the customer. (Every other owner page has the same menu, open by default;
 * since 2026-11-04 Predaj, the Príjemka editor, Inventúra counting and the food board no longer switch to the rail.)
 */
const BARE_SCREENS = [/^\/dashboard\/sklad\/terminal$/];

export function isBareScreen(path: string): boolean {
  return BARE_SCREENS.some((r) => r.test(path));
}
