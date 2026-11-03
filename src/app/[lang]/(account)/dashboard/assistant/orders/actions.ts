"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { aiModel } from "@/lib/aiModel";
import { getSession } from "@/lib/auth";
import { readMenuNames } from "@/lib/foodMenuRead";
import { refreshShop } from "@/lib/publicCache";

/**
 * Asistent → Objednávky (database updates 73–74): the owner moves an order on, marks its payment, pauses ordering,
 * saves the settings and the zones, checks the menu against Sklad. Every rule is in SQL (owner_food_* — members, the
 * plan for writes; the steps, the payment once, the stock once in food_order_step), so nothing here is trusted; each
 * step carries its own UUID made when the page was drawn (a double tap is the same step).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = [
  "step", "not_paid", "cash", "already_paid", "pay_method", "no_plan", "not_found", "sms_quota", "already_sent",
  "no_recipient", "settings", "name", "kind", "value", "amount", "too_many", "bad_request", "conflict",
] as const;
const reason = (message: string | undefined) => (REASONS.find((r) => r === message) ? `err_${message}` : "err_failed");

type Back = "list" | "detail" | "settings";

async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const order = String(formData.get("order_id") ?? "");
  const backValue = String(formData.get("back") ?? "list");
  const back: Back = backValue === "detail" || backValue === "settings" ? backValue : "list";
  const filter = String(formData.get("f") ?? "");
  const page = (query: Record<string, string>, anchor = ""): never => {
    const base =
      back === "detail" && UUID.test(order)
        ? `/${lang}/dashboard/assistant/orders/${order}`
        : back === "settings"
          ? `/${lang}/dashboard/assistant/orders/settings`
          : `/${lang}/dashboard/assistant/orders`;
    const q = new URLSearchParams({ ...(slug ? { shop: slug } : {}), ...(back === "list" && filter ? { f: filter } : {}), ...query });
    redirect(`${base}?${q}${anchor}`);
  };
  return { lang, session, shopId, slug, order, page };
}

const text = (formData: FormData, name: string, max: number) => String(formData.get(name) ?? "").trim().slice(0, max);
const cents = (value: string) => {
  const n = Number(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n * 100) : null;
};

/**
 * A status step and/or a payment mark ("Do prípravy", "Na ceste", "Pripravené na odber", "Doručené", "Zaplatil v
 * hotovosti", "Zrušiť"). With "SMS „Objednávka je na ceste“" ticked, the SMS is written down (owner_food_sms_queue,
 * the 'order' quota, once per order) and sent by the crm-messages function after the step went through.
 */
export async function orderStep(formData: FormData) {
  const { session, shopId, slug, order, page } = await start(formData);
  const step = String(formData.get("step_id") ?? "");
  const to = text(formData, "to", 20) || null;
  const pay = text(formData, "pay", 10) || null;
  const cashText = text(formData, "cash", 20);
  const cash = pay === "cash" && cashText ? cents(cashText) : null;
  if (!UUID.test(order) || !UUID.test(step)) page({ err: "err_failed" });
  if (pay === "cash" && cashText && cash === null) page({ err: "err_cash" });
  const { error } = await session.supabase.rpc("owner_food_order_status", {
    p_shop_id: shopId,
    p_order_id: order,
    p_to: to,
    p_step_id: step,
    p_pay_method: pay,
    p_cash_given_cents: cash,
    p_reason: text(formData, "reason", 200) || null,
  });
  if (error) page({ err: reason(error.message) });
  let ok = pay && !to ? "ok_paid" : "ok_status";
  if (to === "on_the_way" && formData.get("sms") === "1") {
    ok = (await sendOnWay(session.supabase, shopId, order)) ?? "ok_sms";
  }
  if (slug) refreshShop(slug);
  page({ ok: ok.startsWith("err_") ? "ok_status" : ok, ...(ok.startsWith("err_") ? { err: ok } : {}) });
}

/** The "on the way" SMS: written down in SQL first, then sent by crm-messages (which stores the result once). */
async function sendOnWay(
  supabase: NonNullable<Awaited<ReturnType<typeof getSession>>>["supabase"],
  shopId: string,
  order: string,
): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke<{ status?: string; error?: string }>("crm-messages", {
    body: { action: "food_sms", shop_id: shopId, order_id: order },
  });
  if (!error && data?.status) return data.status === "failed" ? "err_sms_failed" : null;
  let why: string | undefined;
  try {
    const context = (error as { context?: Response } | null)?.context;
    why = context ? ((await context.json()) as { error?: string }).error : data?.error;
  } catch {
    why = undefined;
  }
  return why ? reason(why) : "err_sms_failed";
}

