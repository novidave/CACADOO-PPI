import type { NextRequest } from "next/server";
import { handle, preflight } from "@/lib/apiHttp";
import { apiLang, getShopItems } from "@/lib/publicApi";

/** GET /api/v1/shops/{slug}/items?page=&q=&lang= — 50 public items per page. */
export async function GET(request: NextRequest, { params }: RouteContext<"/api/v1/shops/[slug]/items">) {
  const { slug } = await params;
  const sp = request.nextUrl.searchParams;
  return handle(request, "/api/v1/shops/{slug}/items", () =>
    getShopItems(slug, Number(sp.get("page") ?? 1), (sp.get("q") ?? "").trim(), apiLang(sp.get("lang"))),
  );
}

export const OPTIONS = preflight;
