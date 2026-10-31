import { STOCK_BORDERS, STOCK_COLORS, stockState, type StockState } from "@/lib/stockDot";

/**
 * The stock dot before a price: green = in stock, red = sold out, yellow = no information (stale data), a solid fill
 * with a darker ring of the same hue. Next to the availability in words (the product page) it is hidden from screen
 * readers; in a listing, where it is the only stock sign, `label` gives it the status in words. `availability` = the
 * database's key, or `state`.
 */
export function StockDot({
  availability,
  state,
  size = 10,
  label,
}: {
  availability?: string | null;
  state?: StockState;
  size?: number;
  label?: string;
}) {
  const s = state ?? stockState(availability);
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      data-stock-dot={s}
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, aspectRatio: "1", background: STOCK_COLORS[s], border: `1.5px solid ${STOCK_BORDERS[s]}`, boxSizing: "border-box" }}
    />
  );
}
