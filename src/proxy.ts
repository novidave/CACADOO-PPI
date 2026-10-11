import { NextResponse, type NextRequest } from "next/server";
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { siteUrl } from "@/lib/site";
import { refreshSession } from "@/lib/supabase/session";
import { supabaseEnv } from "@/lib/supabase/env";

const ONE_YEAR = 60 * 60 * 24 * 365;

function preferredLocale(request: NextRequest): Locale {
  const saved = request.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(saved)) return saved;

  const header = request.headers.get("accept-language") ?? "";
  for (const part of header.split(",")) {
    const code = part.split(";")[0].trim().slice(0, 2).toLowerCase();
    if (isLocale(code)) return code;
  }
  return defaultLocale;
}

// ---------------------------------------------------------------- shops' own domains (update 25)

interface Site {
  slug: string;
  primaryHost: string;
  lang: Locale;
}

/** PPI's own addresses: everything else may be a shop's domain. */
function isMainHost(host: string): boolean {
  let main = "";
  try {
    main = new URL(siteUrl()).hostname;
  } catch {
    main = "";
  }
  const extra = (process.env.PPI_MAIN_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return (
    !host ||
    host === main ||
    host === `www.${main}` ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".vercel.app") ||
    extra.includes(host)
  );
}

/** hostname → shop (shop_for_host: only live domains of shops with Pro), kept a minute. */
const sites = new Map<string, { at: number; site: Site | null }>();
async function siteFor(host: string): Promise<Site | null> {
  const known = sites.get(host);
  if (known && Date.now() - known.at < (known.site ? 60_000 : 20_000)) return known.site;
  const env = supabaseEnv();
  if (!env) return null;
  const res = await fetch(`${env.url}/rest/v1/rpc/shop_for_host`, {
    method: "POST",
    headers: { apikey: env.key, Authorization: `Bearer ${env.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_host: host }),
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return known?.site ?? null;
  const rows = (await res.json().catch(() => [])) as { slug: string; primary_host: string; site_lang: string }[];
  const row = rows[0];
  const site = row && isLocale(row.site_lang) ? { slug: row.slug, primaryHost: row.primary_host, lang: row.site_lang } : null;
  if (sites.size > 2000) sites.clear();
  sites.set(host, { at: Date.now(), site });
  return site;
}

const NOT_CONNECTED =
  '<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="robots" content="noindex"><title>Cacadoo PPI</title></head><body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">' +
  "<h1>Táto doména zatiaľ nie je pripojená</h1><p>This domain is not connected (yet).</p></body></html>";

/**
 * A shop's own domain: its Pro page is served directly (no redirect): "/" in the shop's
 * language, "/{lang}" in the others, "/{lang}/items/{id}" its items, and its own
 * sitemap.xml and robots.txt. One primary host (bare); www redirects to it. Anything else
 * (login, other shops…) goes to PPI's own address.
 */
async function shopDomain(request: NextRequest, host: string): Promise<NextResponse> {
  const site = await siteFor(host);
  if (!site) return new NextResponse(NOT_CONNECTED, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  const { pathname, search } = request.nextUrl;
  if (host !== site.primaryHost) {
    return NextResponse.redirect(`${request.nextUrl.protocol}//${site.primaryHost}${request.nextUrl.port ? `:${request.nextUrl.port}` : ""}${pathname}${search}`, 308);
  }
  const parts = pathname.split("/").filter(Boolean);
  const to = (path: string) => NextResponse.rewrite(new URL(`${path}${search}`, request.url));
  const goTo = (path: string) => NextResponse.redirect(new URL(`${path}${search}`, request.url), 308);

  if (pathname === "/sitemap.xml") return to(`/api/site/${site.slug}/sitemap`);
  if (pathname === "/robots.txt") return to(`/api/site/${site.slug}/robots`);
  if (parts.length === 0) return to(`/${site.lang}/site/${site.slug}`);
  const [first, second, third] = parts;
  if (isLocale(first)) {
    if (parts.length === 1) return to(`/${first}/site/${site.slug}`);
    if (second === "items" && third && parts.length === 3) return to(`/${first}/site/${site.slug}/items/${third}`);
    // The shop's own Cacadoo path → its address on the domain.
    if (second === "shops" && third === site.slug && parts.length === 3) return goTo(first === site.lang ? "/" : `/${first}`);
  }
  if (first === "items" && second && parts.length === 2) return to(`/${site.lang}/site/${site.slug}/items/${second}`);
  return NextResponse.redirect(`${siteUrl()}${pathname}${search}`, 307);
}

/** Every page lives under /sk, /hu or /en. Remembers the chosen language. */
export async function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!isMainHost(host)) return await shopDomain(request, host);

  const { pathname } = request.nextUrl;
  // PPI's own sitemap.xml and robots.txt (matched only for shops' domains).
  if (pathname === "/sitemap.xml" || pathname === "/robots.txt") return NextResponse.next();
  const segment = pathname.split("/")[1];

  if (!isLocale(segment)) {
    const url = request.nextUrl.clone();
    url.pathname = `/${preferredLocale(request)}${pathname === "/" ? "" : pathname}`;
    return NextResponse.redirect(url);
  }

  // A shop's domain page asked for on PPI's own address: the Cacadoo page instead.
  const parts = pathname.split("/").filter(Boolean);
  if (parts[1] === "site" && parts[2]) {
    const url = request.nextUrl.clone();
    url.pathname = parts[3] === "items" && parts[4] ? `/${segment}/items/${parts[4]}` : `/${segment}/shops/${parts[2]}`;
    return NextResponse.redirect(url, 308);
  }

  const response = NextResponse.next();
  if (request.cookies.get(LOCALE_COOKIE)?.value !== segment) {
    response.cookies.set(LOCALE_COOKIE, segment, { path: "/", maxAge: ONE_YEAR, sameSite: "lax" });
  }
  return refreshSession(request, response);
}

export const config = {
  // Skip Next internals, API/MCP routes and files with an extension (llms.txt...), except
  // sitemap.xml and robots.txt (a shop's own domain has its own).
  matcher: ["/((?!_next/|api/|mcp|auth/|.*\\..*).*)", "/sitemap.xml", "/robots.txt"],
};
