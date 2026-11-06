/**
 * The order card's round quantity stepper (2026-11-06, at the owner's request): the rules only, no imports, so the
 * tests (`food_test.ts`, `npm run test:food`) and the browser share them.
 *  - one tap / Enter / Space = one step;
 *  - holding + or − repeats: first after 380 ms, then every 150 ms getting faster (× 0.82) down to 55 ms;
 *  - a hold on − stops at 1 (removing the last piece is a tap of its own);
 *  - + stops at the order's maximum (50 pieces a line, as food_quote allows).
 */

/** The most pieces of one line in an order (food_quote refuses more). */
export const QTY_MAX = 50;
/** How long a press must last before it repeats. */
export const HOLD_DELAY = 380;
/** The first repeat's pause, how it shrinks and the shortest one. */
export const HOLD_FIRST = 150;
export const HOLD_FACTOR = 0.82;
export const HOLD_FLOOR = 55;
/** The pause after the last change before the price is asked again (not on every repeat of a hold). */
export const REQUOTE_AFTER = 300;
/** How long "Najviac 50 ks na objednávku" stays. */
export const MAX_TIP_MS = 1600;

/** The pause before repeat number `n` (0 = the wait before the first repeat). */
export function holdDelay(n: number): number {
  if (n <= 0) return HOLD_DELAY;
  return Math.max(HOLD_FLOOR, Math.round(HOLD_FIRST * HOLD_FACTOR ** (n - 1)));
}

export interface QtyStep {
  /** The new quantity (0 = the line is removed). */
  qty: number;
  /** Nothing changed because the maximum is reached (the + is greyed, the tip shows). */
  capped: boolean;
  /** The line goes away (a tap on the bin at 1). */
  removed: boolean;
  /** A hold should stop repeating (at 1 going down, at the maximum going up). */
  stop: boolean;
}

/** One step of a line: `delta` +1 or −1; `hold` = a repeat of a held press (never removes the last piece). */
export function stepQty(qty: number, delta: 1 | -1, hold = false, max = QTY_MAX): QtyStep {
  const now = Math.max(0, Math.min(max, Math.floor(qty)));
  if (delta > 0) {
    if (now >= max) return { qty: max, capped: true, removed: false, stop: true };
    const next = now + 1;
    return { qty: next, capped: false, removed: false, stop: next >= max };
  }
  if (now <= 1) {
    if (hold) return { qty: Math.max(1, now), capped: false, removed: false, stop: true };
    return { qty: 0, capped: false, removed: true, stop: true };
  }
  const next = now - 1;
  return { qty: next, capped: false, removed: false, stop: hold && next <= 1 };
}

/** What the − circle shows: the bin at 1 (the next tap removes the line), "−" from 2. */
export const minusIcon = (qty: number): "bin" | "minus" => (qty <= 1 ? "bin" : "minus");
