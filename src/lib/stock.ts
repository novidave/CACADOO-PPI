import type { Dictionary } from "@/i18n/dictionaries";
import { t } from "@/i18n/dictionaries";
import { formatTime, localDay } from "./format";
import type { NameI18n } from "./names";

/** Label keys computed by the database (public.availability_label). */
export type AvailabilityKey =
  | "in_stock_count"
  | "in_stock"
  | "low_stock"
  | "out_of_stock"
  | "available"
  | "not_available";

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

/** Availability text. Null when stale: the page shows the stale text instead. */
export function availabilityText(
  dict: Dictionary,
  key: AvailabilityKey | null,
  quantity: number | null,
): string | null {
  if (!key) return null;
  return t(dict.stock[key], { n: quantity ?? "" });
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
  if (state === "current") return t(dict.stock.updated_ago, { n: ageMinutes ?? 0 });

  const fileTime = new Date(latestFileTime);
  const time = formatTime(fileTime, timeZone);
  return localDay(fileTime, timeZone) === localDay(now, timeZone)
    ? t(dict.stock.confirmed_today, { time })
    : t(dict.stock.confirmed_yesterday, { time });
}
