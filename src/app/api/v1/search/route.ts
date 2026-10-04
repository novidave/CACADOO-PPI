import type { NextRequest } from "next/server";
import { handle, preflight } from "@/lib/apiHttp";
import { apiLang, searchStock } from "@/lib/publicApi";

/** GET /api/v1/search?q=&lat=&lng=&near=&radius_km=&only_available=&lang= */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const num = (key: string) => (sp.get(key) === null || sp.get(key) === "" ? null : Number(sp.get(key)));
  return handle(request, "/api/v1/search", () =>
    searchStock({
      q: (sp.get("q") ?? "").trim(),
      lat: num("lat"),
      lng: num("lng"),
      near: sp.get("near"),
      radiusKm: num("radius_km"),
      onlyAvailable: ["1", "true", "yes"].includes((sp.get("only_available") ?? "").toLowerCase()),
      lang: apiLang(sp.get("lang")),
    }),
  );
}

export const OPTIONS = preflight;
