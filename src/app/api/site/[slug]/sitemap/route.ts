import { blogUrl } from "@/lib/blogFormat";
import { siteItemUrl, siteShopUrl } from "@/lib/customDomain";
import { getShopLanguages } from "@/lib/shopLanguages";
import { createPublicClient } from "@/lib/supabase/public";

/**
 * sitemap.xml of a shop's own domain (src/proxy.ts sends "/sitemap.xml" of that domain here):
 * the shop's page, its blog (update 37) and its items, on the domain, each with its other languages. Only while
 * the domain is live (shop_site); PPI's own sitemap leaves these pages out.
 */
const MAX_ITEMS = 45_000;
const PAGE = 1000;
const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export async function GET(_request: Request, ctx: RouteContext<"/api/site/[slug]/sitemap">) {
  const { slug } = await ctx.params;
  const supabase = createPublicClient();
  if (!supabase) return new Response("Not found", { status: 404 });
  const [{ data: host }, { data: shop }] = await Promise.all([
    supabase.rpc("shop_site", { p_slug: slug }),
    supabase.from("public_shops").select("slug, country, latest_file_time").eq("slug", slug).maybeSingle(),
  ]);
  if (typeof host !== "string" || !host || !shop) return new Response("Not found", { status: 404 });
  // Only the shop's pre-translated languages (update 40): the others get noindex and stay out of the sitemap.
  const langs = await getShopLanguages(slug, shop.country);
  const locales = langs.indexed;
  const defaultLang = langs.home;
  const entry = (urls: Record<string, string>, main: string, lastmod?: string | null) =>
    `<url><loc>${xml(main)}</loc>${lastmod ? `<lastmod>${xml(lastmod)}</lastmod>` : ""}${Object.entries(urls)
      .map(([l, u]) => `<xhtml:link rel="alternate" hreflang="${l}" href="${xml(u)}"/>`)
      .join("")}</url>`;
  const lines = [
    entry(Object.fromEntries(locales.map((l) => [l, siteShopUrl(host, l, defaultLang)])), siteShopUrl(host, defaultLang, defaultLang), shop.latest_file_time),
  ];
  // The blog (database update 37): "/blog" and every post shown, lastmod = the post's last change.
  const { data: posts } = await supabase.rpc("blog_index", { p_slug: slug, p_limit: 20_000 });
  const place = { shopSlug: slug, country: shop.country, host, homeLang: defaultLang };
  const blogEntries = ((posts ?? []) as { post_slug: string; modified_at: string }[]).map((p) =>
    entry(Object.fromEntries(locales.map((l) => [l, blogUrl("", l, place, p.post_slug)])), blogUrl("", defaultLang, place, p.post_slug), p.modified_at),
  );
  if (blogEntries.length) {
    lines.push(entry(Object.fromEntries(locales.map((l) => [l, blogUrl("", l, place)])), blogUrl("", defaultLang, place), (posts as { modified_at: string }[])[0]?.modified_at), ...blogEntries);
  }
  for (let from = 0; from < MAX_ITEMS; from += PAGE) {
    const { data, error } = await supabase
      .from("public_stock")
      .select("item_id, latest_file_time")
      .eq("shop_slug", slug)
      .order("item_id")
      .range(from, from + PAGE - 1);
    if (error || !data?.length) break;
    for (const item of data) {
      lines.push(entry(Object.fromEntries(locales.map((l) => [l, siteItemUrl(host, l, item.item_id)])), siteItemUrl(host, defaultLang, item.item_id), item.latest_file_time));
    }
    if (data.length < PAGE) break;
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${lines.join("\n")}\n</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