/** "Poslať zákazníkovi SMS" on its own (an order already on the way). */
export async function orderSms(formData: FormData) {
  const { session, shopId, order, page } = await start(formData);
  if (!UUID.test(order)) page({ err: "err_failed" });
  const res = await sendOnWay(session.supabase, shopId, order);
  page(res ? { err: res } : { ok: "ok_sms" });
}

/** "Pozastaviť objednávky" / "Spustiť": the assistant stops (or starts) offering orders at once. */
export async function pauseOrders(formData: FormData) {
  const { session, shopId, slug, page } = await start(formData);
  const paused = formData.get("paused") === "1";
  const { error } = await session.supabase.rpc("owner_food_pause", { p_shop_id: shopId, p_paused: paused });
  if (error) page({ err: reason(error.message) });
  if (slug) refreshShop(slug);
  page({ ok: paused ? "ok_paused" : "ok_resumed" });
}

const BOOLEANS = [
  "enabled", "pickup_on", "delivery_on", "pay_qr", "pay_cash", "pay_card", "deduct_on_delivery", "alert_sound",
  "alert_email", "alert_telegram", "sms_on_the_way",
] as const;
const NUMBERS = { prep_minutes: [5, 240], delivery_minutes: [10, 300], last_order_minutes: [0, 240] } as const;

/** "Uložiť" on Nastavenia objednávok: every switch on the form (an unticked box = off), the three times. */
export async function saveFoodSettings(formData: FormData) {
  const { session, shopId, slug, page } = await start(formData);
  const p: Record<string, boolean | number> = {};
  for (const b of BOOLEANS) p[b] = formData.get(b) === "on";
  for (const [k, [lo, hi]] of Object.entries(NUMBERS)) {
    const n = Math.floor(Number(formData.get(k)));
    if (Number.isFinite(n) && n >= lo && n <= hi) p[k] = n;
  }
  const { error } = await session.supabase.rpc("owner_food_save_settings", { p_shop_id: shopId, p });
  if (error) page({ err: reason(error.message) });
  if (slug) refreshShop(slug);
  page({ ok: "ok_saved" });
}

/** "+ Pridať zónu" / editing a zone: town, postcode or kilometres, its fee and minimum (in euros on the form). */
export async function saveZone(formData: FormData) {
  const { session, shopId, slug, page } = await start(formData);
  const zone = String(formData.get("zone_id") ?? "");
  const fee = cents(text(formData, "fee", 12) || "0");
  const minimum = cents(text(formData, "minimum", 12) || "0");
  if (fee === null || minimum === null) page({ err: "err_amount" }, "#zones");
  const { error } = await session.supabase.rpc("owner_food_save_zone", {
    p_shop_id: shopId,
    p_id: UUID.test(zone) ? zone : null,
    p_name: text(formData, "name", 80),
    p_kind: text(formData, "kind", 20),
    p_value: text(formData, "value", 80),
    p_fee_cents: fee,
    p_minimum_cents: minimum,
    p_sort: null,
  });
  if (error) page({ err: reason(error.message) }, "#zones");
  if (slug) refreshShop(slug);
  page({ ok: "ok_zone" }, "#zones");
}

export async function deleteZone(formData: FormData) {
  const { session, shopId, slug, page } = await start(formData);
  const zone = String(formData.get("zone_id") ?? "");
  if (!UUID.test(zone)) page({ err: "err_not_found" }, "#zones");
  const { error } = await session.supabase.rpc("owner_food_delete_zone", { p_shop_id: shopId, p_id: zone });
  if (error) page({ err: reason(error.message) }, "#zones");
  if (slug) refreshShop(slug);
  page({ ok: "ok_zone_deleted" }, "#zones");
}

/**
 * "Skontrolovať, čo z menu nie je v Sklade": the menu's text (owner_food_menu_text: the Public folder, 10 a day) →
 * Claude lists the dish names (structured output; the menu is data) → the pairing with Sklad in SQL
 * (owner_food_menu_pair), kept for this page. Nothing is offered or priced from the menu.
 */
export async function checkMenu(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const doc = String(formData.get("document_id") ?? "");
  if (!UUID.test(doc)) page({ err: "err_not_found" }, "#menu");
  const { data: textData, error } = await session.supabase.rpc("owner_food_menu_text", { p_shop_id: shopId, p_document_id: doc });
  if (error) page({ err: reason(error.message) }, "#menu");
  const read = await readMenuNames(String(textData ?? ""), aiModel());
  if ("error" in read) page({ err: read.error === "ai_off" ? "err_ai_off" : read.error === "empty" ? "err_menu_empty" : "err_failed" }, "#menu");
  const names = "names" in read ? read.names : [];
  const pair = await session.supabase.rpc("owner_food_menu_pair", { p_shop_id: shopId, p_document_id: doc, p_names: names });
  if (pair.error) page({ err: reason(pair.error.message) }, "#menu");
  page({ ok: "ok_menu" }, "#menu");
}
