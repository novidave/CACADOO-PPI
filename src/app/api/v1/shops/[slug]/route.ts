import type { NextRequest } from "next/server";
import { handle, preflight } from "@/lib/apiHttp";
import { apiLang, getShop } from "@/lib/publicApi";

/** GET /api/v1/shops/{slug}?lang= */
export async function GET(request: NextRequest, { params }: RouteContext<"/api/v1/shops/[slug]">) {
  const { slug } = await params;
  return handle(request, "/api/v1/shops/{slug}", () => getShop(slug, apiLang(request.nextUrl.searchParams.get("lang"))));
}

export const OPTIONS = preflight;
