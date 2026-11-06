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
  /** Update 86: false for a menu dish without "Sledovať zásobu" (not stock: no quantity, never low or out). */
  tracked?: boolean;
  /** Update 86: "Vypredané dnes" (the dish itself or the dish of a size). */
  sold_out_today?: boolean;
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

// ---------------------------------------------------------------- Predaj (database update 68)

export const PAYMENTS = ["cash", "card", "qr"] as const;
export type Payment = (typeof PAYMENTS)[number];
export const isPayment = (v: unknown): v is Payment => typeof v === "string" && (PAYMENTS as readonly string[]).includes(v);

/** A product the Predaj screen can sell (from owner_sklad_products). */
export interface SaleProduct {
  id: string;
  name: string;
  code: string | null;
  ean: string | null;
  price: number | null;
  total: number;
  min: number;
  unit: string;
  /** Update 86: an untracked dish is "V ponuke" / "Vypredané dnes", never a quantity or a stock warning. */
  tracked?: boolean;
  soldOutToday?: boolean;
}

export interface BasketLine {
  item_id: string;
  qty: number;
}

/** The basket kept in this browser for the shop: its own sale id, the lines, the payment, a QR sale waiting. */
export interface Basket {
  id: string;
  lines: BasketLine[];
  pay: Payment;
  pending: string | null;
}

const MAX_LINES = 200;
const MAX_QTY = 99_999;

/** One more piece (a new line at the end), never past 200 lines or 99 999 pieces. */
export function addToBasket(lines: BasketLine[], itemId: string, n = 1): BasketLine[] {
  const at = lines.findIndex((l) => l.item_id === itemId);
  if (at >= 0) return lines.map((l, i) => (i === at ? { ...l, qty: Math.min(MAX_QTY, l.qty + n) } : l));
  if (lines.length >= MAX_LINES) return lines;
  return [...lines, { item_id: itemId, qty: Math.min(MAX_QTY, n) }];
}

/** Sets a line's pieces; 0 or less removes it. */
export function setBasketQty(lines: BasketLine[], itemId: string, qty: number): BasketLine[] {
  if (!Number.isFinite(qty) || qty <= 0) return lines.filter((l) => l.item_id !== itemId);
  return lines.map((l) => (l.item_id === itemId ? { ...l, qty: Math.min(MAX_QTY, Math.round(qty * 1000) / 1000) } : l));
}

/** A stored basket read back (broken or foreign data → null). */
export function readBasket(raw: string | null, isId: (v: string) => boolean): Basket | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Basket>;
    if (typeof v.id !== "string" || !isId(v.id) || !Array.isArray(v.lines)) return null;
    const lines = v.lines
      .filter((l): l is BasketLine => !!l && typeof l.item_id === "string" && isId(l.item_id) && typeof l.qty === "number" && l.qty > 0)
      .slice(0, MAX_LINES)
      .map((l) => ({ item_id: l.item_id, qty: Math.min(MAX_QTY, l.qty) }));
    return {
      id: v.id,
      lines,
      pay: isPayment(v.pay) ? v.pay : "cash",
      pending: typeof v.pending === "string" && isId(v.pending) ? v.pending : null,
    };
  } catch {
    return null;
  }
}

/** Cents, so 3 × 3,20 € is exactly 9,60 € (the database rounds each line the same way). */
const cents = (n: number) => Math.round(n * 100);

/** The basket's lines with their product, line total and what the stock will be; lines of unknown products are left out. */
export function basketView(lines: BasketLine[], products: Map<string, SaleProduct>) {
  let totalCents = 0;
  let pieces = 0;
  const rows = [];
  for (const l of lines) {
    const p = products.get(l.item_id);
    if (!p) continue;
    const lineCents = p.price === null ? 0 : cents(p.price * l.qty);
    totalCents += lineCents;
    pieces += l.qty;
    const after = p.total - l.qty;
    // update 86: an untracked dish has no stock, so never a short or low warning
    const stock = p.tracked !== false;
    rows.push({ line: l, product: p, lineTotal: lineCents / 100, after, short: stock && after < 0, low: stock && after >= 0 && p.min > 0 && after < p.min, noPrice: p.price === null });
  }
  return { rows, total: totalCents / 100, pieces, noPrice: rows.some((r) => r.noPrice) };
}

