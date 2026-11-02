/**
 * "Sklad v Cacaduu" (database update 67): the rules the pages, the scanner and the exports share. The database decides
 * every stock number (sklad_stock, sklad_apply, owner_sklad_*); this file only formats, checks a form before it is sent
 * and recognises a barcode scanner's key burst. Shared with `sklad_test.ts` (`npm run test:sklad`).
 */

export const SKLAD_KINDS = ["receipt", "sale", "writeoff", "count", "correction", "transfer"] as const;
export type SkladKind = (typeof SKLAD_KINDS)[number];
export const SKLAD_UNITS = ["ks", "l", "kg", "m"] as const;
export type SkladUnit = (typeof SKLAD_UNITS)[number];

/** The four forms of the product card (+ "Oprava"): what the owner types is always a positive amount, except Oprava. */
export const CARD_ACTIONS = ["receipt", "sale", "writeoff", "transfer", "correction"] as const;
export type CardAction = (typeof CARD_ACTIONS)[number];

export const isKind = (v: unknown): v is SkladKind => typeof v === "string" && (SKLAD_KINDS as readonly string[]).includes(v);
export const isCardAction = (v: unknown): v is CardAction => typeof v === "string" && (CARD_ACTIONS as readonly string[]).includes(v);
export const isUnit = (v: unknown): v is SkladUnit => typeof v === "string" && (SKLAD_UNITS as readonly string[]).includes(v);

