/**
 * The stock dot before a price (at the owner's request, 2026-10-27): in stock (green), sold out (red), no information
 * (yellow: the shop's data are stale or there is no quantity). No imports: also used by client components.
 */
export type StockState = "available" | "sold_out" | "no_info";

export function stockState(key: string | null | undefined): StockState {
  return key === "in_stock_count" ? "available" : key === "out_of_stock" ? "sold_out" : "no_info";
}

export const STOCK_COLORS: Record<StockState, string> = { available: "#1E9E5A", sold_out: "#D64545", no_info: "#F2B705" };
