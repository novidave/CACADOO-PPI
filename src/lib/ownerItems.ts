import type { AvailabilityKey, FreshnessState } from "./stock";

/**
 * Môj obchod → Jazyky a inventár → "Tovar" (update 41): the filters and the column "Čo vidí zákazník". The database
 * decides every state (availability_label(), freshness_state(), owner_items()); these only pick the words for it.
 */

export const ITEM_FILTERS = ["all", "in_stock", "sold_out", "no_description", "missing_translation"] as const;
export type ItemFilter = (typeof ITEM_FILTERS)[number];

/** The filter from the address (?filter=); anything else is "Všetko". */
export function itemFilter(value: string | string[] | undefined): ItemFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return (ITEM_FILTERS as readonly string[]).includes(v ?? "") ? (v as ItemFilter) : "all";
}

/**
 * What the shopper sees for one item: nothing while the data is stale (the database gives no availability then),
 * "Vypredané" at 0 or less, otherwise the quantity exactly as in the file ("22 ks na sklade").
 */
export type ShopperView = "hidden_stale" | "sold_out" | "in_stock";

export function shopperView(availability: AvailabilityKey | null): ShopperView {
  if (availability === null || availability === undefined) return "hidden_stale";
  return availability === "out_of_stock" ? "sold_out" : "in_stock";
}

/** The status line above the list: "Posledný súbor: <date> · aktuálny / starší / zastaraný", or no file yet. */
export type FileStatus = { kind: "none" } | { kind: "file"; at: string; state: FreshnessState };

export function fileStatus(latestFileTime: string | null | undefined, state: FreshnessState | null | undefined): FileStatus {
  if (!latestFileTime) return { kind: "none" };
  return { kind: "file", at: latestFileTime, state: state ?? "stale" };
}

export interface ItemCounts {
  all_items: number;
  in_stock: number;
  sold_out: number;
  no_description: number;
  missing_translation: number;
}

/** The number next to a filter (the database's count for it). */
export function filterCount(counts: ItemCounts | null, filter: ItemFilter): number | null {
  if (!counts) return null;
  return Number(filter === "all" ? counts.all_items : counts[filter]);
}
