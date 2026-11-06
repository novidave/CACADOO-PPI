"use server";

import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { siteUrl } from "@/lib/site";
import { columnsFit, EKASA_MAX_BYTES, EKASA_MAX_ROWS, fileHash, readTable, toLines, type EkasaColumns, type EkasaTable } from "@/lib/ekasa";
import { readInvoice } from "@/lib/invoiceRead";
import { refreshShop } from "@/lib/publicCache";
import { skladRpc } from "@/lib/skladDevice";
import { checkMove, cleanTime, isCardAction, isPayment, isUnit, parseAmount, parsePrice, saleProducts, invoiceAddsUp, type Invoice, type ReceiptLine, type SaleProduct, type SkladRow } from "@/lib/sklad";

/**
 * Môj obchod → Sklad (database update 67). Every number is decided in SQL (owner_sklad_*): the movement by its own id
 * (the form carries a UUID made when the page was drawn, so a second tap or a retried request is never counted twice),
 * the stock per location, the public side (sklad_apply) and the plan's product limit. After a change that visitors can
 * see the shop's cached pages are read again (refreshShop).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = [
  "qty", "reason", "to_location", "location", "unit_cost", "not_found", "plan_limit", "ean_taken", "code_taken", "name", "ean",
  "code", "unit", "vat_rate", "sale_price", "min_qty", "not_sklad", "api_connected", "no_device", "too_many", "source", "time",
  // update 68 (Predaj)
  "no_price", "empty", "no_iban", "cancelled", "done", "iban", "bic", "payee", "payment",
  // update 69 (Príjemky)
  "discarded", "date", "supplier", "invoice_no", "bad_argument",
  // update 70 (Inventúra)
  "closed", "counter", "shelf", "zero_shelf", "too_late",
  // update 71 (eKasa)
  "sale_source", "columns", "ekasa_file", "ekasa_big", "ekasa_rows", "ekasa_empty",
  // update 72 (Zariadenia)
  "perms",
  // update 86 (a dish without "Sledovať zásobu" is not stock)
  "untracked_dish",
] as const;
const reason = (message: string | undefined) => REASONS.find((r) => r === message) ?? "failed";

async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const back = String(formData.get("back") ?? "");
  const go = (path: string, query: Record<string, string>): never =>
    redirect(`/${lang}/dashboard/sklad${path}?${new URLSearchParams({ ...(slug ? { shop: slug } : {}), ...query })}`);
  // only our own Sklad pages as the way back
  const page = (query: Record<string, string>): never =>
    go(/^(\/(products(\/[0-9a-f-]{36}|\/new)?|movements|settings|sale(\/[0-9a-f-]{36})?|terminal|receipts(\/[0-9a-f-]{36})?|counts(\/[0-9a-f-]{36}(\/diff)?)?|ekasa(\/columns)?))?$/.test(back) ? back : "", query);
  return { lang, session, shopId: UUID.test(shopId) ? shopId : "", slug, page, go };
}

const text = (formData: FormData, name: string, max: number) => String(formData.get(name) ?? "").trim().slice(0, max);
const id = (formData: FormData, name: string) => {
  const v = String(formData.get(name) ?? "");
  return UUID.test(v) ? v : null;
};

/** Príjem / Výdaj / Odpis / Presun / Oprava on the product card. */
export async function moveStock(formData: FormData) {
  const { session, shopId, slug, page } = await start(formData);
  const action = String(formData.get("action") ?? "");
  const item = id(formData, "item_id");
  const mid = id(formData, "mid");
  if (!isCardAction(action) || !item || !mid) page({ err: "failed" });
  const act = action as Parameters<typeof checkMove>[0];
  const amount = parseAmount(formData.get("qty"));
  const cost = act === "receipt" ? parsePrice(formData.get("unit_cost")) : null;
  const from = id(formData, "location_id");
  const to = id(formData, "to_location_id");
  const why = text(formData, "reason", 200);
  const problem = checkMove(act, amount, { reason: why, from: from ?? "", to: to ?? "", cost });
  if (problem) page({ act, err: problem });
  const { error } = await session.supabase.rpc("owner_sklad_move", {
    p_shop_id: shopId,
    p_id: mid,
    p_item_id: item,
    p_kind: act === "correction" ? "correction" : act,
    p_qty: amount,
    p_location_id: from,
    p_to_location_id: act === "transfer" ? to : null,
    p_unit_cost: cost,
    p_reason: why || null,
    p_ref: text(formData, "ref", 80) || null,
    p_device: text(formData, "device", 60) || null,
    p_client_at: new Date().toISOString(),
  });
  if (error) page({ act, err: reason(error.message) });
  refreshShop(slug);
  page({ ok: "moved" });
}

