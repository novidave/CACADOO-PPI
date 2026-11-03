/**
 * Môj obchod's pages: "Môj obchod" (details, logo, plan, delete), "Obsah stránky" (the shop page's slider and its
 * library of files, database update 38), "Asistent" (update 63: Prehľad, the conversations with their cloud folder,
 * Nastavenia; Kontakty, Rezervácie and Šablóny are tabs on their own pages; the private folders on
 * /dashboard/assistant/folders), "Jazyky a inventár" (update 40: "Tovar" with the products' translations, update 62: "Texty stránky") and "Priečinok s exportom" (the
 * stock folder, update 45's review after an upload with the languages and the columns, the translations folder, the
 * last stock files and, update 43, the danger zone of the stock). A form
 * sends the owner back to the page and section ("at") it came from; a section that moved keeps working under its
 * old name (old links, e-mails, the cloud sign-in coming back with ?at=cloud).
 */
export const ASSISTANT_SECTIONS = ["overview", "conversations", "cloud", "settings"];
/** Update 63: "Súkromné priečinky" have their own page under Asistent (/dashboard/assistant/folders). */
export const FOLDER_SECTIONS = ["docs"];

/**
 * Update 63: the Asistent tabs as on the approved screens — Prehľad · Konverzácie · Kontakty · Rezervácie · Šablóny ·
 * Nastavenia. Kontakty and Rezervácie keep their own pages (and their addresses); the row is the same on all of them.
 * Update 74: "Objednávky" (/dashboard/assistant/orders) after Prehľad, shown only while food ordering is on.
 */
export const ASSISTANT_TABS = ["overview", "orders", "conversations", "contacts", "bookings", "templates", "settings"] as const;
export type AssistantTab = (typeof ASSISTANT_TABS)[number];

/** Where a tab lives: "/sk/dashboard/contacts?shop=davide&view=templates". */
export function assistantTabUrl(lang: string, tab: AssistantTab, shop: string, extra: Record<string, string> = {}): string {
  const q = (more: Record<string, string>) => `?${new URLSearchParams({ shop, ...more, ...extra })}`;
  if (tab === "contacts") return `/${lang}/dashboard/contacts${q({})}`;
  if (tab === "templates") return `/${lang}/dashboard/contacts${q({ view: "templates" })}`;
  if (tab === "bookings") return `/${lang}/dashboard/bookings${q({})}`;
  if (tab === "orders") return `/${lang}/dashboard/assistant/orders${q({})}`;
  if (tab === "overview") return `/${lang}/dashboard/assistant${q({})}`;
  return `/${lang}/dashboard/assistant${q({ at: tab })}`;
}
/**
 * "Priečinok s exportom": the stock folder, "Po nahratí súboru" (update 45: the review card, the languages and the
 * stock file's columns), "Preklady v priečinku" (update 45: the translations folder and the stock files in other
 * languages), "Posledné nahrané súbory" (back here since update 43) and "Nebezpečná zóna – sklad".
 */
export const EXPORT_SECTIONS = ["source", "api", "pos", "export", "review", "trfolder", "imports", "conversations-pc", "danger"];
export const CONTENT_SECTIONS = ["content", "library", "sections"];
/**
 * "Jazyky a inventár" (update 40): "Tovar" = the products and every translation of them, "Texty stránky" = the
 * page's other texts in every language (update 62; it was "Preklady", which also listed the products). Languages,
 * columns and files moved to "Priečinok s exportom" in update 45.
 */
export const TRANSLATION_SECTIONS = ["items", "texts"];

