"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { refreshShop } from "@/lib/publicCache";
import { checkMove, cleanTime, isCardAction, isUnit, parseAmount, parsePrice } from "@/lib/sklad";

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
  const page = (query: Record<string, string>): never => go(/^(\/(products(\/[0-9a-f-]{36}|\/new)?|movements|settings))?$/.test(back) ? back : "", query);
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