/** Lower case without accents (the search finds "fasadna" in "fasádna"). */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The products whose name, code or EAN contain every word typed (up to `limit`). */
export function findProducts(products: SaleProduct[], q: string, limit = 30): SaleProduct[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return products.slice(0, limit);
  const out: SaleProduct[] = [];
  for (const p of products) {
    const hay = fold(`${p.name} ${p.code ?? ""} ${p.ean ?? ""}`);
    if (words.every((w) => hay.includes(w))) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/** The product a scanned code means: the EAN first, then the shop's code. */
export function productByCode(products: SaleProduct[], code: string): SaleProduct | null {
  const c = code.trim();
  return products.find((p) => p.ean === c) ?? products.find((p) => p.code === c) ?? null;
}

/** "SK96 1100 0000 0029 1859 9669". */
export function formatIban(iban: string): string {
  return iban.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}

/** The PAY by square message: "Predaj 2. 11. 2026 13:52" (the time in the shop's time zone, the page's words). */
export function paymentMessage(word: string, at: Date, timeZone: string, locale: string): string {
  const when = new Intl.DateTimeFormat(locale, { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone }).format(at);
  return `${word} ${when}`.replace(/\s+/g, " ").slice(0, 140);
}

/** owner_sklad_products rows → what the Predaj screen sells. */
export function saleProducts(rows: SkladRow[]): SaleProduct[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code ?? null,
    ean: r.ean ?? null,
    price: r.sale_price === null || r.sale_price === undefined ? null : Number(r.sale_price),
    total: Number(r.total) || 0,
    min: Number(r.min_qty) || 0,
    unit: r.unit || "ks",
    tracked: r.tracked !== false,
    soldOutToday: r.sold_out_today === true,
  }));
}

// ---------------------------------------------------------------- Príjemky (database update 69)

/** One line of a receipt: a Sklad product (item_id) or a new one (name, EAN, sale price), pieces, cost without VAT. */
export interface ReceiptLine {
  item_id: string | null;
  name: string;
  code: string | null;
  ean: string | null;
  qty: number;
  unit_cost: number | null;
  sale_price: number | null;
  vat_rate: number;
  src: string | null;
}

/** One more piece of a product (a new line at the end, at most 200 lines). */
export function addReceiptLine(lines: ReceiptLine[], p: { id: string; name: string; code: string | null; vat_rate?: number; last_cost?: number | null }, n = 1): ReceiptLine[] {
  const at = lines.findIndex((l) => l.item_id === p.id);
  if (at >= 0) return lines.map((l, i) => (i === at ? { ...l, qty: Math.min(MAX_QTY, l.qty + n) } : l));
  if (lines.length >= MAX_LINES) return lines;
  return [...lines, { item_id: p.id, name: p.name, code: p.code, ean: null, qty: n, unit_cost: p.last_cost ?? null, sale_price: null, vat_rate: p.vat_rate ?? 23, src: null }];
}

/** The receipt's sums in cents: without VAT, the VAT per line's rate, with VAT; pieces; new products without a price. */
export function receiptTotals(lines: ReceiptLine[]) {
  let net = 0;
  let vat = 0;
  let pieces = 0;
  for (const l of lines) {
    const lineNet = cents((l.unit_cost ?? 0) * l.qty);
    net += lineNet;
    vat += Math.round((lineNet * (l.vat_rate ?? 23)) / 100);
    pieces += l.qty;
  }
  return {
    net: net / 100,
    vat: vat / 100,
    gross: (net + vat) / 100,
    pieces,
    products: lines.length,
    newWithoutPrice: lines.filter((l) => !l.item_id && l.sale_price === null).length,
    newCount: lines.filter((l) => !l.item_id).length,
  };
}

/** A line of the invoice as the AI read it (cleaned by cleanInvoice). */
export interface InvoiceLine {
  text: string;
  ean: string;
  code: string;
  qty: number;
  unit_net: number;
  line_net: number;
  goods: boolean;
}

export interface Invoice {
  supplier: string;
  invoice_no: string;
  date: string;
  total_net: number | null;
  lines: InvoiceLine[];
}

const aiNum = (v: unknown, max = 1_000_000_000): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 10_000) / 10_000 : 0;
};
const str = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max);

/** The AI's answer made safe: texts cut, numbers ≥ 0, a date only as YYYY-MM-DD, at most 200 lines. */
export function cleanInvoice(raw: unknown): Invoice {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const lines = Array.isArray(r.lines) ? r.lines : [];
  const date = str(r.date, 10);
  return {
    supplier: str(r.supplier, 120),
    invoice_no: str(r.invoice_no, 60),
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
    total_net: r.has_total === false ? null : aiNum(r.total_net) || null,
    lines: lines.slice(0, 200).map((x) => {
      const l = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      const qty = aiNum(l.qty, 1_000_000_000) || 1;
      const unit = aiNum(l.unit_net);
      return {
        text: str(l.text, 200),
        ean: /^[0-9]{8,14}$/.test(str(l.ean, 32)) ? str(l.ean, 32) : "",
        code: str(l.code, 60),
        qty: Math.round(qty * 1000) / 1000,
        unit_net: unit,
        line_net: aiNum(l.line_net) || Math.round(unit * qty * 100) / 100,
        goods: l.goods !== false,
      };
    }).filter((l) => l.text || l.ean),
  };
}

/** Whether the lines add up to the invoice's total without VAT (to the cent, ± 5 cents for rounding). */
export function invoiceAddsUp(inv: Invoice): boolean | null {
  if (inv.total_net === null) return null;
  const sum = inv.lines.reduce((s, l) => s + cents(l.line_net), 0);
  return Math.abs(sum - cents(inv.total_net)) <= 5;
}
