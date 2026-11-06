import type { Dictionary } from "@/i18n/dictionaries";
import { t } from "../i18n/messages";
import { formatTime, localDay } from "./format";
import type { NameI18n } from "./names";

/**
 * Label keys computed by the database (public.availability_label): one rule for every shop,
 * the quantity exactly as in the shop's file ("12 ks na sklade"), sold out at 0 or less.
 */
export type AvailabilityKey = "in_stock_count" | "out_of_stock";

export type FreshnessState = "current" | "recent" | "stale";

/** One row of public.search_stock(). */
export interface StockRow {
  item_id: string;
  item_name: string;
  ean: string | null;
  brand: string | null;
  shop_id: string;
  shop_slug: string;
  shop_name: string;
  shop_address: string | null;
  shop_city: string | null;
  shop_country: string | null;
  shop_timezone: string | null;
  shop_lat: number | null;
  shop_lng: number | null;
  price: number | null;
  currency: string;
  quantity: number | null;
  availability: AvailabilityKey | null;
  is_available: boolean;
  freshness_state: FreshnessState;
  freshness_age_minutes: number | null;
  latest_file_time: string | null;
  updated_at: string | null;
  /** NULL when the visitor's location is unknown. */
  distance_km: number | null;
  /** Language of the name as the shop wrote it, and the name in sk/hu/en (null until translated). */
  item_name_lang: string | null;
  item_name_i18n: NameI18n | null;
}

/** The quantity as in the file, written the page language's way (12,5 / 12.5). */
export function formatQuantity(quantity: number | null, locale?: string): string {
  if (quantity === null || quantity === undefined) return "";
  const value = Number(quantity);
  if (!locale) return String(value);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value);
}

/** Availability text. Null when stale: the page shows the stale text instead. */
export function availabilityText(
  dict: Dictionary,
  key: AvailabilityKey | null,
  quantity: number | null,
  locale?: string,
): string | null {
  if (!key) return null;
  return t(dict.stock[key], { n: formatQuantity(quantity, locale) });
}

/** "Updated 8 min ago", "Last confirmed today at 14:05" (shop's local time), or the stale text. */
export function freshnessText(
  dict: Dictionary,
  state: FreshnessState,
  ageMinutes: number | null,
  latestFileTime: string | null,
  timeZone: string | null,
  now: Date = new Date(),
): string {
  if (state === "stale" || !latestFileTime) return dict.stock.stale;
  if (state === "current" && (ageMinutes ?? 0) < 30) return t(dict.stock.updated_ago, { n: ageMinutes ?? 0 });

  const fileTime = new Date(latestFileTime);
  const time = formatTime(fileTime, timeZone);
  const day = localDay(fileTime, timeZone);
  if (day === localDay(now, timeZone)) return t(dict.stock.confirmed_today, { time });
  // "recent" is under 24 h: today or yesterday. A restaurant's stock (update 86) is "current" at any age, so an older
  // day gets its date ("Naposledy zmenené 3. 11. o 14:20"), never "pred 4320 min".
  if (state === "recent" || day === localDay(new Date(now.getTime() - 86_400_000), timeZone)) {
    return t(dict.stock.confirmed_yesterday, { time });
  }
  const [, month, date] = day.split("-");
  return t(dict.stock.changed_on, { day: String(Number(date)), month: String(Number(month)), time });
}
