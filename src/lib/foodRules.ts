/**
 * "Objednávky jedla" (database update 73): small shared rules for the website, the courier screens and their tests.
 * Every decision (prices, zones, times, steps, the stock) is in SQL; these only read and show.
 */

export type OrderKind = "pickup" | "delivery";
export type PayMethod = "qr" | "cash" | "card";
export type OrderStatus = "new" | "preparing" | "on_the_way" | "ready" | "delivered" | "picked_up" | "cancelled";

export interface CartLine {
  item_id: string;
  qty: number;
  extras: string[];
}

/** The refusals the price rule and the order function return (texts `chat.order_err_<reason>`). */
export const ORDER_PROBLEMS = [
  "empty", "kind_off", "no_address", "outside_zone", "sold_out", "below_minimum", "not_accepting",
] as const;

/**
 * The town of a typed address, for a kilometre zone: the last comma part without its postcode
 * ("Okružná 14, 071 01 Michalovce" → "Michalovce"). Only this ever goes to the geocoder.
 */
export function townOf(address: string): string | null {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const last = parts.length > 1 ? parts[parts.length - 1] : parts[0] ?? "";
  const town = last.replace(/^\s*\d{3}\s?\d{2}\s*/, "").replace(/\s*\d{3}\s?\d{2}\s*$/, "").trim();
  return town.length >= 2 && /\p{L}/u.test(town) ? town.slice(0, 100) : null;
}

/** The cart the page sends: whole pieces 1–50, ≤ 10 extras, ≤ 30 lines (the same limits as the SQL). */
export function cleanCart(value: unknown): CartLine[] | null {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) return null;
  const out: CartLine[] = [];
  for (const raw of value) {
    const line = raw as { item_id?: unknown; qty?: unknown; extras?: unknown } | null;
    const id = String(line?.item_id ?? "");
    const qty = Math.floor(Number(line?.qty));
    const extras = Array.isArray(line?.extras) ? line.extras.map(String) : [];
    if (!UUID.test(id) || !Number.isFinite(qty) || qty < 1 || qty > 50 || extras.length > 10 || extras.some((x) => !UUID.test(x))) return null;
    out.push({ item_id: id, qty, extras });
  }
  return out;
}

/** The change to give in cents (never below zero); null while nothing was given. */
export function changeCents(totalCents: number, givenCents: number | null): number | null {
  if (givenCents === null || !Number.isFinite(givenCents)) return null;
  return Math.max(0, Math.round(givenCents) - Math.round(totalCents));
}

/** The cash screen's quick amounts (whole euros) that cover the total; "Presne" is the total itself. */
export const CASH_NOTES = [10, 20, 30, 40, 50, 100] as const;

export function cashChoices(totalCents: number): number[] {
  return CASH_NOTES.map((n) => n * 100).filter((c) => c >= totalCents);
}

/** Cents as the shop's money ("35,60 €" in sk). */
export function money(cents: number, locale: string, currency = "EUR"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

/** Slovak plural forms (1 položka, 2–4 položky, 5+ položiek) — `one` / `few` / `many` from the message files. */
export function plural(n: number, forms: { one: string; few: string; many: string }, locale = "sk"): string {
  const rule = new Intl.PluralRules(locale).select(n);
  const text = rule === "one" ? forms.one : rule === "few" ? forms.few : forms.many;
  return text.replace("{n}", String(n));
}

/** Where a delivery is: its point when the website geocoded one, else the address as the customer wrote it. */
export interface Place {
  lat: number | null;
  lng: number | null;
  address: string | null;
}

const placeOf = (o: Place) => (o.lat !== null && o.lng !== null ? `${o.lat},${o.lng}` : o.address?.trim() || null);

/** Google Maps directions to one delivery (the courier's "Navigovať"). */
export function directionsTo(o: Place): string | null {
  const place = placeOf(o);
  return place ? `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(place)}` : null;
}

/** "Navigovať celú trasu": the deliveries in order, the last one the destination, the rest waypoints (Google takes 9). */
export function routeUrl(orders: Place[]): string | null {
  const places = orders.map(placeOf).filter((p): p is string => Boolean(p));
  if (places.length === 0) return null;
  const destination = places[places.length - 1];
  const waypoints = places.slice(0, -1).slice(0, 9);
  const params = new URLSearchParams({ api: "1", travelmode: "driving", destination });
  if (waypoints.length) params.set("waypoints", waypoints.join("|"));
  return `https://www.google.com/maps/dir/?${params}`;
}

/** The next steps an owner may take from a status (the same list as food_step_allowed() in SQL). */
export function nextSteps(kind: OrderKind, status: OrderStatus): OrderStatus[] {
  if (status === "new") return kind === "delivery" ? ["preparing", "on_the_way", "cancelled"] : ["preparing", "ready", "cancelled"];
  if (status === "preparing") return kind === "delivery" ? ["on_the_way", "cancelled"] : ["ready", "cancelled"];
  if (status === "on_the_way") return ["delivered", "cancelled"];
  if (status === "ready") return ["picked_up", "cancelled"];
  return [];
}

// ------------------------------------------------------------------ update 85: the order panel

/**
 * The ways of receiving an order the panel offers, in their order: "Osobný odber" and — only while the shop uses
 * Donáška (food_state.delivery: on and with a zone) — "Donáška". One way = it is already chosen, nothing to pick.
 */
export function orderKinds(state: { pickup?: boolean; delivery?: boolean }): OrderKind[] {
  const kinds: OrderKind[] = [];
  if (state.pickup !== false) kinds.push("pickup");
  if (state.delivery) kinds.push("delivery");
  return kinds.length ? kinds : ["pickup"];
}

/** The way chosen first: the one the answer named when the shop offers it, else the first one offered. */
export function firstKind(wanted: OrderKind | null | undefined, kinds: OrderKind[]): OrderKind {
  return wanted && kinds.includes(wanted) ? wanted : kinds[0];
}

/**
 * The time line under the kind buttons: when the order is ready (pickup) or delivered, from the database's minutes
 * (food_state's ready_*_min, or food_quote's ready_minutes — both with today's delay; never the assistant's own
 * estimate), as a clock time in the shop's time zone.
 */
export function readyClock(nowMs: number, minutes: number, locale: string, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat(locale, { timeZone: timeZone || "UTC", hour: "2-digit", minute: "2-digit" })
    .format(new Date(nowMs + Math.max(0, minutes) * 60_000));
}

/** The owner's "-": no line under the time in the "Objednané" box. */
export const PAY_NOTE_NONE = "-";

/**
 * The line under the time in the "Objednané" box ("Poznámka k platbe po objednaní", food_settings.pay_note): no note
 * = the default line of the page language, "-" = no line, else the owner's text in the page language when it is
 * translated (a preset kind, so the shop's own language too), else as the owner wrote it.
 */
export function payNoteLine(raw: string | null | undefined, translated: string | null | undefined, fallback: string): string | null {
  const note = (raw ?? "").trim();
  if (!note) return fallback;
  if (note === PAY_NOTE_NONE) return null;
  return translated?.trim() || note;
}
