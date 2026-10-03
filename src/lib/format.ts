import type { Locale } from "@/i18n/config";

/** Used only when a shop has no time zone set. */
export const FALLBACK_TIME_ZONE = "UTC";

const WHOLE_UNIT_CURRENCIES = new Set(["HUF", "ISK"]);

/**
 * Price in the shop's currency, written the visitor's way:
 * sk 12,90 € · hu 1 890 Ft · en €12.90 · CZK, PLN, CHF… all work.
 */
export function formatPrice(value: number | null | undefined, locale: Locale, currency = "EUR"): string {
  if (value === null || value === undefined) return "";
  const amount = Number(value);
  // Currencies normally priced without cents in shops.
  const wholeUnits = WHOLE_UNIT_CURRENCIES.has(currency) && Number.isInteger(amount);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      ...(wholeUnits ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`; // unknown currency code
  }
}

function zone(timeZone: string | null | undefined): string {
  if (!timeZone) return FALLBACK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return timeZone;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/** "14:05" in the given (shop's) time zone. */
export function formatTime(date: Date, timeZone?: string | null): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone(timeZone),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** "2026-10-01" in the given time zone, for comparing calendar days. */
export function localDay(date: Date, timeZone?: string | null): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** "1,3 km" / "1.3 km" / "850 m". */
export function formatDistance(km: number, locale: Locale): string {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  return `${km.toLocaleString(locale, { maximumFractionDigits: 1 })} km`;
}

/** Google Maps directions to a point; opens the maps app on phones. */
export function directionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

/** "Hlavná 1, Košice" from the parts that exist. */
export function addressLine(...parts: (string | null | undefined)[]): string {
  return parts.filter((p) => p && p.trim()).join(", ");
}

/** "3. 10. 2026 14:05" in the visitor's language, in the given (shop's) time zone. */
export function formatDateTime(value: string | Date, locale: Locale, timeZone?: string | null): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: zone(timeZone),
    dateStyle: "medium",
    timeStyle: "short",
  }).format(typeof value === "string" ? new Date(value) : value);
}
