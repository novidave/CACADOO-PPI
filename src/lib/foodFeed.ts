/**
 * The order feed of Objednávky jedla (database update 81): the pure rules the feed screen draws with — the order and
 * the grouping of the cards, the time labels ("o 20 min", "teraz", "pred 5 min"), which tags a card shows for the
 * parts a shop uses, the swipe threshold, what a finish needs first, the steppers and the "Čo používate" summary.
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

/** Active (no done_at) and done (finished, handed to the courier, cancelled), each in its own order. */
export function splitFeed<T extends FeedOrder>(list: T[], order: "newest" | "oldest"): { active: T[]; done: T[] } {
  return { active: sortActive(list.filter((o) => !o.done_at), order), done: sortDone(list.filter((o) => Boolean(o.done_at))) };
}

/** "o 20 min" until the order should be ready, or "teraz" once that time came. */
export function dueLabel(readyBy: string, now: number): { kind: "in"; n: number } | { kind: "now" } {
  const ms = time(readyBy) - now;
  if (!Number.isFinite(ms) || ms <= 0) return { kind: "now" };
  return { kind: "in", n: Math.ceil(ms / 60_000) };
}

/** "pred 5 min" since the order came, or "teraz" in its first minute. */
export function agoLabel(createdAt: string, now: number): { kind: "ago"; n: number } | { kind: "now" } {
  const ms = now - time(createdAt);
  if (!Number.isFinite(ms) || ms < 60_000) return { kind: "now" };
  return { kind: "ago", n: Math.floor(ms / 60_000) };
}

/**
 * Which tags a card shows: the payment only with "Platby v Cacaduu", the courier's name only with the courier app,
 * the address only for a delivery that has one.
 */
export function cardTags(o: Pick<FeedOrder, "kind" | "address" | "courier_name" | "pay_method">, parts: Pick<FeedParts, "payments" | "courier_app">) {
  return {
    pay: parts.payments && o.pay_method !== null,
    courier: parts.courier_app && Boolean(o.courier_name),
    address: o.kind === "delivery" && Boolean(o.address),
  };
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

/** The cards that were not there before (they slide in, with the sound for new orders). */
export function freshIds(seen: ReadonlySet<string>, list: Pick<FeedOrder, "id">[]): string[] {
  return list.filter((o) => !seen.has(o.id)).map((o) => o.id);
}

/**
 * "Čo používate" in one line: only the feed ("Len feed objednávok"), the feed with delivery only, or "Zapnuté n z 5".
 */
export function partsSummary(parts: FeedParts): { kind: "feed_only" } | { kind: "feed_delivery" } | { kind: "some"; n: number } {
  if (parts.on === 0) return { kind: "feed_only" };
  if (parts.on === 1 && parts.delivery) return { kind: "feed_delivery" };
  return { kind: "some", n: parts.on };
}

/** The texts the feed screen needs (the page picks them from the message files' `food` namespace). */
export const FEED_KEYS = [
  "feed_prep", "feed_delivery", "feed_delay", "feed_minutes", "feed_less", "feed_more", "feed_delay_chip", "feed_says",
  "feed_says_pickup", "feed_says_delivery", "feed_says_long", "feed_synced", "feed_paused_title", "feed_paused_text",
  "feed_pause", "feed_resume", "feed_active", "feed_hint", "feed_finish", "feed_finish_label", "feed_new", "feed_pickup_at",
  "feed_delivery_by", "feed_in", "feed_now", "feed_ago", "feed_note", "feed_courier", "feed_not_paid", "feed_empty_title",
  "feed_empty_text", "feed_done_today", "feed_done_hint", "feed_reopen", "feed_reopen_label", "feed_done_at",
  "feed_on_way_at", "feed_cancelled", "feed_older", "feed_older_title", "feed_pickup_short", "feed_delivery_short",
  "feed_toast_done", "feed_toast_on_way", "feed_toast_back", "feed_undo", "feed_pay_title", "feed_pay_finish",
  "feed_show_qr", "feed_qr_loading", "feed_qr_none", "feed_qr_line", "feed_qr_alt", "feed_qr_full", "feed_assign_title", "feed_assign_finish", "feed_no_couriers", "feed_close", "feed_saved", "feed_failed",
  "pay_qr", "pay_cash", "pay_card", "paid_short", "cash_title", "cash_exact", "cash_other", "cash_change", "cash_hint",
  "accepting", "not_accepting_off", "not_accepting_paused", "not_accepting_closed", "not_accepting_cutoff",
  "not_accepting_sms_quota", "ok_sms", "err_sms_failed", "err_failed", "err_step", "err_not_paid", "err_cash",
  "err_already_paid", "err_pay_method", "err_no_plan", "err_not_found", "err_conflict", "err_courier", "err_courier_app",
  "err_too_late", "err_delay", "err_settings", "detail",
] as const;
export type FeedLabels = Record<(typeof FEED_KEYS)[number], string>;

/** "Feed | Stĺpce" per device (localStorage); the page sets <html data-food-view> with this before the first paint. */
export const FOOD_VIEW_KEY = "ppi.food.view";
export const FOOD_VIEW_BOOT = `(function(){try{var q=new URLSearchParams(location.search).get('view');var v=q==='columns'||q==='feed'?q:null;if(v){localStorage.setItem('${FOOD_VIEW_KEY}',v)}else{v=localStorage.getItem('${FOOD_VIEW_KEY}')}if(v==='columns'||v==='feed'){document.documentElement.setAttribute('data-food-view',v)}}catch(e){}})();`;

/** The moment the server drew the page (the feed's first labels use it, so the first paint matches the server's). */
export const drawnAt = () => Date.now();
