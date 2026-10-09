import { CORS_HEADERS, LIMIT_PER_MINUTE } from "@/lib/apiHttp";
import { siteUrl } from "@/lib/site";
import { createPublicClient } from "@/lib/supabase/public";

export const revalidate = 3600;

/** Plain-text guide for AI assistants and crawlers (llmstxt.org). */
export async function GET() {
  const base = siteUrl();
  const supabase = createPublicClient();
  const { data: shops } = supabase
    ? await supabase.from("public_shops").select("slug, name, city, country").order("name").limit(200)
    : { data: [] as { slug: string; name: string; city: string | null; country: string | null }[] };

  const text = `# PPI

> PPI shows which local shops have a product in stock right now, at what price, and how fresh that information is. Shops across Europe; pages in Slovak, Hungarian and English.

PPI reads stock from each shop's own stock software: the shop's export file arrives every 15–30 minutes, uploaded from the shop PC. It does not sell anything and has no checkout.

## Data and freshness rules

- Search matches the item name, brand, EAN barcode, the shop's name, street or town (accents and case ignored; every word must match, in any order).
- Item names work across languages: each name is also kept in plain Slovak, Hungarian and English, so "white paint", "fehér festék" and "biela farba" find the same item. Results give the name as the shop wrote it (name), the name in the requested language (name_translated) and the original's language (name_lang).
- Every item has a price, its currency and its quantity exactly as in the shop's own stock file ("12 in stock"; 0 or less = "out of stock").
- Freshness comes from the time of the shop's latest stock file: "current" (under 30 minutes), "recent" (under 24 hours), "stale" (older or none).
- For stale shops PPI shows NO availability. Never present a stale shop's item as available.
- Shop pages also list opening hours (in the shop's time zone), "open now", and facilities: customer toilet, douchette, card payment.
- Please cite the page (source_url) and the "updated" time when you use this data.

## Machine access (read-only, no login, ${LIMIT_PER_MINUTE} requests per minute)

- MCP server (Streamable HTTP): ${base}/mcp — tools: search_stock(query, near, radius_km, only_available), get_shop(slug), get_item(id)
- REST API: ${base}/api/v1/search?q=coffee&near=Michalovce&only_available=true
- REST API: ${base}/api/v1/shops · ${base}/api/v1/shops/{slug} · ${base}/api/v1/shops/{slug}/items?page=1 · ${base}/api/v1/items/{id}
- OpenAPI description: ${base}/api/openapi.json
- Sitemap: ${base}/sitemap.xml

## Pages

- Search: ${base}/en?q={product}
- Shop: ${base}/en/shops/{slug}
- Item: ${base}/en/items/{id}
- Same pages in Slovak (/sk/…) and Hungarian (/hu/…)

## Shops
${(shops ?? []).map((s) => `- [${s.name}${s.city ? `, ${s.city}` : ""}${s.country ? ` (${s.country})` : ""}](${base}/en/shops/${s.slug})`).join("\n") || "- (none yet)"}
`;
  return new Response(text, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600", ...CORS_HEADERS },
  });
}
