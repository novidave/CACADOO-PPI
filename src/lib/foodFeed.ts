/**
 * Objednávky jedla (database update 81; since 2026-11-07 the kitchen board is the only view — no feed): the pure rules
 * the board and its green bar draw with — the order and the grouping of the cards, the time labels, which tags a card
 * shows for the parts a shop uses, the swipe threshold, what a finish needs first, the steppers, the phone's first
 * column and the "Čo používate" summary.
 * No imports (the Deno tests read it). Every decision about an order stays in SQL (owner_food_feed, food_order_finish,
 * food_order_reopen, food_times); this file only draws what they return.
 */

export type FeedKind = "pickup" | "delivery";
export type FeedStatus = "new" | "preparing" | "on_the_way" | "ready" | "delivered" | "picked_up" | "cancelled";
export type FeedPay = "qr" | "cash" | "card";

/** food_parts(): what the shop uses (courier_app needs delivery, qr_terminal needs payments — decided in SQL). */
export interface FeedParts {
  delivery: boolean;
  courier_app: boolean;
  payments: boolean;
  register: boolean;
  qr_terminal: boolean;
  on: number;
}

/** food_times(): the one time rule (pickup = prep + delay, delivery = the estimate + delay). */
export interface FeedTimes {
  prep_minutes: number;
  delivery_minutes: number;
  delay_minutes: number;
  delay_reset: "close" | "midnight" | "never";
  warn_long_delay: boolean;
  ready_pickup_min: number;
  ready_delivery_min: number;
  long_delay: boolean;
}

/** One card as owner_food_feed returns it (the fields the feed reads). */
export interface FeedOrder {
  id: string;
  number: number;
  kind: FeedKind;
  status: FeedStatus;
  created_at: string;
  ready_by: string;
  done_at: string | null;
  finish_to?: FeedStatus;
  pay_method: FeedPay | null;
  paid_at: string | null;
  courier_id?: string | null;
  courier_name?: string | null;
  address: string | null;
  /** update 87: the delivery zone's label the customer picked (null without zones) */
  zone_name?: string | null;
}

/** Past this share of the card's width a swipe finishes (or reopens); less springs back. */
export const SWIPE_FLING = 0.3;
/** The delay chips above the feed (one tap saves). */
export const DELAYS = [0, 10, 20, 30, 45] as const;
/** The steppers' limits (Príprava, Donáška; steps of 5). */
export const PREP_RANGE = { min: 5, max: 120, step: 5 } as const;
export const DELIVERY_RANGE = { min: 10, max: 180, step: 5 } as const;

/** "{n}" and friends filled in a text from the message files. */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** A swipe's outcome: 1 / -1 = flew out right / left, 0 = springs back. */
export function swipeOutcome(dx: number, width: number): -1 | 0 | 1 {
  if (!Number.isFinite(dx) || !(width > 0)) return 0;
  if (Math.abs(dx) <= width * SWIPE_FLING) return 0;
  return dx > 0 ? 1 : -1;
}

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/** Where "Vybavené" takes an order (the same as SQL's food_finish_target, for drawing only). */
export function finishTarget(o: Pick<FeedOrder, "kind" | "finish_to">, parts: Pick<FeedParts, "courier_app">): FeedStatus {
  if (o.finish_to) return o.finish_to;
  if (o.kind === "pickup") return "picked_up";
  return parts.courier_app ? "on_the_way" : "delivered";
}

/** The active cards: newest on top (or oldest, by feed_order); the same minute → the day's number decides. */
export function sortActive<T extends Pick<FeedOrder, "created_at" | "number">>(list: T[], order: "newest" | "oldest"): T[] {
  const dir = order === "oldest" ? 1 : -1;
  return [...list].sort((a, b) => dir * (time(a.created_at) - time(b.created_at) || a.number - b.number));
}

/** The grey rows: the latest finished first. */
export function sortDone<T extends Pick<FeedOrder, "done_at" | "number">>(list: T[]): T[] {
  return [...list].sort((a, b) => time(b.done_at) - time(a.done_at) || b.number - a.number);
}

/**
 * What "Vybavené" opens first: the courier ("Prideliť") when the order goes on the way without one, else the payment
 * choice while the shop takes payments and the order has no payment mark yet; null = it finishes at once.
 */
