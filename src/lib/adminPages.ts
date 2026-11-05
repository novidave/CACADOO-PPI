/**
 * The admin area's one map (2026-11-05, canvas "Cacaduu – Admin", artboards 1–14): every admin page — its route, its
 * menu item and group, the sections it holds (each section lives on exactly one page), the query its forms keep — and
 * where every admin form returns to (`adminBack`: its own page, ?ok= / ?err=, #section). Also the old addresses: the
 * long /admin/domains page's anchors and filters, /admin/translations' limits. No imports (Deno tests:
 * `adminPages_test.ts` in `npm run test:content`).
 */

export type AdminGroup = "ops" | "settings" | "data";

export type AdminKey =
  | "home"
  | "shops"
  | "errors"
  | "domains"
  | "limits"
  | "sms"
  | "integrations"
  | "translations"
  | "search"
  | "partners"
  | "inventory"
  | "holidays";

export interface AdminPage {
  key: AdminKey;
  group: AdminGroup;
  /** The page after "/<lang>". */
  path: string;
  /** The ids of the sections on this page (each id on exactly one page). */
  sections: readonly string[];
  /** Sections whose id starts with one of these (a partner's own card, one interface text). */
  prefixes?: readonly string[];
  /** The query its forms carry back (filters, the chosen country and year). */
  keeps?: readonly string[];
  /** The count its menu item shows. */
  badge?: "shops" | "errors";
}

export const ADMIN_GROUPS: readonly AdminGroup[] = ["ops", "settings", "data"];

export const ADMIN_PAGES: readonly AdminPage[] = [
  // Prevádzka
  { key: "home", group: "ops", path: "/admin", sections: ["overview"] },
  { key: "shops", group: "ops", path: "/admin/shops", sections: ["credit", "shops"], keeps: ["q", "status", "kind"], badge: "shops" },
  { key: "errors", group: "ops", path: "/admin/errors", sections: ["errors"], badge: "errors" },
  // Nastavenia
  { key: "domains", group: "settings", path: "/admin/domains", sections: ["settings", "prices"] },
  {
    key: "limits",
    group: "settings",
    path: "/admin/limits",
    sections: ["section-limits", "blog-limits", "translation-limits", "inventory-limits", "sklad-limits", "pro-only"],
  },
  { key: "sms", group: "settings", path: "/admin/sms", sections: ["sms"] },
  { key: "integrations", group: "settings", path: "/admin/integrations", sections: ["telegram", "owner-ai", "facebook"] },
  {
    key: "translations",
    group: "settings",
    path: "/admin/translations",
    sections: ["languages", "ui", "usage"],
    prefixes: ["key-"],
    keeps: ["target", "q", "filter", "page"],
  },
  // Vyhľadávanie a dáta
  { key: "search", group: "data", path: "/admin/search", sections: ["external-search", "web-domains"] },
  { key: "partners", group: "data", path: "/admin/partners", sections: ["partner-feeds", "partner-new"], prefixes: ["partner-"] },
  { key: "inventory", group: "data", path: "/admin/inventory", sections: ["inventory"] },
  { key: "holidays", group: "data", path: "/admin/holidays", sections: ["holidays"], keeps: ["hcountry", "hyear"] },
];

export const adminPage = (key: AdminKey): AdminPage => ADMIN_PAGES.find((p) => p.key === key)!;

/** The page a section lives on (exact ids first, then the prefixes), or null for an unknown section. */
export function pageOfSection(section: string): AdminPage | null {
  return (
    ADMIN_PAGES.find((p) => p.sections.includes(section)) ??
    ADMIN_PAGES.find((p) => (p.prefixes ?? []).some((pre) => section.startsWith(pre) && section.length > pre.length)) ??
    null
  );
}

