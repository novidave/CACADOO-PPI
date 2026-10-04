import type { MetadataRoute } from "next";
import { locales } from "@/i18n/config";
import { siteUrl } from "@/lib/site";
import { createPublicClient } from "@/lib/supabase/public";

// Rebuilt at most once an hour.
export const revalidate = 3600;

// One sitemap file may hold 50,000 addresses; each page is listed once with its
// other-language versions as alternates. Split with generateSitemaps when PPI
// outgrows this.
const MAX_ITEMS = 45_000;
const PAGE = 1000; // Supabase returns at most 1,000 rows per request

function entry(path: string, lastModified?: string | null): MetadataRoute.Sitemap[number] {
  const base = siteUrl();
  return {
    url: `${base}/en${path}`,
    ...(lastModified ? { lastModified } : {}),
    alternates: { languages: Object.fromEntries(locales.map((l) => [l, `${base}/${l}${path}`])) },
  };
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const urls: MetadataRoute.Sitemap = [entry("")];
  const supabase = createPublicClient();
  if (!supabase) return urls;

  const { data: shops } = await supabase.from("public_shops").select("slug, latest_file_time").order("slug");
  for (const shop of shops ?? []) urls.push(entry(`/shops/${shop.slug}`, shop.latest_file_time));

  // Items: lastmod = the shop's latest stock file.
  for (let from = 0; from < MAX_ITEMS; from += PAGE) {
    const { data, error } = await supabase
      .from("public_stock")
      .select("item_id, latest_file_time")
      .order("item_id")
      .range(from, Math.min(from + PAGE, MAX_ITEMS) - 1);
    if (error || !data?.length) break;
    for (const item of data) urls.push(entry(`/items/${item.item_id}`, item.latest_file_time));
    if (data.length < PAGE) break;
  }
  return urls;
}