/** Old names of sections that were merged into another one (the anchor and the open dropdown follow). */
const MERGED: Record<string, string> = {
  private: "docs",
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

const PAGE_SECTIONS: Record<"dashboard" | "sync" | "assistant" | "folders" | "content" | "translations", string[]> = {
  dashboard: [],
  sync: EXPORT_SECTIONS,
  assistant: ASSISTANT_SECTIONS,
  folders: FOLDER_SECTIONS,
  content: CONTENT_SECTIONS,
  translations: TRANSLATION_SECTIONS,
};

/** Whether an address asks a page for a section that is elsewhere now, or by its old name (then it is forwarded). */
export function movedFrom(page: keyof typeof PAGE_SECTIONS, at: string): boolean {
  if (!at) return false;
  if (MERGED[at]) return true;
  return [...ASSISTANT_SECTIONS, ...FOLDER_SECTIONS, ...EXPORT_SECTIONS, ...CONTENT_SECTIONS, ...TRANSLATION_SECTIONS].includes(at) &&
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
export type MenuKey =
  | "sklad"
  | "food"
  | "bookings"
  | "crm"
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
  | "admin_domains"
  | "admin_translations";

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
}

/** The Asistent page's own sections that belong to CRM (its Prehľad and the conversations with their cloud folder). */
const CRM_AT = ["", "overview", "conversations", "cloud"];

export const OWNER_MENU: MenuItem[] = [
  { key: "sklad", group: "main", path: "/dashboard/sklad", owns: [{ path: "/dashboard/sklad" }], shop: true },
  { key: "food", group: "main", path: "/dashboard/assistant/orders", owns: [{ path: "/dashboard/assistant/orders" }], shop: true, badge: "food" },
  { key: "bookings", group: "main", path: "/dashboard/bookings", owns: [{ path: "/dashboard/bookings" }], shop: true },
  {
    key: "crm",
    group: "main",
    path: "/dashboard/assistant",
    owns: [{ path: "/dashboard/contacts" }, { path: "/dashboard/conversations" }, { path: "/dashboard/assistant", exact: true, at: CRM_AT }],
    shop: true,
    badge: "crm",
  },
  { key: "shop", group: "page", path: "/dashboard", owns: [{ path: "/dashboard", exact: true }], shop: true },
  { key: "content", group: "page", path: "/dashboard/content", owns: [{ path: "/dashboard/content" }, { path: "/dashboard/sections" }], shop: true },
  { key: "blog", group: "page", path: "/dashboard/blog", owns: [{ path: "/dashboard/blog" }], shop: true },
  {
    key: "assistant",
    group: "page",
    path: "/dashboard/assistant",
    query: { at: "settings" },
    owns: [{ path: "/dashboard/assistant/folders" }, { path: "/dashboard/assistant", exact: true }],
    shop: true,
  },
  { key: "translations", group: "page", path: "/dashboard/translations", owns: [{ path: "/dashboard/translations" }, { path: "/dashboard/items" }], shop: true },
  { key: "export", group: "account", path: "/sync", owns: [{ path: "/sync" }], shop: true },
  { key: "plan", group: "account", path: "/dashboard/plan", owns: [{ path: "/dashboard/plan" }], shop: true },
  { key: "legal", group: "account", path: "/dashboard/legal", owns: [{ path: "/dashboard/legal" }], shop: true },
  { key: "password", group: "account", path: "/password", owns: [{ path: "/password" }], shop: false },
  { key: "hours_sms", group: "account", path: "/dashboard/hours-sms", owns: [{ path: "/dashboard/hours-sms" }], shop: true },
  { key: "ai", group: "account", path: "/dashboard/ai", owns: [{ path: "/dashboard/ai" }], shop: false },
  { key: "admin_domains", group: "account", path: "/admin/domains", owns: [{ path: "/admin/domains" }], shop: false, admin: true },
  { key: "admin_translations", group: "account", path: "/admin/translations", owns: [{ path: "/admin/translations" }], shop: false, admin: true },
];

export const MENU_GROUPS: MenuGroup[] = ["main", "page", "account"];

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

/** The menu item an address belongs to ("/dashboard/sklad/sale" → Sklad); null outside the owner area. */
export function menuItemFor(path: string, at = ""): MenuItem | null {
  return menuOwners(path, at)[0]?.item ?? null;
}

/** An item's link: its page with its query and, for a shop page, the open shop. */
export function menuHref(item: MenuItem, lang: string, shop: string | null): string {
  const query = new URLSearchParams({ ...(item.shop && shop ? { shop } : {}), ...(item.query ?? {}) });
  const q = query.toString();
  return `/${lang}${item.path}${q ? `?${q}` : ""}`;
}

/**
 * Work screens: the compact rail even on a wide screen, so the work gets the room — Sklad's Predaj (and its QR payment
 * page), the Príjemka editor, the Inventúra counting screen and the food orders' kitchen board.
 */
const WORK_SCREENS = [/^\/dashboard\/sklad\/sale(\/[^/]+)?$/, /^\/dashboard\/sklad\/receipts\/[^/]+$/, /^\/dashboard\/sklad\/counts\/[^/]+$/, /^\/dashboard\/assistant\/orders$/];
/** No menu at all: the QR terminal faces the customer. */
const BARE_SCREENS = [/^\/dashboard\/sklad\/terminal$/];

export function isWorkScreen(path: string): boolean {
  return WORK_SCREENS.some((r) => r.test(path));
}
export function isBareScreen(path: string): boolean {
  return BARE_SCREENS.some((r) => r.test(path));
}
