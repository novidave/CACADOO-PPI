import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseEnv } from "./env";

/**
 * Read-only Supabase client for the public API, MCP server, sitemap and
 * llms.txt: anon key, no login, no cookies. Visitors' rules (RLS) apply.
 */
export function createPublicClient() {
  const env = supabaseEnv();
  if (!env) return null;
  return createClient(env.url, env.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Every cached public read carries this tag (an admin change refreshes them all). */
export const PUBLIC_TAG = "public";
/** Cached reads not bound to one shop (search across shops, an item by its id, the live own domains). */
export const CROSS_TAG = "cross";
/** One shop's cached reads. */
export const shopTag = (slug: string) => `shop:${slug}`;
/** At most this old (seconds) — owner saves, new stock files and published posts refresh at once. */
export const PUBLIC_SECONDS = 60;

/**
 * The read-only database functions whose answers may be cached for visitors. Everything else — and above all every
 * write such as request_translation() or the rate limits — always goes to the database.
 */
const CACHED_RPCS = new Set([
  "search_stock",
  "shop_stock",
  "shop_has_plan",
  "shop_stands_alone",
  "shopper_pdf_allowed",
  "shop_site",
  "live_shop_sites",
  "shop_calendar",
  "shop_content",
  "shop_site_logo",
  "shop_blog",
  "shop_blog_post",
  "shop_blog_count",
  "shop_translations",
  "item_texts",
  "shop_languages",
  "site_verification_meta",
  "shop_for_host",
]);

/** The shop a request is about, when it says so (p_slug in the body, slug=eq.… in the address). */
function slugOf(url: string, body: unknown): string | null {
  if (typeof body === "string") {
    try {
      const slug = (JSON.parse(body) as { p_slug?: unknown }).p_slug;
      if (typeof slug === "string" && slug) return slug;
    } catch {
      // not JSON
    }
  }
  const match = /[?&]slug=eq\.([a-z0-9-]+)/.exec(url);
  return match ? match[1] : null;
}

/** fetch for the cached client: allowed reads go through Next's data cache (60 s, tagged); the rest never does. */
export function cachedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const rpc = /\/rest\/v1\/rpc\/([a-z0-9_]+)/.exec(url)?.[1];
  const cacheable = rpc ? CACHED_RPCS.has(rpc) : method === "GET" && url.includes("/rest/v1/");
  if (!cacheable) return fetch(input, { ...init, cache: "no-store" });
  const slug = slugOf(url, init?.body);
  return fetch(input, {
    ...init,
    cache: "force-cache",
    next: { revalidate: PUBLIC_SECONDS, tags: [PUBLIC_TAG, slug ? shopTag(slug) : CROSS_TAG] },
  });
}

/**
 * The visitors' client with a short shared cache: what a shop page, item page, blog or search shows is read once a
 * minute at most, not on every visit (anon key, no cookies: every visitor sees the same). Owner pages never use it.
 */
export function createCachedPublicClient() {
  const env = supabaseEnv();
  if (!env) return null;
  return createClient(env.url, env.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: cachedFetch },
  });
}