/** "Stav je správny": the stock is right → fresh again for 24 hours. */
export async function confirmStock(formData: FormData) {
  const { session, shopId, slug, page } = await start(formData);
  const { error } = await session.supabase.rpc("owner_sklad_confirm", { p_shop_id: shopId });
  if (error) page({ err: reason(error.message) });
  refreshShop(slug);
  page({ ok: "confirmed" });
}

/** "Nový produkt" / "Upraviť": only the fields the form sends change. */
export async function saveProduct(formData: FormData) {
  const { session, shopId, slug, page, go } = await start(formData);
  const item = id(formData, "item_id");
  const price = parsePrice(formData.get("sale_price"));
  const vat = parseAmount(formData.get("vat_rate"));
  const min = parseAmount(formData.get("min_qty") || "0");
  const unit = String(formData.get("unit") ?? "ks");
  if (price !== null && Number.isNaN(price)) page({ edit: "1", err: "sale_price" });
  if (vat === null || vat < 0 || vat > 100) page({ edit: "1", err: "vat_rate" });
  if (min === null || min < 0) page({ edit: "1", err: "min_qty" });
  if (!isUnit(unit)) page({ edit: "1", err: "unit" });
  const p = {
    name: text(formData, "name", 300),
    code: text(formData, "code", 100),
    ean: text(formData, "ean", 32),
    brand: text(formData, "brand", 100),
    description: text(formData, "description", 5000),
    unit,
    vat_rate: String(vat),
    sale_price: price === null ? "" : String(price),
    min_qty: String(min),
    shelf: text(formData, "shelf", 80),
    supplier: text(formData, "supplier", 120),
  };
  if (!p.name) page({ edit: "1", err: "name" });
  const { data, error } = await session.supabase.rpc("owner_sklad_save_product", { p_shop_id: shopId, p_item_id: item, p });
  if (error) page({ edit: "1", err: reason(error.message) });
  refreshShop(slug);
  go(`/products/${String(data)}`, { ok: item ? "saved" : "created" });
}

/** The stock source from Sklad's Nastavenia: "sklad" (takes over the products) or back to "file". */
export async function setSource(formData: FormData) {
  const { session, shopId, slug, page } = await start(formData);
  const source = String(formData.get("source") ?? "");
  if (source !== "sklad" && source !== "file") page({ err: "source" });
  const { error } = await session.supabase.rpc("owner_set_stock_source", { p_shop_id: shopId, p_source: source });
  if (error) page({ err: reason(error.message) });
  refreshShop(slug);
  page({ ok: source === "sklad" ? "source_sklad" : "source_file" });
}

export async function saveLocation(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const { error } = await session.supabase.rpc("owner_sklad_save_location", {
    p_shop_id: shopId,
    p_id: id(formData, "location_id"),
    p_name: text(formData, "name", 80),
    p_note: text(formData, "note", 200) || null,
    p_sale_default: formData.get("sale_default") === "on",
    p_receipt_default: formData.get("receipt_default") === "on",
  });
  if (error) page({ err: reason(error.message) });
  page({ ok: "location_saved" });
}

export async function saveSettings(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const time = cleanTime(formData.get("reminder_time"));
  if (!time) page({ err: "time" });
  const { error } = await session.supabase.rpc("owner_sklad_save_settings", {
    p_shop_id: shopId,
    p_margin_reports: formData.get("margin_reports") === "on",
    p_reminder_on: formData.get("reminder_on") === "on",
    p_reminder_time: time,
  });
  if (error) page({ err: reason(error.message) });
  page({ ok: "settings_saved" });
}

// ---------------------------------------------------------------- Predaj (database update 68)

export interface SaleResult {
  ok: boolean;
  error?: string;
  sale?: { id: string; status: string; total: number; pieces: number; location: string | null; duplicate: boolean };
}

/** The basket's own session check (called from the Predaj screen, not a form). */
async function seller(lang: string) {
  const session = await getSession();
  return { session, lang: isLocale(lang) ? lang : "en" };
}

/**
 * "Potvrdiť predaj" / "Zobraziť QR": the whole basket as one sale, by the basket's own id (a second tap or a retry is
 * the same sale). The prices, the stock and what is allowed are decided in SQL (owner_sklad_sell).
 */