export function finishNeeds(
  o: Pick<FeedOrder, "kind" | "finish_to" | "courier_id" | "paid_at">,
  parts: Pick<FeedParts, "courier_app" | "payments">,
): "courier" | "payment" | null {
  const to = finishTarget(o, parts);
  if (to === "on_the_way") return o.courier_id ? null : "courier";
  if (parts.payments && !o.paid_at) return "payment";
  return null;
}

/** The payment methods the choice offers: only those switched on (QR also needs the IBAN in Sklad). */
export function payMethods(s: { pay_qr: boolean; pay_cash: boolean; pay_card: boolean; iban_set: boolean }, parts: Pick<FeedParts, "payments">): FeedPay[] {
  if (!parts.payments) return [];
  return [s.pay_qr && s.iban_set ? "qr" : null, s.pay_cash ? "cash" : null, s.pay_card ? "card" : null].filter(
    (m): m is FeedPay => m !== null,
  );
}

/** A grey row can go back ("Vrátiť") when it was picked up, delivered or handed to the courier — never a cancelled one. */
export function reopenable(o: Pick<FeedOrder, "status">): boolean {
  return o.status === "picked_up" || o.status === "delivered" || o.status === "on_the_way";
}

/** − / + on a stepper: steps of 5 inside its range. */
export function stepMinutes(value: number, delta: number, range: { min: number; max: number; step: number }): number {
  const next = Math.round((value + delta) / range.step) * range.step;
  return Math.min(range.max, Math.max(range.min, next));
}

/**
 * "Čo používate" in one line: only the feed ("Len feed objednávok"), the feed with delivery only, or "Zapnuté n z 5".
 */
export function partsSummary(parts: FeedParts): { kind: "feed_only" } | { kind: "feed_delivery" } | { kind: "some"; n: number } {
  if (parts.on === 0) return { kind: "feed_only" };
  if (parts.on === 1 && parts.delivery) return { kind: "feed_delivery" };
  return { kind: "some", n: parts.on };
}

/**
 * The texts the board's client parts need (the green bar, the finish / payment / courier dialogs, Vrátiť, the toast,
 * the older orders); the page picks them from the message files' `food` namespace (2026-11-07: the feed is gone).
 */
export const BOARD_KEYS = [
  "bar_label", "bar_says", "bar_says_pickup", "bar_says_delivery", "bar_close", "bar_open", "bar_closed_title",
  "feed_prep", "feed_delivery", "feed_delay", "feed_minutes", "feed_less", "feed_more", "feed_delay_chip",
  "feed_says_long", "feed_synced", "feed_paused_text", "feed_reopen", "feed_reopen_label", "feed_done_at",
  "feed_on_way_at", "feed_cancelled", "feed_older", "feed_older_title", "feed_pickup_short", "feed_delivery_short",
  "feed_toast_done", "feed_toast_on_way", "feed_toast_back", "feed_undo", "feed_pay_title", "feed_pay_finish",
  "feed_show_qr", "feed_qr_loading", "feed_qr_none", "feed_qr_line", "feed_qr_alt", "feed_qr_full", "feed_assign_title",
  "feed_assign_finish", "feed_no_couriers", "feed_close", "feed_saved", "feed_failed",
  "pay_qr", "pay_cash", "pay_card", "paid_short", "cash_title", "cash_exact", "cash_other", "cash_change", "cash_hint",
  "accepting", "not_accepting_off", "not_accepting_paused", "not_accepting_closed", "not_accepting_cutoff",
  "not_accepting_sms_quota", "ok_sms", "err_sms_failed", "err_failed", "err_step", "err_not_paid", "err_cash",
  "err_already_paid", "err_pay_method", "err_no_plan", "err_not_found", "err_conflict", "err_courier", "err_courier_app",
  "err_too_late", "err_delay", "err_settings", "detail",
] as const;
export type BoardLabelsOf = Record<(typeof BOARD_KEYS)[number], string>;

/**
 * The kitchen board on a phone or a tablet (< 1024 px): one column at a time. The segmented row starts on Nové; when
 * Nové is empty, on the next column that has orders (else Nové).
 */
export type BoardColumn = "new" | "preparing" | "on_the_way" | "done";
export const BOARD_COLUMNS: BoardColumn[] = ["new", "preparing", "on_the_way", "done"];
export function firstColumn(counts: Record<BoardColumn, number>): BoardColumn {
  return BOARD_COLUMNS.find((c) => counts[c] > 0) ?? "new";
}

/** The moment the server drew the page (the bar's first labels use it, so the first paint matches the server's). */
export const drawnAt = () => Date.now();
