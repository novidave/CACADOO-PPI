// The admin area's map (2026-11-05): every section lives on exactly one page, every admin form returns to its own
// page, the old /admin/domains and /admin/translations anchors and filters forward. Run with `npm run test:content`.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ADMIN_GROUPS,
  ADMIN_PAGES,
  adminBack,
  adminHref,
  adminKeyFor,
  forwardAnchor,
  forwardDomainsQuery,
  forwardScript,
  pageOfSection,
} from "./adminPages.ts";

const ADMIN = new URL("../app/[lang]/(admin)/admin/", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, ADMIN));

/** The `id="…"` of every <section> (and the partner form's <details>) a source file draws. */
function sectionIds(source: string): string[] {
  return [...source.matchAll(/<(?:section|details)[^>]*\sid="([a-z0-9-]+)"/g)].map((m) => m[1]);
}

/** The relative "../_parts/X" / "./_parts/X" modules a page imports, as paths under the admin folder. */
function partImports(source: string, pageDir: string): string[] {
  // a type-only import draws nothing
  return [...source.matchAll(/^import (?!type )[^;]*from "(\.\.?\/_parts\/[A-Za-z]+)"/gm)]
    .map((m) => new URL(`${m[1]}.tsx`, new URL(pageDir, ADMIN)).href.replace(ADMIN.href, ""))
    .filter((p) => !p.endsWith("common.tsx") && !p.endsWith("actions.tsx") && !p.endsWith("partnerActions.tsx"));
}

Deno.test("every section is on exactly one page, every page in one group", () => {
  const seen = new Map<string, string>();
  for (const p of ADMIN_PAGES) {
    assert(ADMIN_GROUPS.includes(p.group), p.key);
    for (const s of p.sections) {
      assert(!seen.has(s), `${s} is on ${seen.get(s)} and ${p.key}`);
      seen.set(s, p.key);
    }
  }
  assertEquals(new Set(ADMIN_PAGES.map((p) => p.path)).size, ADMIN_PAGES.length, "one path per page");
  assertEquals(ADMIN_PAGES.map((p) => p.key), [
    "home", "shops", "errors", "domains", "limits", "sms", "integrations", "translations", "search", "partners", "inventory", "holidays",
  ]);
  assertEquals(pageOfSection("partner-3f1c")?.key, "partners");
  assertEquals(pageOfSection("key-shop.title")?.key, "translations");
  assertEquals(pageOfSection("nowhere"), null);
});

Deno.test("each page file draws exactly its own sections (through the parts it imports)", async () => {
  for (const p of ADMIN_PAGES) {
    const dir = p.key === "home" ? "./" : `./${p.path.split("/").pop()}/`;
    const source = await read(`${dir}page.tsx`);
    const drawn = sectionIds(source);
    for (const part of partImports(source, dir)) drawn.push(...sectionIds(await read(part)));
    const own = drawn.filter((id) => pageOfSection(id)?.key === p.key);
    const other = drawn.filter((id) => pageOfSection(id) && pageOfSection(id)?.key !== p.key);
    assertEquals(other, [], `${p.key} draws another page's section`);
    for (const s of p.sections) assert(own.includes(s), `${p.key} does not draw #${s}`);
  }
});