export async function sellBasket(input: {
  lang: string;
  shopId: string;
  shopSlug: string;
  saleId: string;
  lines: { item_id: string; qty: number }[];
  payment: string;
  device?: string;
  /** a QR sale of this basket still waiting: cancelled first (the customer pays another way) */
  replaces?: string | null;
}): Promise<SaleResult> {
  const rpc = await skladRpc();
  if (!rpc) return { ok: false, error: "failed" };
  if (!UUID.test(input.shopId) || !UUID.test(input.saleId)) return { ok: false, error: "failed" };
  if (!isPayment(input.payment)) return { ok: false, error: "payment" };
  const lines = Array.isArray(input.lines)
    ? input.lines
        .filter((l) => l && UUID.test(String(l.item_id)) && typeof l.qty === "number" && Number.isFinite(l.qty) && l.qty > 0)
        .slice(0, 200)
        .map((l) => ({ item_id: String(l.item_id), qty: Math.round(l.qty * 1000) / 1000 }))
    : [];
  if (!lines.length) return { ok: false, error: "empty" };
  if (input.replaces && UUID.test(input.replaces) && input.replaces !== input.saleId) {
    const { error: cancelError } = await rpc("owner_sklad_sale_cancel", { p_shop_id: input.shopId, p_sale_id: input.replaces });
    if (cancelError && reason(cancelError.message) === "done") return { ok: false, error: "done" };
  }
  const { data, error } = await rpc("owner_sklad_sell", {
    p_shop_id: input.shopId,
    p_id: input.saleId,
    p_lines: lines,
    p_payment: input.payment,
    p_device: String(input.device ?? "").slice(0, 60) || null,
  });
  if (error) return { ok: false, error: reason(error.message) };
  const s = data as { id: string; status: string; total: number; pieces: number; location: string | null; duplicate: boolean };
  if (s.status === "done") refreshShop(input.shopSlug);
  return { ok: true, sale: { id: s.id, status: s.status, total: Number(s.total), pieces: Number(s.pieces), location: s.location, duplicate: !!s.duplicate } };
}

/** The Predaj screen's search / scan in a shop with more products than the screen got (the first 500). */
export async function lookupSaleProducts(input: { lang: string; shopId: string; q: string }): Promise<SaleProduct[]> {
  const rpc = await skladRpc();
  if (!rpc || !UUID.test(input.shopId)) return [];
  const q = String(input.q ?? "").trim().slice(0, 100);
  if (!q) return [];
  const { data, error } = await rpc("owner_sklad_products", { p_shop_id: input.shopId, p_q: q, p_filter: "all", p_limit: 30, p_offset: 0 });
  if (error || !data) return [];
  return saleProducts((data as { rows: SkladRow[] }).rows);
}

/** "Zaplatené – potvrdiť predaj" (the QR page's form). */
export async function salePaid(formData: FormData) {
  const { session, shopId, slug, go } = await start(formData);
  const sale = id(formData, "sale_id");
  if (!sale) go("/sale", { err: "failed" });
  const { error } = await session.supabase.rpc("owner_sklad_sale_paid", { p_shop_id: shopId, p_sale_id: sale });
  if (error) go(`/sale/${sale}`, { err: reason(error.message) });
  refreshShop(slug);
  go(`/sale/${sale}`, { ok: "sold" });
}

/** "Zrušiť predaj" / "Zaplatí inak": a waiting QR sale is cancelled (nothing was taken off). */
export async function saleCancel(formData: FormData) {
  const { session, shopId, go } = await start(formData);
  const sale = id(formData, "sale_id");
  if (!sale) go("/sale", { err: "failed" });
  const { error } = await session.supabase.rpc("owner_sklad_sale_cancel", { p_shop_id: shopId, p_sale_id: sale });
  if (error) go(`/sale/${sale}`, { err: reason(error.message) });
  go("/sale", formData.get("other") === "1" ? {} : { ok: "sale_cancelled" });
}

/** The QR terminal's buttons (no page change: the terminal reads its state again). */
export async function terminalAct(input: { lang: string; shopId: string; shopSlug: string; saleId: string; act: "paid" | "cancel" }): Promise<{ ok: boolean; error?: string }> {
  const rpc = await skladRpc();
  if (!rpc || !UUID.test(input.shopId) || !UUID.test(input.saleId)) return { ok: false, error: "failed" };
  const { error } = await rpc(input.act === "paid" ? "owner_sklad_sale_paid" : "owner_sklad_sale_cancel", {
    p_shop_id: input.shopId,
    p_sale_id: input.saleId,
  });
  if (error) return { ok: false, error: reason(error.message) };
  if (input.act === "paid") refreshShop(input.shopSlug);
  return { ok: true };
}

