import { STOCK_COLORS, stockState, type StockState } from "@/lib/stockDot";

/**
 * The stock dot before a price (at the owner's request, 2026-10-27): green = in stock, red = sold out, yellow = no
 * information (stale data). Like the status dots: white outline + thin dark ring, and always next to the availability
 * in words (never colour alone), so it is hidden from screen readers. `availability` = the database's key, or `state`.
 */
export function StockDot({ availability, state, size = 10 }: { availability?: string | null; state?: StockState; size?: number }) {
  const s = state ?? stockState(availability);
  return (
    <span
      aria-hidden="true"
      data-stock-dot={s}
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: STOCK_COLORS[s], border: "2px solid #fff", boxShadow: "0 0 0 1px #171717", boxSizing: "content-box" }}
    />
  );
}
