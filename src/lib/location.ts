import "server-only";

/**
 * Where to search from. Nothing is hard-coded: PPI works in any European town.
 *  1. "device"      – lat/lng in the URL, set by the "Use my location" button
 *  2. "approximate" – the visitor's city from Vercel's IP lookup (no JavaScript
 *                     needed, nothing stored)
 *  3. null          – unknown: search every shop, no distances
 */
export interface VisitorLocation {
  lat: number;
  lng: number;
  source: "device" | "approximate";
  /** City name for approximate locations, e.g. "Košice". */
  label?: string;
}

function coordinate(value: string | null | undefined, limit: number): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

export function resolveLocation(
  params: { lat?: string; lng?: string },
  headers: Headers,
): VisitorLocation | null {
  const lat = coordinate(params.lat, 90);
  const lng = coordinate(params.lng, 180);
  if (lat !== null && lng !== null) return { lat, lng, source: "device" };

  const ipLat = coordinate(headers.get("x-vercel-ip-latitude"), 90);
  const ipLng = coordinate(headers.get("x-vercel-ip-longitude"), 180);
  if (ipLat !== null && ipLng !== null) {
    let city = headers.get("x-vercel-ip-city") ?? undefined;
    try {
      city = city ? decodeURIComponent(city) : undefined;
    } catch {
      // keep the raw header value
    }
    return { lat: ipLat, lng: ipLng, source: "approximate", label: city };
  }

  return null;
}

/**
 * Country and time zone suggested for a new shop, from Vercel's IP lookup of the
 * owner's own connection (nothing hard-coded; empty when unknown).
 */
export function guessShopRegion(headers: Headers): { country: string; timezone: string } {
  const country = (headers.get("x-vercel-ip-country") ?? "").toUpperCase();
  const timezone = headers.get("x-vercel-ip-timezone") ?? "";
  return {
    country: /^[A-Z]{2}$/.test(country) ? country : "",
    timezone: /^[A-Za-z_]+\/[A-Za-z_/-]+$/.test(timezone) ? timezone : "",
  };
}