/** Nastavenia → "Platba QR": IBAN (checked in SQL), BIC, payee. */
export async function savePayment(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const { error } = await session.supabase.rpc("owner_sklad_save_payment", {
    p_shop_id: shopId,
    p_iban: text(formData, "iban", 60) || null,
    p_bic: text(formData, "bic", 20) || null,
    p_payee: text(formData, "payee", 100) || null,
  });
  if (error) page({ err: reason(error.message) });
  page({ ok: "payment" });
}

// ---------------------------------------------------------------- Príjemky (database update 69)

export interface ReceiptJson {
  id: string;
  number: string;
  status: "draft" | "done" | "discarded";
  supplier: string | null;
  invoice_no: string | null;
  delivered_on: string | null;
  location_id: string;
  location: string | null;
  total: number;
  pieces: number;
  lines: (ReceiptLine & { current_sale_price?: number | null })[];
  duplicate?: boolean;
}

export interface ReceiptInput {
  lang: string;
  shopId: string;
  shopSlug: string;
  id: string;
  supplier: string;
  invoice_no: string;
  delivered_on: string;
  location_id: string;
  lines: ReceiptLine[];
}

const cleanLines = (lines: ReceiptLine[]) =>
  (Array.isArray(lines) ? lines : []).slice(0, 200).map((l) => ({
    item_id: l.item_id && UUID.test(l.item_id) ? l.item_id : null,
    name: String(l.name ?? "").slice(0, 300),
    ean: String(l.ean ?? "").slice(0, 32) || null,
    qty: String(Math.round(Number(l.qty) * 1000) / 1000),
    unit_cost: l.unit_cost === null || l.unit_cost === undefined || !Number.isFinite(Number(l.unit_cost)) ? null : String(Math.round(Number(l.unit_cost) * 10_000) / 10_000),
    sale_price: l.sale_price === null || l.sale_price === undefined || !Number.isFinite(Number(l.sale_price)) ? null : String(Math.round(Number(l.sale_price) * 100) / 100),
    vat_rate: l.item_id ? null : String(Number.isFinite(Number(l.vat_rate)) ? Number(l.vat_rate) : 23),
    src: String(l.src ?? "").slice(0, 200) || null,
  }));

async function saveDraft(session: NonNullable<Awaited<ReturnType<typeof getSession>>>, input: ReceiptInput) {
  return session.supabase.rpc("owner_sklad_receipt_save", {
    p_shop_id: input.shopId,
    p_id: input.id,
    p: {
      supplier: String(input.supplier ?? "").slice(0, 120),
      invoice_no: String(input.invoice_no ?? "").slice(0, 60),
      delivered_on: /^\d{4}-\d{2}-\d{2}$/.test(input.delivered_on ?? "") ? input.delivered_on : "",
      location_id: UUID.test(input.location_id ?? "") ? input.location_id : null,
      lines: cleanLines(input.lines),
    },
  });
}

/** "Uložiť koncept": the draft as it is now (made and numbered on first save). */
export async function saveReceipt(input: ReceiptInput): Promise<{ ok: boolean; error?: string; receipt?: ReceiptJson }> {
  const { session } = await seller(input.lang);
  if (!session || !UUID.test(input.shopId) || !UUID.test(input.id)) return { ok: false, error: "failed" };
  const { data, error } = await saveDraft(session, input);
  if (error) return { ok: false, error: reason(error.message) };
  return { ok: true, receipt: data as ReceiptJson };
}

/** "Potvrdiť príjemku": saved as shown, then confirmed in one SQL call (new products, Príjem movements, once). */
export async function confirmReceipt(input: ReceiptInput): Promise<{ ok: boolean; error?: string; receipt?: ReceiptJson }> {
  const { session } = await seller(input.lang);
  if (!session || !UUID.test(input.shopId) || !UUID.test(input.id)) return { ok: false, error: "failed" };
  const saved = await saveDraft(session, input);
  if (saved.error && reason(saved.error.message) !== "done") return { ok: false, error: reason(saved.error.message) };
  const { data, error } = await session.supabase.rpc("owner_sklad_receipt_confirm", { p_shop_id: input.shopId, p_id: input.id });
  if (error) return { ok: false, error: reason(error.message) };
  refreshShop(input.shopSlug);
  return { ok: true, receipt: data as ReceiptJson };
}

