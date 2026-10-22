import "server-only";
import { getDictionary, t } from "@/i18n/dictionaries";
import { blogPhotoUrl, blogRss, blogRssUrl, blogUrl, excerpt, type BlogPage, type BlogPlace } from "./blogFormat";
import { siteLang } from "./customDomain";
import { siteUrl } from "./site";
import { supabaseEnv } from "./supabase/env";
import { getShopLanguages } from "./shopLanguages";
import { createPublicClient } from "./supabase/public";

/**
 * The shop's RSS feed (database update 37): its 20 newest visible posts, on its canonical address. `onSite`: asked on
 * the own domain (/blog/rss.xml): only while that domain is live. Anything else → 404.
 */
export async function blogRssResponse(slug: string, onSite: boolean): Promise<Response> {
  const supabase = createPublicClient();
  if (!supabase) return new Response("Not found", { status: 404 });
  const [{ data: host }, { data: shop }, { data: blog }] = await Promise.all([
    supabase.rpc("shop_site", { p_slug: slug }),
    supabase.from("public_shops").select("slug, name, country").eq("slug", slug).maybeSingle(),
    supabase.rpc("shop_blog", { p_slug: slug, p_page: 1, p_per_page: 20 }),
  ]);
  const live = typeof host === "string" && host ? host : null;
  if (!shop || !blog || (onSite && !live)) return new Response("Not found", { status: 404 });
  const lang = siteLang(shop.country, (await getShopLanguages(shop.slug, shop.country)).home);
  const place: BlogPlace = { shopSlug: shop.slug, country: shop.country, host: live, homeLang: lang };
  const dict = await getDictionary(lang);
  const base = siteUrl();
  const storage = supabaseEnv()?.url ?? "";
  const body = blogRss({
    title: t(dict.blog.title_of, { name: shop.name }),
    link: blogUrl(base, lang, place),
    self: blogRssUrl(base, place),
    description: t(dict.blog.rss_description, { name: shop.name }),
    lang,
    items: (blog as BlogPage).posts.map((p) => ({
      title: p.title,
      url: blogUrl(base, lang, place, p.slug),
      date: p.publish_at,
      text: excerpt(p.body || p.title, 600),
      image: p.photos.find((f) => f.kind === "photo") ? blogPhotoUrl(storage, p.photos.find((f) => f.kind === "photo")!.large) : null,
    })),
  });
  return new Response(body, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=900" } });
}
