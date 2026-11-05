import type { NextRequest } from "next/server";
import { json, rateLimit } from "@/lib/apiHttp";
import { searchShopMenu } from "@/lib/menu";

/** The live search sends a request a few keys apart (as the shop's Produkty search). */
const SEARCH_PER_MINUTE = 120;

/**
 * GET /api/shops/<slug>/menu-search?q= — "Hľadať v menu" on a restaurant's page (update 80): the ids of the dishes
 * shop_menu_search() finds (update 54's forgiving rule: typos, word order, stems, sizes), the best first; the page has
 * every dish already and only shows these. Anonymous; every call through rateLimit (api_hit, per caller).
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/shops/[slug]/menu-search">) {
  const { slug } = await ctx.params;
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 200);
  const limited = await rateLimit(request, "/api/shops/menu-search", SEARCH_PER_MINUTE);
  if (limited) return limited;
  try {
    return json({ q, ids: q.length >= 2 ? await searchShopMenu(slug, q) : null });
  } catch (e) {
    console.error("menu-search", e instanceof Error ? e.message : e);
    return json({ error: "Internal error" }, 500);
  }
}
