import type { Dictionary } from "@/i18n/dictionaries";
import { availabilityText, freshnessText, type AvailabilityKey, type FreshnessState } from "@/lib/stock";

/**
 * "12 ks na sklade · Aktualizované pred 10 min", or only the stale text — on the product page. In a listing
 * (`listing`, 2026-10-29: the stock sentence only on the product page, the stock dot carries it) only how fresh the
 * data are ("Aktualizované pred 10 min"), and nothing for stale data.
 */
export function StockLine({
  row,
  timeZone,
  dict,
  lang,
  listing = false,
}: {
  row: {
    availability: AvailabilityKey | null;
    quantity: number | null;
    freshness_state: FreshnessState;
    freshness_age_minutes: number | null;
    latest_file_time: string | null;
  };
  timeZone: string | null;
  dict: Dictionary;
  lang?: string;
  listing?: boolean;
}) {
  if (listing) {
    if (row.freshness_state === "stale" || !row.latest_file_time) return null;
    return <span className="text-muted">{freshnessText(dict, row.freshness_state, row.freshness_age_minutes, row.latest_file_time, timeZone)}</span>;
  }
  const availability = availabilityText(dict, row.availability, row.quantity, lang);
  const freshness = freshnessText(dict, row.freshness_state, row.freshness_age_minutes, row.latest_file_time, timeZone);
  return (
    <span>
      {availability && <span className="font-semibold">{availability} · </span>}
      <span className={availability ? "text-muted" : ""}>{freshness}</span>
    </span>
  );
}
