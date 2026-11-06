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
export type ShopperView = "hidden_stale" | "sold_out" | "in_stock" | "in_menu";

/** The owner's availability of an item: the shopper's key, or (update 86) "in_menu" for a dish without stock tracking. */
export type OwnerAvailability = AvailabilityKey | "in_menu";

export function shopperView(availability: OwnerAvailability | null): ShopperView {
  if (availability === null || availability === undefined) return "hidden_stale";
  if (availability === "in_menu") return "in_menu";
  return availability === "out_of_stock" ? "sold_out" : "in_stock";
}

/**
 * The status line above the list: "Posledný súbor: <date> · aktuálny / starší / zastaraný", no file yet, or (update 43)
 * the uploaded files were deleted and no file came since: "Žiadny nahraný súbor · nahrajte nový" (the stock's freshness
 * still runs out as usual, but a deleted file is never shown as present).
 */
/** The owner's freshness: the shopper's, or (update 86) "never_expires" for a restaurant (shown until changed). */
export type OwnerFreshness = FreshnessState | "never_expires";

export type FileStatus = { kind: "none" } | { kind: "cleared" } | { kind: "file"; at: string; state: OwnerFreshness };

export function fileStatus(
  latestFileTime: string | null | undefined,
  state: OwnerFreshness | null | undefined,
  filesCleared = false,
): FileStatus {
  if (filesCleared) return { kind: "cleared" };
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