/** "Zahodiť koncept" (a form on the receipt page). */
export async function discardReceipt(formData: FormData) {
  const { session, shopId, go } = await start(formData);
  const rid = id(formData, "receipt_id");
  if (!rid) go("/receipts", { err: "failed" });
  const { error } = await session.supabase.rpc("owner_sklad_receipt_discard", { p_shop_id: shopId, p_id: rid });
  if (error) go(`/receipts/${rid}`, { err: reason(error.message) });
  go("/receipts", { ok: "receipt_discarded" });
}

export interface InvoiceMatch {
  kind: "ean" | "code" | "name" | "unsure" | "new";
  item_id: string | null;
  name: string | null;
  code: string | null;
  candidates: { id: string; name: string; code: string | null }[];
}

/**
 * "Faktúra (AI)": the photo (JPEG, base64) or the PDF's text from the owner's browser → Claude reads the lines →
 * owner_sklad_match pairs them with the shop's products. Off without ANTHROPIC_API_KEY ("ai_off"); sklad_ai_hit
 * counts the readings (Free 5, Pro 50 a day: "ai_limit"). Nothing is stored; the invoice is never logged.
 */
export async function readInvoiceLines(input: {
  lang: string;
  shopId: string;
  image?: string;
  text?: string;
}): Promise<{ ok: boolean; error?: string; invoice?: Invoice; matches?: InvoiceMatch[]; addsUp?: boolean | null }> {
  const { session } = await seller(input.lang);
  if (!session || !UUID.test(input.shopId)) return { ok: false, error: "failed" };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: "ai_off" };
  const image = typeof input.image === "string" && /^[A-Za-z0-9+/=]{100,1900000}$/.test(input.image) ? input.image : null;
  const text = typeof input.text === "string" ? input.text.slice(0, 40_000).trim() : "";
  if (!image && text.length < 20) return { ok: false, error: "ai_unreadable" };
  const { data: allowed, error: hitError } = await session.supabase.rpc("sklad_ai_hit", { p_shop_id: input.shopId });
  if (hitError) return { ok: false, error: reason(hitError.message) };
  if (allowed !== true) return { ok: false, error: "ai_limit" };
  let invoice: Invoice;
  try {
    invoice = await readInvoice(image ? { kind: "image", base64: image } : { kind: "text", text });
  } catch (e) {
    console.error("sklad: invoice reading failed", e instanceof Error ? e.message.slice(0, 80) : "error");
    return { ok: false, error: "ai_failed" };
  }
  if (!invoice.lines.length) return { ok: false, error: "ai_unreadable" };
  const { data, error } = await session.supabase.rpc("owner_sklad_match", {
    p_shop_id: input.shopId,
    p_lines: invoice.lines.map((l) => ({ text: l.text, ean: l.ean, code: l.code })),
  });
  if (error) return { ok: false, error: reason(error.message) };
  return { ok: true, invoice, matches: data as InvoiceMatch[], addsUp: invoiceAddsUp(invoice) };
}

// ---------------------------------------------------------------- Inventúra (database update 70)

/** "Spustiť inventúru": a count of one location (or one shelf of it), blind unless unticked; then its counting screen. */
export async function startCount(formData: FormData) {
  const { session, shopId, go } = await start(formData);
  const cid = id(formData, "count_id");
  if (!cid) go("/counts", { err: "failed" });
  const scope = String(formData.get("scope") ?? "location");
  const { data, error } = await session.supabase.rpc("owner_sklad_count_start", {
    p_shop_id: shopId,
    p_id: cid,
    p_name: text(formData, "name", 80) || null,
    p_location_id: id(formData, "location_id"),
    p_shelf: scope === "shelf" ? text(formData, "shelf", 80) || null : null,
    p_blind: formData.get("blind") === "on",
  });
  if (error) go("/counts", { err: reason(error.message) });
  go(`/counts/${String((data as { id: string }).id)}`, {});
}

export interface CountItem {
  item_id: string;
  name: string;
  code: string | null;
  total: number;
  counters: { counter: string; qty: number; at: string }[];
  expected: number | null;
}

/** A phone's total for one product (the + / − buttons and "Zadať počet naraz" all send the total). */
export async function countSet(input: {
  lang: string;
  shopId: string;
  countId: string;
  itemId: string;
  counter: string;
  qty: number;
  onlyMine?: boolean;
}): Promise<{ ok: boolean; error?: string; item?: CountItem }> {
  const rpc = await skladRpc();
  if (!rpc || !UUID.test(input.shopId) || !UUID.test(input.countId) || !UUID.test(input.itemId)) return { ok: false, error: "failed" };
  const qty = Math.round(Number(input.qty) * 1000) / 1000;
  if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: "qty" };
  const { data, error } = await rpc("owner_sklad_count_set", {
    p_shop_id: input.shopId,
    p_count_id: input.countId,
    p_item_id: input.itemId,
    p_counter: String(input.counter ?? "").slice(0, 60),
    p_qty: qty,
    p_only_mine: !!input.onlyMine,
  });
  if (error) return { ok: false, error: reason(error.message) };
  return { ok: true, item: data as CountItem };
}

