import type { NextRequest } from "next/server";
import { handle, preflight } from "@/lib/apiHttp";
import { apiLang, getItem } from "@/lib/publicApi";

/** GET /api/v1/items/{id}?lang= — one item plus the same product in other shops. */
export async function GET(request: NextRequest, { params }: RouteContext<"/api/v1/items/[id]">) {
  const { id } = await params;
  return handle(request, "/api/v1/items/{id}", () => getItem(id, apiLang(request.nextUrl.searchParams.get("lang"))));
}

export const OPTIONS = preflight;
