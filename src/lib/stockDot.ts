/**
 * The stock dot (at the owner's request, 2026-10-27; colours of the shop page's list, 2026-10-29): in stock (green),
 * sold out (red), no information (yellow: the shop's data are stale or there is no quantity) — a solid fill with a
 * darker ring of the same hue. In product listings the dot is the only stock sign (the sentence is only on the product
 * page), so it carries the status in words for screen readers. No imports: also used by client components.
 */
export type StockState = "available" | "sold_out" | "no_info";

export function stockState(key: string | null | undefined): StockState {
  return key === "in_stock_count" ? "available" : key === "out_of_stock" ? "sold_out" : "no_info";
}

export const STOCK_COLORS: Record<StockState, string> = { available: "#22C55E", sold_out: "#EF4444", no_info: "#F5B70A" };
export const STOCK_BORDERS: Record<StockState, string> = { available: "#15803D", sold_out: "#B91C1C", no_info: "#B7860B" };

/** The message key (namespace `stock`) of the dot's status in words: "na sklade", "vypredané", "zásoba neznáma". */
export const STOCK_WORDS = { available: "dot_available", sold_out: "dot_sold_out", no_info: "dot_no_info" } as const;