/** This phone's own counts so far (by its name; the phone keeps only its name). */
export async function countMine(input: { lang: string; shopId: string; countId: string; counter: string }): Promise<{ item_id: string; qty: number }[]> {
  const rpc = await skladRpc();
  if (!rpc || !UUID.test(input.shopId) || !UUID.test(input.countId)) return [];
  const { data, error } = await rpc("owner_sklad_count", {
    p_shop_id: input.shopId,
    p_count_id: input.countId,
    p_counter: String(input.counter ?? "").slice(0, 60),
  });
  if (error || !data) return [];
  return ((data as { mine: { item_id: string; qty: number }[] }).mine ?? []).map((m) => ({ item_id: m.item_id, qty: Number(m.qty) }));
}

/** "Prepočítať" / "Prijať napočítané" on the differences. */
export async function countMark(formData: FormData) {
  const { session, shopId, go } = await start(formData);
  const cid = id(formData, "count_id");
  const item = id(formData, "item_id");
  if (!cid || !item) go("/counts", { err: "failed" });
  const { error } = await session.supabase.rpc("owner_sklad_count_mark", {
    p_shop_id: shopId,
    p_count_id: cid,
    p_item_id: item,
    p_recount: formData.get("recount") === "1",
  });
  if (error) go(`/counts/${cid}/diff`, { err: reason(error.message) });
  go(`/counts/${cid}/diff`, {});
}

/** "Schváliť inventúru" (+ "Nastaviť na 0" for the products not counted, a whole location only). */
export async function approveCount(formData: FormData) {
  const { session, shopId, slug, go } = await start(formData);
  const cid = id(formData, "count_id");
  if (!cid) go("/counts", { err: "failed" });
  const { error } = await session.supabase.rpc("owner_sklad_count_approve", {
    p_shop_id: shopId,
    p_count_id: cid,
    p_zero_uncounted: formData.get("uncounted") === "zero",
  });
  if (error) go(`/counts/${cid}/diff`, { err: reason(error.message) });
  refreshShop(slug);
  go(`/counts/${cid}/diff`, { ok: "count_approved" });
}

/** "Vrátiť inventúru späť (do 24 h)". */
export async function undoCount(formData: FormData) {
  const { session, shopId, slug, go } = await start(formData);
  const cid = id(formData, "count_id");
  if (!cid) go("/counts", { err: "failed" });
  const { error } = await session.supabase.rpc("owner_sklad_count_undo", { p_shop_id: shopId, p_count_id: cid });
  if (error) go(`/counts/${cid}/diff`, { err: reason(error.message) });
  refreshShop(slug);
  go(`/counts/${cid}/diff`, { ok: "count_undone" });
}

/** "Zrušiť inventúru": closed without changing the stock. */
export async function cancelCount(formData: FormData) {
  const { session, shopId, go } = await start(formData);
  const cid = id(formData, "count_id");
  if (!cid) go("/counts", { err: "failed" });
  const { error } = await session.supabase.rpc("owner_sklad_count_cancel", { p_shop_id: shopId, p_count_id: cid });
  if (error) go("/counts", { err: reason(error.message) });
  go("/counts", { ok: "count_cancelled" });
}

// ---------------------------------------------------------------- eKasa (database update 71)

/** "Odkiaľ prichádzajú predaje": the Predaj screen or the eKasa export — one of them, never both. */
export async function setSaleSource(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const source = String(formData.get("sale_source") ?? "");
  if (source !== "predaj" && source !== "ekasa") page({ err: "failed" });
  const { error } = await session.supabase.rpc("owner_sklad_set_sale_source", { p_shop_id: shopId, p_source: source });
  if (error) page({ err: reason(error.message) });
  page({ ok: source === "ekasa" ? "sale_ekasa" : "sale_predaj" });
}

/** The shop's own time zone (the export's times are its wall-clock times). */
async function shopZone(session: NonNullable<Awaited<ReturnType<typeof getSession>>>, shopId: string): Promise<string> {
  const { data } = await session.supabase.from("shops").select("timezone").eq("id", shopId).maybeSingle();
  return (data as { timezone?: string } | null)?.timezone || "UTC";
}