Deno.test("every admin form returns to its own page", async () => {
  // the sections the actions send back to (back(…, "x") and the default "shops")
  const files = ["_parts/actions.ts", "_parts/partnerActions.ts", "translations/actions.ts"];
  for (const f of files) {
    const source = await read(f);
    assert(source.includes("adminBack("), `${f} uses adminBack`);
    assert(!/redirect\(`\/\$\{lang\}\/admin\//.test(source), `${f} builds no admin address of its own`);
    for (const m of source.matchAll(/back\([^;]*?,\s*"([a-z-]+)"\)/g)) assert(pageOfSection(m[1]), `${f}: #${m[1]} is no section`);
  }
  // the address itself: the section's page, that page's kept query only, the result, #section
  assertEquals(adminBack("sk", "prices", "?q=x&hcountry=HU", { ok: "price" }), "/sk/admin/domains?ok=price#prices");
  assertEquals(adminBack("sk", "shops", "?q=farby&status=problem&hcountry=HU", { ok: "done" }), "/sk/admin/shops?q=farby&status=problem&ok=done#shops");
  assertEquals(adminBack("hu", "holidays", "?hcountry=HU&hyear=2027", { ok: "holiday" }), "/hu/admin/holidays?hcountry=HU&hyear=2027&ok=holiday#holidays");
  assertEquals(adminBack("sk", "blog-limits", "", { err: "blog_limits" }), "/sk/admin/limits?err=blog_limits#blog-limits");
  assertEquals(adminBack("sk", "translation-limits", "?target=de&page=2", { ok: "tr_limits" }), "/sk/admin/limits?ok=tr_limits#translation-limits");
  assertEquals(adminBack("sk", "key-shop.title", "?target=de&page=2", { ok: "ui_text" }), "/sk/admin/translations?target=de&page=2&ok=ui_text#key-shop.title");
  assertEquals(adminBack("sk", "partner-abc", "", { ok: "partner_saved" }), "/sk/admin/partners?ok=partner_saved#partner-abc");
  assertEquals(adminBack("sk", "inventory-limits", "", { ok: "inventory" }), "/sk/admin/limits?ok=inventory#inventory-limits");
  assertEquals(adminBack("sk", "inventory", "", { ok: "inventory" }), "/sk/admin/inventory?ok=inventory#inventory");
  assertEquals(adminBack("sk", "unknown", "", { ok: "x" }), "/sk/admin?ok=x");
});

Deno.test("old anchors and filters forward to their page", () => {
  const moves: [string, string | null][] = [
    ["#shops", "/admin/shops#shops"],
    ["#credit", "/admin/shops#credit"],
    ["#errors", "/admin/errors#errors"],
    ["#settings", null],
    ["#prices", null],
    ["#section-limits", "/admin/limits#section-limits"],
    ["#blog", "/admin/limits#blog-limits"],
    ["#inventory", "/admin/inventory#inventory"],
    ["#sms", "/admin/sms#sms"],
    ["#telegram", "/admin/integrations#telegram"],
    ["#owner-ai", "/admin/integrations#owner-ai"],
    ["#external-search", "/admin/search#external-search"],
    ["#web-domains", "/admin/search#web-domains"],
    ["#partner-feeds", "/admin/partners#partner-feeds"],
    ["#partner-new", "/admin/partners#partner-new"],
    ["#partner-1234", "/admin/partners#partner-1234"],
    ["#holidays", "/admin/holidays#holidays"],
    ["", null],
    ["#nothing", null],
  ];
  for (const [hash, to] of moves) assertEquals(forwardAnchor("/admin/domains", hash), to, hash);
  assertEquals(forwardAnchor("/admin/translations", "#limits"), "/admin/limits#translation-limits");
  assertEquals(forwardAnchor("/admin/translations", "#ui"), null);
  assertEquals(forwardAnchor("/admin/translations", "#languages"), null);
  assertEquals(forwardDomainsQuery({ hcountry: "HU", hyear: "2027" }), "holidays");
  assertEquals(forwardDomainsQuery({ hyear: "2027" }), "holidays");
  assertEquals(forwardDomainsQuery({ status: "problem" }), "shops");
  assertEquals(forwardDomainsQuery({ code_for: "x", ok: "done" }), "shops");
  assertEquals(forwardDomainsQuery({ ok: "price" }), null);
  assertEquals(forwardDomainsQuery({}), null);
});

Deno.test("the forwarding script sends a moved anchor with its query, and leaves the rest", () => {
  const run = (path: string, search: string, hash: string, script: string) => {
    let to: string | null = null;
    const location = { pathname: path, search, hash, replace: (u: string) => (to = u) };
    new Function("location", script)(location);
    return to;
  };
  const s = forwardScript("/admin/domains");
  assertEquals(run("/sk/admin/domains", "?q=farby", "#shops", s), "/sk/admin/shops?q=farby#shops");
  assertEquals(run("/hu/admin/domains", "", "#blog", s), "/hu/admin/limits#blog-limits");
  assertEquals(run("/sk/admin/domains", "", "#partner-77", s), "/sk/admin/partners#partner-77");
  assertEquals(run("/sk/admin/domains", "", "#prices", s), null);
  assertEquals(run("/sk/admin/domains", "", "", s), null);
  assertEquals(run("/en/admin/translations", "?target=de", "#limits", forwardScript("/admin/translations")), "/en/admin/limits?target=de#translation-limits");
  assertEquals(run("/en/admin/translations", "", "#ui", forwardScript("/admin/translations")), null);
});

Deno.test("the menu item of an address, and the links", () => {
  assertEquals(adminKeyFor("/sk/admin"), "home");
  assertEquals(adminKeyFor("/sk/admin/"), "home");
  assertEquals(adminKeyFor("/hu/admin/shops"), "shops");
  assertEquals(adminKeyFor("/en/admin/translations"), "translations");
  assertEquals(adminKeyFor("/sr-cyrl/admin/holidays"), "holidays");
  assertEquals(adminKeyFor("/sk/dashboard"), null);
  assertEquals(adminHref("sk", "limits"), "/sk/admin/limits");
  assertEquals(adminHref("sk", "limits", undefined, "inventory-limits"), "/sk/admin/limits#inventory-limits");
  assertEquals(adminHref("sk", "holidays", { hcountry: "HU" }), "/sk/admin/holidays?hcountry=HU");
});

Deno.test("every admin page calls notFound() unless the session is the admin's (through adminStart)", async () => {
  const common = await read("_parts/common.tsx");
  assert(/if \(!session\.isAdmin\) notFound\(\);/.test(common), "adminStart checks is_admin");
  const layout = await Deno.readTextFile(new URL("../app/[lang]/(admin)/layout.tsx", import.meta.url));
  assert(/if \(!session\.isAdmin\) notFound\(\);/.test(layout), "the shell checks is_admin");
  for (const p of ADMIN_PAGES) {
    const dir = p.key === "home" ? "./" : `./${p.path.split("/").pop()}/`;
    const source = await read(`${dir}page.tsx`);
    assert(/await adminStart\(params\)/.test(source) || /if \(!session\.isAdmin\) notFound\(\);/.test(source), `${p.key} checks is_admin`);
  }
});
