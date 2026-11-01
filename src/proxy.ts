import { NextResponse, type NextRequest } from "next/server";
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { fromAcceptLanguage, HANDWRITTEN } from "@/i18n/languages";
import { siteUrl } from "@/lib/site";
import { refreshSession } from "@/lib/supabase/session";
import { supabaseEnv } from "@/lib/supabase/env";

const ONE_YEAR = 60 * 60 * 24 * 365;

/** The languages the admin switched on (site_languages(), update 40), kept a minute; sk, hu, en before update 40. */
let enabledCache: { at: number; codes: string[] } | null = null;
async function enabledLanguages(): Promise<string[]> {
  if (enabledCache && Date.now() - enabledCache.at < 60_000) return enabledCache.codes;
  const env = supabaseEnv();
  let codes: string[] = [...HANDWRITTEN];
  if (env) {
    const res = await fetch(`${env.url}/rest/v1/rpc/site_languages`, {
      method: "POST",
      headers: { apikey: env.key, Authorization: `Bearer ${env.key}`, "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
    }).catch(() => null);
    const rows = res?.ok ? ((await res.json().catch(() => null)) as { code: string; enabled: boolean }[] | null) : null;
    if (Array.isArray(rows) && rows.length) codes = rows.filter((r) => r.enabled && isLocale(r.code)).map((r) => r.code);
    else if (enabledCache) codes = enabledCache.codes;
  }
  enabledCache = { at: Date.now(), codes };
  return codes;
}

/**
 * The first visit on PPI's own address: the language chosen before (the functional cookie ppi_lang), else the
 * browser's first language that is switched on (de-AT → de, zh-TW → zh-hant), else Slovak. No location is used.
 */
async function preferredLocale(request: NextRequest): Promise<Locale> {
  const enabled = await enabledLanguages();
  const saved = request.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(saved) && enabled.includes(saved)) return saved;
  const browser = fromAcceptLanguage(request.headers.get("accept-language") ?? "", enabled);
  return isLocale(browser) ? browser : defaultLocale;
}

/** Remembers the language of the page the visitor is on (a year). */
function rememberLocale(request: NextRequest, response: NextResponse, lang: string): NextResponse {
  if (request.cookies.get(LOCALE_COOKIE)?.value !== lang) response.cookies.set(LOCALE_COOKIE, lang, { path: "/", maxAge: ONE_YEAR, sameSite: "lax" });
  return response;
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
  '<meta name="robots" content="noindex"><title>Cacaduu PPI</title></head><body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">' +
  "<h1>Táto doména zatiaľ nie je pripojená</h1><p>This domain is not connected (yet).</p></body></html>";

/** The IndexNow key file: "/<key>.txt" (8–128 letters, digits or dashes). */
const KEY_FILE = /^\/([A-Za-z0-9-]{8,128})\.txt$/;

/** A post's address part ("nova-kolekcia-2026"). */
const POST_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * A shop's own domain: its Pro page is served directly (no redirect): "/" in the shop's
 * language, "/{lang}" in the others, "/{lang}/items/{id}" its items, its blog ("/blog", "/blog/{post}",
 * "/{lang}/blog…", "/blog/rss.xml"; update 37), and its own sitemap.xml, robots.txt, llms.txt and IndexNow key
 * file. One primary host (bare); www redirects to it. Anything else (login, other shops…) goes to PPI's own address.
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
  if (pathname === "/blog/rss.xml") return to(`/api/site/${site.slug}/blog-rss`);
  if (pathname === "/robots.txt") return to(`/api/site/${site.slug}/robots`);
  // For AI assistants, and the IndexNow key file (update 33).
  if (pathname === "/llms.txt") return to(`/api/site/${site.slug}/llms`);
  const keyFile = KEY_FILE.exec(pathname);
  if (keyFile) return to(`/api/site/${site.slug}/indexnow/${keyFile[1]}`);
  // The domain's own pages: src/app/site/[lang]/[slug] (their own layout, no Cacaduu header). The first visit is
  // in the shop's home language ("/"); a language the visitor chose before on this domain (ppi_lang) is kept.
  if (parts.length === 0) {
    const saved = request.cookies.get(LOCALE_COOKIE)?.value;
    if (isLocale(saved) && saved !== site.lang && (await enabledLanguages()).includes(saved)) return NextResponse.redirect(new URL(`/${saved}${search}`, request.url), 307);
    return to(`/site/${site.lang}/${site.slug}`);
  }
  const [first, second, third, fourth, fifth] = parts;
  // The blog: "/blog" and "/blog/{post}" in the shop's language, "/{lang}/blog…" in the others.
  const blog = (lang: Locale, post: string | undefined) =>
    post === undefined ? to(`/site/${lang}/${site.slug}/blog`) : POST_SLUG.test(post) ? to(`/site/${lang}/${site.slug}/blog/${post}`) : null;
  if (first === "blog" && parts.length <= 2) {
    const r = blog(site.lang, second);
    if (r) return r;
  }
  // The shop's own "Právne informácie" (database update 65).
  if (first === "pravne-informacie" && parts.length === 1) return to(`/site/${site.lang}/${site.slug}/pravne-informacie`);
  if (isLocale(first)) {
    if (parts.length === 1) return rememberLocale(request, to(`/site/${first}/${site.slug}`), first);
    if (second === "items" && third && parts.length === 3) return to(`/site/${first}/${site.slug}/items/${third}`);
    if (second === "pravne-informacie" && parts.length === 2) return to(`/site/${first}/${site.slug}/pravne-informacie`);
    if (second === "blog" && parts.length <= 3) {
      const r = blog(first, third);
      if (r) return r;
    }
    // The shop's own Cacaduu path → its address on the domain.
    if (second === "shops" && third === site.slug && parts.length === 3) return goTo(first === site.lang ? "/" : `/${first}`);
    if (second === "shops" && third === site.slug && fourth === "pravne-informacie" && parts.length === 4) {
      return goTo(`${first === site.lang ? "" : `/${first}`}/pravne-informacie`);
    }
    if (second === "shops" && third === site.slug && fourth === "blog" && parts.length <= 5) {
      return goTo(`${first === site.lang ? "" : `/${first}`}/blog${fifth ? `/${fifth}` : ""}`);
    }
  }
  if (first === "items" && second && parts.length === 2) return to(`/site/${site.lang}/${site.slug}/items/${second}`);
  return NextResponse.redirect(`${siteUrl()}${pathname}${search}`, 307);
}