async function bookEkasa(
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  shopId: string,
  input: { id: string; name: string; hash: string; table: EkasaTable; cols: EkasaColumns },
) {
  const lines = toLines(input.table, input.cols, await shopZone(session, shopId));
  return await session.supabase.rpc("owner_sklad_ekasa_import", {
    p_shop_id: shopId,
    p_id: input.id,
    p_file_name: input.name,
    p_file_hash: input.hash,
    p_lines: lines,
  });
}

/**
 * "Nahrať export z eKasa": the file is read here (CSV or XLSX, ≤ 1.9 MB, ≤ 5 000 rows) and only its lines go on; with
 * the columns approved before it is booked at once, else it waits for "Stĺpce exportu" (1 day).
 */
export async function uploadEkasa(formData: FormData) {
  const { session, shopId, slug, go } = await start(formData);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) go("/ekasa", { err: "ekasa_file" });
  const upload = file as File;
  if (upload.size > EKASA_MAX_BYTES) go("/ekasa", { err: "ekasa_big" });
  const bytes = new Uint8Array(await upload.arrayBuffer());
  let table: EkasaTable | null = null;
  try {
    table = await readTable(bytes, upload.name);
  } catch {
    table = null;
  }
  if (!table) go("/ekasa", { err: "ekasa_file" });
  const t = table as EkasaTable;
  if (!t.headers.length || !t.rows.length) go("/ekasa", { err: "ekasa_empty" });
  if (t.rows.length > EKASA_MAX_ROWS) go("/ekasa", { err: "ekasa_rows" });
  const hash = await fileHash(bytes);
  const name = upload.name.trim().slice(0, 200) || "ekasa.csv";
  const info = await session.supabase.rpc("owner_sklad_ekasa_info", { p_shop_id: shopId });
  if (info.error) go("/ekasa", { err: reason(info.error.message) });
  const cols = (info.data as { columns: EkasaColumns | null; sale_source: string }).columns;
  if ((info.data as { sale_source: string }).sale_source !== "ekasa") go("/ekasa", { err: "sale_source" });
  const id = crypto.randomUUID();
  if (columnsFit(cols, t.headers) && formData.get("pick_columns") !== "1") {
    const { data, error } = await bookEkasa(session, shopId, { id, name, hash, table: t, cols: cols as EkasaColumns });
    if (error) go("/ekasa", { err: reason(error.message) });
    refreshShop(slug);
    go("/ekasa", { ok: (data as { duplicate?: boolean }).duplicate ? "ekasa_duplicate" : "ekasa_imported" });
  }
  const { data, error } = await session.supabase.rpc("owner_sklad_ekasa_stage", {
    p_shop_id: shopId,
    p_id: id,
    p_file_name: name,
    p_file_hash: hash,
    p_headers: t.headers.slice(0, 60),
    p_rows: t.rows,
  });
  if (error) go("/ekasa", { err: reason(error.message) });
  if ((data as { duplicate?: string }).duplicate) go("/ekasa", { ok: "ekasa_duplicate" });
  go("/ekasa/columns", { id });
}

/** "Schváliť stĺpce": the owner's choice is kept for the next exports, then the waiting file is booked. */
export async function saveEkasaColumns(formData: FormData) {
  const { session, shopId, slug, go } = await start(formData);
  const staged = id(formData, "id");
  if (!staged) go("/ekasa", { err: "failed" });
  const cols: EkasaColumns = {};
  for (const f of ["product", "qty", "doc", "time", "price", "code", "ean"] as const) {
    const v = text(formData, `col_${f}`, 80);
    if (v) cols[f] = v;
  }
  const saved = await session.supabase.rpc("owner_sklad_ekasa_save_columns", { p_shop_id: shopId, p_columns: cols });
  if (saved.error) go("/ekasa/columns", { id: staged as string, err: reason(saved.error.message) });
  const st = await session.supabase.rpc("owner_sklad_ekasa_staged", { p_shop_id: shopId, p_id: staged, p_limit: null });
  const file = st.data as { file_name: string; file_hash: string; headers: string[]; rows: string[][] } | null;
  if (st.error || !file) go("/ekasa", { err: "ekasa_file" });
  const f = file as NonNullable<typeof file>;
  if (!columnsFit(cols, f.headers)) go("/ekasa/columns", { id: staged as string, err: "columns" });
  const { data, error } = await bookEkasa(session, shopId, {
    id: staged as string,
    name: f.file_name,
    hash: f.file_hash,
    table: { headers: f.headers, rows: f.rows },
    cols,
  });
  if (error) go("/ekasa", { err: reason(error.message) });
  refreshShop(slug);
  go("/ekasa", { ok: (data as { duplicate?: boolean }).duplicate ? "ekasa_duplicate" : "ekasa_imported" });
}

