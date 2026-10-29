import type { NextRequest } from "next/server";
import { isLocale, type Locale } from "@/i18n/config";
import { json, rateLimit } from "@/lib/apiHttp";
import { getShop, getShopItems, searchShopItems } from "@/lib/data";
import { productRow, type ProductRows } from "@/lib/shopRows";

/** The live search sends a request a few keys apart: more than the API's 60 a minute, still a limit per caller. */
const SEARCH_PER_MINUTE = 120;
/** The shop page's list size (ShopView's PAGE_SIZE). */
const ROWS = 50;

/**
 * GET /api/shops/<slug>/search?q=&lang= — the rows of the shop page's "Produkty" tab while the visitor types (database
 * update 54): the forgiving shop_item_search() (+ Claude's words when nothing matched, @/lib/data searchShopItems),
 * without words the shop's first page; written for the page language on the server (@/lib/shopRows: names, price,
 * the stock dot's state — no stock sentence). Anonymous, public_stock data only; every call through rateLimit
 * (api_hit, per caller).
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/shops/[slug]/search">) {
  const { slug } = await ctx.params;
  const sp = request.nextUrl.searchParams;
  const raw = (sp.get("q") ?? "").trim().slice(0, 200);
  const q = raw.length >= 2 ? raw : "";
  const lang: Locale = isLocale(sp.get("lang")) ? (sp.get("lang") as Locale) : "sk";
  const limited = await rateLimit(request, "/api/shops/search", SEARCH_PER_MINUTE);
  if (limited) return limited;
  try {
    const shop = await getShop(slug);
    if (!shop) return json({ error: "Not found" }, 404);
    const { items, total, kind } = q
      ? await searchShopItems(shop.slug, q, ROWS)
      : await getShopItems(shop.slug, "", 1, ROWS).then((r) => ({ ...r, kind: null }));
    const body: ProductRows = { q, kind, total, rows: items.map((item) => productRow(item, lang)) };
    return json(body);
  } catch (e) {
    console.error("shop-search", e instanceof Error ? e.message : e);
    return json({ error: "Internal error" }, 500);
  }
}
