import type { NextRequest } from "next/server";
import { handle, preflight } from "@/lib/apiHttp";
import { apiLang, listShops } from "@/lib/publicApi";

/** GET /api/v1/shops?lang= — all active shops with freshness. */
export async function GET(request: NextRequest) {
  return handle(request, "/api/v1/shops", () => listShops(apiLang(request.nextUrl.searchParams.get("lang"))));
}

export const OPTIONS = preflight;
