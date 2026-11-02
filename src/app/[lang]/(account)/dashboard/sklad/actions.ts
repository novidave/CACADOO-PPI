"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { refreshShop } from "@/lib/publicCache";
import { checkMove, cleanTime, isCardAction, isPayment, isUnit, parseAmount, parsePrice, saleProducts, type SaleProduct, type SkladRow } from "@/lib/sklad";

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
    go(/^(\/(products(\/[0-9a-f-]{36}|\/new)?|movements|settings|sale(\/[0-9a-f-]{36})?|terminal))?$/.test(back) ? back : "", query);
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
  const { session } = await seller(input.lang);
  if (!session) return { ok: false, error: "failed" };
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
    const { error: cancelError } = await session.supabase.rpc("owner_sklad_sale_cancel", { p_shop_id: input.shopId, p_sale_id: input.replaces });
    if (cancelError && reason(cancelError.message) === "done") return { ok: false, error: "done" };
  }
  const { data, error } = await session.supabase.rpc("owner_sklad_sell", {
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
  const { session } = await seller(input.lang);
  if (!session || !UUID.test(input.shopId)) return [];
  const q = String(input.q ?? "").trim().slice(0, 100);
  if (!q) return [];
  const { data, error } = await session.supabase.rpc("owner_sklad_products", { p_shop_id: input.shopId, p_q: q, p_filter: "all", p_limit: 30, p_offset: 0 });
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
  const { session } = await seller(input.lang);
  if (!session || !UUID.test(input.shopId) || !UUID.test(input.saleId)) return { ok: false, error: "failed" };
  const { error } = await session.supabase.rpc(input.act === "paid" ? "owner_sklad_sale_paid" : "owner_sklad_sale_cancel", {
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