/** "/sk/admin/shops" → "shops"; the longest matching page, "/admin" itself only exactly. */
export function adminKeyFor(pathname: string): AdminKey | null {
  const path = pathname.replace(/^\/[a-z]{2,3}(?:-[a-z]{2,4})?(?=\/|$)/i, "").replace(/\/+$/, "") || "/";
  let best: AdminPage | null = null;
  for (const p of ADMIN_PAGES) {
    const hit = p.path === "/admin" ? path === "/admin" : path === p.path || path.startsWith(`${p.path}/`);
    if (hit && (!best || p.path.length > best.path.length)) best = p;
  }
  return best?.key ?? null;
}

export function adminHref(lang: string, key: AdminKey, query?: Record<string, string>, hash?: string): string {
  const q = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : "";
  return `/${lang}${adminPage(key).path}${q}${hash ? `#${hash}` : ""}`;
}

/**
 * Where a form returns to: the page its section lives on, with that page's own kept query (`keep` = the "?…" the
 * form carried; keys another page keeps are dropped), the result (?ok= / ?err=) and #section. An unknown section
 * goes to the overview, never to another page's section.
 */
export function adminBack(lang: string, section: string, keep: string, query: Record<string, string>): string {
  const page = pageOfSection(section);
  if (!page) return adminHref(lang, "home", query);
  const params = new URLSearchParams();
  const kept = new URLSearchParams(keep.startsWith("?") ? keep.slice(1) : keep);
  for (const k of page.keeps ?? []) {
    const v = kept.get(k);
    if (v) params.set(k, v);
  }
  for (const [k, v] of Object.entries(query)) params.set(k, v);
  const q = params.toString();
  return `/${lang}${page.path}${q ? `?${q}` : ""}#${section}`;
}

/** The old long page's anchors whose section got another id. Every other old anchor is the same id. */
const RENAMED: Record<string, Record<string, string>> = {
  "/admin/domains": { blog: "blog-limits" },
  "/admin/translations": { limits: "translation-limits" },
};

/**
 * An old anchor of /admin/domains or /admin/translations ("#shops", "#blog", "#limits", "#partner-<id>") → the
 * address of its section now, or null when it stays on that page (or is unknown).
 */
export function forwardAnchor(oldPath: "/admin/domains" | "/admin/translations", hash: string): string | null {
  const id = hash.replace(/^#/, "");
  if (!id) return null;
  const section = RENAMED[oldPath][id] ?? id;
  const page = pageOfSection(section);
  if (!page || (page.path === oldPath && section === id)) return null;
  return `${page.path}#${section}`;
}

/** The script on /admin/domains and /admin/translations: a moved anchor goes to its page (its query along). */
export function forwardScript(oldPath: "/admin/domains" | "/admin/translations"): string {
  const moves: Record<string, string> = {};
  for (const p of ADMIN_PAGES) {
    for (const s of p.sections) {
      const to = forwardAnchor(oldPath, s);
      if (to) moves[s] = to;
    }
  }
  for (const [from] of Object.entries(RENAMED[oldPath])) {
    const to = forwardAnchor(oldPath, from);
    if (to) moves[from] = to;
  }
  const prefixes = ADMIN_PAGES.flatMap((p) => (p.prefixes ?? []).filter(() => p.path !== oldPath).map((pre) => [pre, p.path]));
  return (
    `(function(){var h=location.hash.slice(1);if(!h)return;var m=${JSON.stringify(moves)},p=${JSON.stringify(prefixes)},to=m[h];` +
    `if(!to)for(var i=0;i<p.length;i++)if(h.indexOf(p[i][0])===0&&h.length>p[i][0].length){to=p[i][1]+"#"+h;break}` +
    `if(!to)return;var l=location.pathname.match(/^\\/[^/]+/);location.replace((l?l[0]:"")+to.replace("#",location.search+"#"))})();`
  );
}

/** Old filters on /admin/domains: the holidays' country and year → Sviatky; the shops' filters → Obchody a domény. */
export function forwardDomainsQuery(query: Record<string, string | string[] | undefined>): AdminKey | null {
  const has = (k: string) => query[k] !== undefined && query[k] !== "";
  if (has("hcountry") || has("hyear")) return "holidays";
  if (has("q") || has("status") || has("kind") || has("code_for")) return "shops";
  return null;
}
