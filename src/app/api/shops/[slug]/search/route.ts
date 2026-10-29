import type { NextRequest } from "next/server";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { json, rateLimit } from "@/lib/apiHttp";
import { getShop, searchShopItems } from "@/lib/data";
import { formatPrice } from "@/lib/format";
import { itemNames } from "@/lib/names";
import { availabilityText } from "@/lib/stock";
import { stockState } from "@/lib/stockDot";

/** Suggestions a visitor types quickly: more than the API's 60 a minute, still a limit per caller. */
const SUGGEST_PER_MINUTE = 120;

/**
 * GET /api/shops/<slug>/search?q=&lang= — the "Tovar v obchode" dropdown (database update 54): up to 8 suggestions of
 * shop_item_search() (+ Claude's words when nothing matched, @/lib/data searchShopItems), written for the page
 * language on the server (names, price, availability). Anonymous, public_stock data only; every call through
 * rateLimit (api_hit, per caller).
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/shops/[slug]/search">) {
  const { slug } = await ctx.params;
  const sp = request.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim().slice(0, 200);
  const lang: Locale = isLocale(sp.get("lang")) ? (sp.get("lang") as Locale) : "sk";
  if (q.length < 2) return json({ q, kind: null, total: 0, items: [] });
  const limited = await rateLimit(request, "/api/shops/search", SUGGEST_PER_MINUTE);
  if (limited) return limited;
  try {
    const [shop, dict] = await Promise.all([getShop(slug), getDictionary(lang)]);
    if (!shop) return json({ error: "Not found" }, 404);
    const { items, total, kind } = await searchShopItems(shop.slug, q, 8);
    return json({
      q,
      kind,
      total,
      items: items.map((item) => {
        const names = itemNames(item.item_name, item.item_name_i18n, lang);
        return {
          id: item.item_id,
          name: names.primary,
          original: names.secondary,
          price: item.price === null ? null : formatPrice(item.price, lang, item.currency),
          stock: stockState(item.availability),
          availability: availabilityText(dict, item.availability, item.quantity, lang) ?? dict.stock.stale,
          category: item.category,
          matched: item.matched,
        };
      }),
    });
  } catch (e) {
    console.error("shop-search", e instanceof Error ? e.message : e);
    return json({ error: "Internal error" }, 500);
  }
}
