import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/i18n/config";

/**
 * Addresses on a shop's own domain (database update 25). The front page "/" is in the
 * shop's language (its country: SK → sk, HU → hu, else en — the same rule as the SQL
 * shop_site_lang()); "/hu", "/en" … are the other languages; items are "/{lang}/items/{id}".
 */
export function siteLang(country: string | null | undefined): Locale {
  const c = String(country ?? "").toUpperCase();
  return c === "SK" ? "sk" : c === "HU" ? "hu" : "en";
}

/** The shop's page in this language on its own domain: "/" or "/hu". */
export function sitePath(lang: string, defaultLang: string): string {
  return lang === defaultLang ? "/" : `/${lang}`;
}

export function siteShopUrl(host: string, lang: string, defaultLang: string): string {
  return `https://${host}${lang === defaultLang ? "/" : `/${lang}`}`;
}

export function siteItemUrl(host: string, lang: string, itemId: string): string {
  return `https://${host}/${lang}/items/${itemId}`;
}

/**
 * Shops whose own domain is live (live_shop_sites(): the domain is live and the shop has the plan):
 * slug → host. Empty before database update 25 or on any error (links then stay on PPI).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the server and the public clients both work
export async function loadLiveSites(client: SupabaseClient<any, any, any> | null): Promise<Map<string, string>> {
  if (!client) return new Map();
  const { data, error } = await client.rpc("live_shop_sites");
  if (error || !Array.isArray(data)) return new Map();
  return new Map((data as { slug: string; primary_host: string }[]).filter((r) => r.slug && r.primary_host).map((r) => [r.slug, r.primary_host]));
}

/** A search result's link to a shop: its own domain when live (the canonical address), else its PPI page. */
export function shopHref(sites: Map<string, string>, lang: string, slug: string, country: string | null | undefined): string {
  const host = sites.get(slug);
  return host ? siteShopUrl(host, lang, siteLang(country)) : `/${lang}/shops/${slug}`;
}

/** A search result's link to an item: on its shop's own domain when live, else its PPI page. */
export function itemHref(sites: Map<string, string>, lang: string, slug: string, itemId: string): string {
  const host = sites.get(slug);
  return host ? siteItemUrl(host, lang, itemId) : `/${lang}/items/${itemId}`;
}

/**
 * The item's canonical address for other systems (API/MCP source_url, llms.txt, IndexNow): on its
 * shop's live own domain, else on PPI (`base` = PPI's own address).
 */
export function canonicalItemUrl(sites: Map<string, string>, base: string, lang: string, slug: string, itemId: string): string {
  const host = sites.get(slug);
  return host ? siteItemUrl(host, lang, itemId) : `${base}/${lang}/items/${itemId}`;
}

/** The shop's canonical address: its live own domain ("/" in its language, "/hu"…), else its PPI page. */
export function canonicalShopUrl(sites: Map<string, string>, base: string, lang: string, slug: string, country: string | null | undefined): string {
  const host = sites.get(slug);
  return host ? siteShopUrl(host, lang, siteLang(country)) : `${base}/${lang}/shops/${slug}`;
}