/** "Spárovať": a waiting text ↔ a product (or "Nie je tovar"); remembered, every waiting line of it booked. */
export async function pairEkasa(formData: FormData) {
  const { session, shopId, slug, go } = await start(formData);
  const key = text(formData, "key", 200);
  const ignore = formData.get("ignore") === "1";
  const item = id(formData, "item_id");
  if (!key || (!ignore && !item)) go("/ekasa", { err: "failed" });
  const { error } = await session.supabase.rpc("owner_sklad_ekasa_pair", {
    p_shop_id: shopId,
    p_key: key,
    p_item_id: ignore ? null : item,
    p_ignore: ignore,
  });
  if (error) go("/ekasa", { err: reason(error.message) });
  refreshShop(slug);
  go("/ekasa", { ok: ignore ? "ekasa_ignored" : "ekasa_paired" });
}

/** "Zabudnúť": the next exports ask about this text again (what was booked stays). */
export async function forgetEkasa(formData: FormData) {
  const { session, shopId, go } = await start(formData);
  const key = text(formData, "key", 200);
  if (!key) go("/ekasa", { err: "failed" });
  const { error } = await session.supabase.rpc("owner_sklad_ekasa_forget", { p_shop_id: shopId, p_key: key });
  if (error) go("/ekasa", { err: reason(error.message) });
  go("/ekasa", { ok: "ekasa_forgotten" });
}

// ---------------------------------------------------------------- Zariadenia (database update 72)

export interface DevicePairing {
  ok: boolean;
  error?: string;
  url?: string;
  svg?: string;
  expires?: string;
}

const PERMS = ["sale", "receive", "counts", "terminal"] as const;

/** The pairing code as a QR code (drawn here; the code goes into the address's #, never to a server log). */
async function pairing(lang: string, data: unknown): Promise<DevicePairing> {
  const d = data as { code: string; expires: string };
  const url = `${siteUrl()}/${isLocale(lang) ? lang : "sk"}/zariadenie/pripojit#${d.code}`;
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return { ok: true, url, svg, expires: d.expires };
}

/** "Pripojiť telefón (QR kód)": a name and what it may do → a code shown once (10 minutes). */
export async function addDevice(input: { lang: string; shopId: string; name: string; perms: string[] }): Promise<DevicePairing> {
  const session = await getSession();
  if (!session || !UUID.test(input.shopId)) return { ok: false, error: "failed" };
  const perms = PERMS.filter((x) => (input.perms ?? []).includes(x));
  const { data, error } = await session.supabase.rpc("owner_sklad_device_add", {
    p_shop_id: input.shopId,
    p_name: String(input.name ?? "").trim().slice(0, 60),
    p_perms: perms,
  });
  if (error) return { ok: false, error: reason(error.message) };
  return await pairing(input.lang, data);
}

/** "Nový kód": another phone under this name (the one paired before is disconnected). */
export async function deviceCode(input: { lang: string; shopId: string; id: string }): Promise<DevicePairing> {
  const session = await getSession();
  if (!session || !UUID.test(input.shopId) || !UUID.test(input.id)) return { ok: false, error: "failed" };
  const { data, error } = await session.supabase.rpc("owner_sklad_device_code", { p_shop_id: input.shopId, p_id: input.id });
  if (error) return { ok: false, error: reason(error.message) };
  return await pairing(input.lang, data);
}

/** A phone's name and ticks. */
export async function saveDevice(formData: FormData) {
  const { session, shopId, go } = await start(formData);
  const dev = id(formData, "device_id");
  if (!dev) go("/settings", { err: "failed" });
  const { error } = await session.supabase.rpc("owner_sklad_device_save", {
    p_shop_id: shopId,
    p_id: dev,
    p_name: text(formData, "name", 60),
    p_perms: PERMS.filter((x) => formData.get(`perm_${x}`) === "on"),
  });
  if (error) go("/settings", { err: reason(error.message) });
  go("/settings", { ok: "device_saved" });
}

/** "Odpojiť": the phone's key stops working at once. */
export async function revokeDevice(formData: FormData) {
  const { session, shopId, go } = await start(formData);
  const dev = id(formData, "device_id");
  if (!dev) go("/settings", { err: "failed" });
  const { error } = await session.supabase.rpc("owner_sklad_device_revoke", { p_shop_id: shopId, p_id: dev });
  if (error) go("/settings", { err: reason(error.message) });
  go("/settings", { ok: "device_revoked" });
}
