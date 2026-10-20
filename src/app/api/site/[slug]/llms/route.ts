import { getDictionary } from "@/i18n/dictionaries";
import { siteLang } from "@/lib/customDomain";
import { missingColumn } from "@/lib/missingColumn";
import { loadCalendars } from "@/lib/shopCalendar";
import { siteUrl } from "@/lib/site";
import { type LlmsFacts, type LlmsShop, siteLlmsTxt } from "@/lib/siteFiles";
import { createPublicClient } from "@/lib/supabase/public";

const COLUMNS = "id, name, address, city, country, timezone, phone, email, website, facebook_url, booking_url, opening_hours, lat, lng";

/**
 * llms.txt of a shop's own domain (src/proxy.ts sends "/llms.txt" of that domain here): the shop's
 * name, address, opening hours (special days, public holidays), what it sells (its own data only),
 * the sitemap, how to read the stock on its pages and Cacaduu's API/MCP for it. Only while the
 * domain is live (shop_site). Updates 33 and 36.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/site/[slug]/llms">) {
  const { slug } = await ctx.params;
  const supabase = createPublicClient();
  if (!supabase) return new Response("Not found", { status: 404 });
  const shopQuery = (columns: string) => supabase.from("public_shops").select(columns).eq("slug", slug).maybeSingle();
  const [{ data: host }, first, { data: facts }] = await Promise.all([
    supabase.rpc("shop_site", { p_slug: slug }),
    shopQuery(COLUMNS),
    // Before database update 33: no categories (the text says so).
    supabase.rpc("shop_llms_facts", { p_slug: slug }),
  ]);
  // Before database update 26 public_shops has no booking_url.
  const { data } = missingColumn(first.error, "booking_url") ? await shopQuery(COLUMNS.replace(", booking_url", "")) : first;
  const shop = data as unknown as (LlmsShop & { id: string }) | null;
  if (typeof host !== "string" || !host || !shop) return new Response("Not found", { status: 404 });
  const lang = siteLang(shop.country);
  const [dict, calendars] = await Promise.all([getDictionary(lang), loadCalendars(supabase, [shop.id], 16)]);
  const text = siteLlmsTxt({
    host,
    lang,
    slug,
    apiBase: siteUrl(),
    shop: { ...shop, booking_url: shop.booking_url ?? null },
    calendar: calendars.get(shop.id) ?? [],
    facts: (facts as LlmsFacts | null) ?? null,
    words: dict.stock,
  });
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