/** "12,5" or "12.5" → 12.5; up to 3 decimals; anything else → null. */
export function parseAmount(raw: unknown): number | null {
  const s = String(raw ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d{1,10}(\.\d{1,3})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "24,90" → 24.9 (a price: ≥ 0, up to 4 decimals); empty → null; invalid → NaN. */
export function parsePrice(raw: unknown): number | null {
  const s = String(raw ?? "").trim().replace(/\s/g, "").replace("€", "").replace(",", ".");
  if (s === "") return null;
  if (!/^\d{1,10}(\.\d{1,4})?$/.test(s)) return Number.NaN;
  return Number(s);
}

/**
 * Checks a card form before it goes to owner_sklad_move: the amount (positive; Oprava signed and non-zero), the reason
 * Odpis and Oprava need, a different target for Presun. Returns an error key (the page's text) or null.
 */
export function checkMove(action: CardAction, amount: number | null, opts: { reason?: string; from?: string; to?: string; cost?: number | null }) {
  if (amount === null) return "qty";
  if (action === "correction" ? amount === 0 : amount <= 0) return "qty";
  if ((action === "writeoff" || action === "correction") && !opts.reason?.trim()) return "reason";
  if (action === "transfer" && (!opts.to || opts.to === opts.from)) return "to_location";
  if (opts.cost !== undefined && opts.cost !== null && (Number.isNaN(opts.cost) || opts.cost < 0)) return "unit_cost";
  return null;
}

/** The sign a movement has in the stock (transfers move between locations and keep the total). */
export function totalEffect(kind: SkladKind, qty: number): number {
  return kind === "transfer" ? 0 : qty;
}

/** Price without VAT from the price with VAT. */
export function netPrice(gross: number, vatRate: number): number {
  return Math.round((gross / (1 + vatRate / 100)) * 100) / 100;
}

/**
 * The margin of one piece from the average cost (both without VAT): amount and % of the net sale price. Null when a
 * price or the cost is missing.
 */
export function margin(gross: number | null, vatRate: number, cost: number | null): { amount: number; percent: number } | null {
  if (gross === null || cost === null || gross <= 0) return null;
  const net = netPrice(gross, vatRate);
  if (net <= 0) return null;
  const amount = Math.round((net - cost) * 100) / 100;
  return { amount, percent: Math.round(((net - cost) / net) * 1000) / 10 };
}

/** The value of the stock at the average cost (never negative). */
export function stockValue(total: number, avgCost: number | null): number | null {
  if (avgCost === null) return null;
  return Math.round(Math.max(total, 0) * avgCost * 100) / 100;
}

/** "12 ks", "0,5 l": the amount in the page's language with the unit. */
export function formatQty(n: number, unit: string, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(n)} ${unit}`;
}

/** "+12", "−2" (a real minus sign), "4" for a transfer. */
export function signedQty(kind: SkladKind, qty: number, locale: string): string {
  const f = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(Math.abs(qty));
  if (kind === "transfer") return f;
  return qty > 0 ? `+${f}` : `−${f}`;
}

/** The stock dot of a Sklad row: green in stock, red sold out (the same colours as every price on the site). */
export function dotState(total: number): "in" | "out" {
  return total > 0 ? "in" : "out";
}

/** Minutes until the stock on the shop page turns stale (24 h after the last movement or confirmation); ≥ 0. */
export function minutesLeft(freshUntil: string | null, now: Date): number {
  if (!freshUntil) return 0;
  return Math.max(0, Math.floor((Date.parse(freshUntil) - now.getTime()) / 60_000));
}

/** "9 h 35 min", "35 min", "0 min". */
export function hoursMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** "08:00" (the reminder time as the time input sends it) or null. */
export function cleanTime(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

// ---------------------------------------------------------------- the barcode scanner as a keyboard

/** A scanned code: 6–64 letters, digits, "-", "." or "/" (EAN-8, EAN-13, Code128 values, the shop's own codes). */
export const SCAN_CODE = /^[0-9A-Za-z./-]{6,64}$/;

/**
 * A barcode scanner types fast: every key within 50 ms of the one before, then Enter. A person types slower. Feed every
 * key (its `key` and time in ms); a finished burst returns the code, anything else null. `reset()` on blur or a click.
 */
export class ScanBurst {
  private chars = "";
  private last = 0;
  constructor(private readonly gapMs = 50, private readonly minLength = 6) {}

  reset() {
    this.chars = "";
    this.last = 0;
  }

  /** The characters seen in the current burst (so a search field can drop them when a scan is recognised). */
  get pending() {
    return this.chars;
  }

  feed(key: string, timeMs: number): string | null {
    const quick = this.last > 0 && timeMs - this.last <= this.gapMs;
    if (key === "Enter") {
      const code = this.chars;
      const ok = quick && code.length >= this.minLength && SCAN_CODE.test(code);
      this.reset();
      return ok ? code : null;
    }
    if (key.length !== 1) {
      // Shift and other keys without a character keep the burst going (scanners send Shift for letters)
      if (key !== "Shift") this.reset();
      return null;
    }
    if (!quick) this.chars = "";
    this.chars += key;
    this.last = timeMs;
    return null;
  }
}

// ---------------------------------------------------------------- the exports (rows for the built-in xlsx writer)

export interface SkladRow {
  id: string;
  name: string;
  code: string;
  ean: string | null;
  sale_price: number | null;
  min_qty: number;
  unit: string;
  shelf: string | null;
  total: number;
  locations: { location_id: string; name: string; qty: number }[];
  is_out: boolean;
  is_low: boolean;
  no_price: boolean;
}

export interface MovementRow {
  id: string;
  item_id: string;
  item_name: string;
  code: string;
  kind: SkladKind;
  qty: number;
  location: string;
  to_location: string | null;
  unit_cost: number | null;
  reason: string | null;
  ref: string | null;
  device_label: string | null;
  created_at: string;
  client_at: string | null;
}

const num = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

/** "Produkty (XLSX)": one row per product, one column per location (the names as the owner wrote them). */
export function productsSheet(rows: SkladRow[], head: { name: string; code: string; ean: string; unit: string; price: string; min: string; shelf: string; total: string }) {
  const locations = [...new Map(rows.flatMap((r) => r.locations).map((l) => [l.location_id, l.name])).entries()];
  const header = [head.name, head.code, head.ean, head.unit, head.price, head.min, head.shelf, ...locations.map(([, n]) => n), head.total];
  const body = rows.map((r) => [
    r.name,
    r.code,
    r.ean ?? "",
    r.unit,
    num(r.sale_price),
    num(r.min_qty),
    r.shelf ?? "",
    ...locations.map(([id]) => num(r.locations.find((l) => l.location_id === id)?.qty ?? 0)),
    num(r.total),
  ]);
  return [header, ...body];
}

/** "Pohyby (XLSX)": the time in the shop's time zone, the kind in words, the signed amount, no private cost column unless asked. */
export function movementsSheet(
  rows: MovementRow[],
  head: { time: string; product: string; code: string; kind: string; qty: string; location: string; to: string; cost: string; reason: string; ref: string; device: string },
  kinds: Record<SkladKind, string>,
  timeZone: string,
) {
  const time = (iso: string) =>
    new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(new Date(iso))
      .replace(",", "");
  const header = [head.time, head.product, head.code, head.kind, head.qty, head.location, head.to, head.cost, head.reason, head.ref, head.device];
  const body = rows.map((m) => [
    time(m.created_at),
    m.item_name,
    m.code,
    kinds[m.kind] ?? m.kind,
    num(m.qty),
    m.location,
    m.to_location ?? "",
    num(m.unit_cost),
    m.reason ?? "",
    m.ref ?? "",
    m.device_label ?? "",
  ]);
  return [header, ...body];
}