/** Every page lives under its language (/sk, /de, /zh-hans …). Remembers the chosen language. */
export async function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!isMainHost(host)) return await shopDomain(request, host);

  const { pathname } = request.nextUrl;
  // PPI's own sitemap.xml, robots.txt and llms.txt (matched only for shops' domains; "/blog/rss.xml" too).
  if (pathname === "/sitemap.xml" || pathname === "/robots.txt" || pathname === "/llms.txt" || pathname === "/blog/rss.xml") {
    return NextResponse.next();
  }
  // The IndexNow key file of the main domain too (update 36: every host serves the one key).
  const keyFile = KEY_FILE.exec(pathname);
  if (keyFile) return NextResponse.rewrite(new URL(`/api/indexnow/${keyFile[1]}`, request.url));
  const segment = pathname.split("/")[1];

  // A shop's domain page asked for on PPI's own address (/site/{lang}/{slug}…): the Cacaduu page.
  if (segment === "site") {
    const [, lang, slug, kind, id] = pathname.split("/").filter(Boolean);
    const url = request.nextUrl.clone();
    const target = isLocale(lang) ? lang : await preferredLocale(request);
    url.pathname = !slug
      ? `/${target}`
      : kind === "items" && id
        ? `/${target}/items/${id}`
        : kind === "blog"
          ? `/${target}/shops/${slug}/blog${id ? `/${id}` : ""}`
          : `/${target}/shops/${slug}`;
    return NextResponse.redirect(url, 308);
  }

  if (!isLocale(segment)) {
    const url = request.nextUrl.clone();
    url.pathname = `/${await preferredLocale(request)}${pathname === "/" ? "" : pathname}`;
    return NextResponse.redirect(url);
  }

  // A shop's domain page asked for on PPI's own address: the Cacaduu page instead.
  const parts = pathname.split("/").filter(Boolean);
  if (parts[1] === "site" && parts[2]) {
    const url = request.nextUrl.clone();
    url.pathname =
      parts[3] === "items" && parts[4]
        ? `/${segment}/items/${parts[4]}`
        : parts[3] === "blog"
          ? `/${segment}/shops/${parts[2]}/blog${parts[4] ? `/${parts[4]}` : ""}`
          : `/${segment}/shops/${parts[2]}`;
    return NextResponse.redirect(url, 308);
  }

  return refreshSession(request, rememberLocale(request, NextResponse.next(), segment));
}

export const config = {
  // Skip Next internals, API/MCP routes and files with an extension, except sitemap.xml,
  // robots.txt, llms.txt, the IndexNow key file and the blog's RSS feed (a shop's own domain has its own).
  matcher: [
    "/((?!_next/|api/|mcp|auth/|.*\\..*).*)",
    "/sitemap.xml",
    "/robots.txt",
    "/llms.txt",
    "/blog/rss.xml",
    "/:file([A-Za-z0-9-]{8,128}\\.txt)",
  ],
};
