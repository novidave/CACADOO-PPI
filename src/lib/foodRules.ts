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

/** The next steps an owner may take from a status (the same list as food_step_allowed() in SQL). */
export function nextSteps(kind: OrderKind, status: OrderStatus): OrderStatus[] {
  if (status === "new") return kind === "delivery" ? ["preparing", "on_the_way", "cancelled"] : ["preparing", "ready", "cancelled"];
  if (status === "preparing") return kind === "delivery" ? ["on_the_way", "cancelled"] : ["ready", "cancelled"];
  if (status === "on_the_way") return ["delivered", "cancelled"];
  if (status === "ready") return ["picked_up", "cancelled"];
  return [];
}
