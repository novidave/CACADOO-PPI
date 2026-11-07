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
  // update 75 (couriers)
  "phone", "phone_taken", "limit", "inactive", "courier", "site", "sms_failed",
  // update 81 (the feed)
  "courier_app", "too_late", "delay",
  // update 87 (zones)
  "label", "zones",
] as const;
const reason = (message: string | undefined) => (REASONS.find((r) => r === message) ? `err_${message}` : "err_failed");

type Back = "list" | "detail" | "settings" | "menu" | "couriers";

async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const order = String(formData.get("order_id") ?? "");
  const backValue = String(formData.get("back") ?? "list");
  const back: Back =
    backValue === "detail" || backValue === "settings" || backValue === "menu" || backValue === "couriers" ? backValue : "list";
  const filter = String(formData.get("f") ?? "");
  const page = (query: Record<string, string>, anchor = ""): never => {
    const base =
      back === "detail" && UUID.test(order)
        ? `/${lang}/dashboard/assistant/orders/${order}`
        : back === "settings"
          ? `/${lang}/dashboard/assistant/orders/settings`
          : back === "menu"
            ? `/${lang}/dashboard/assistant/orders/menu`
            : back === "couriers"
            ? `/${lang}/dashboard/assistant/orders/couriers`
            : `/${lang}/dashboard/assistant/orders`;
    // update 79: the menu check is the "Menu" tab, on its own address
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

const BOOLEANS = [
  "enabled", "pickup_on", "delivery_on", "pay_qr", "pay_cash", "pay_card", "deduct_on_delivery", "alert_sound",
  "alert_email", "alert_telegram", "payments_on", "warn_long_delay",
] as const;
const NUMBERS = { prep_minutes: [5, 240], delivery_minutes: [10, 300], last_order_minutes: [0, 240] } as const;
const CHOICES = { delay_reset: ["close", "midnight", "never"], feed_order: ["newest", "oldest"] } as const;

/**
 * "Uložiť" on Nastavenia objednávok: every switch on the form (an unticked box = off), the times and the two choices.
 * Update 81: Aplikácia kuriéra is sent only while Donáška is on and QR terminál only while Platby are on — a greyed
 * switch keeps its own choice for later (switched off = not used, nothing changed). "Objednávka je na ceste" is NOT on
 * this form since 2026-11-07 (it is set on "SMS a Telegram"), so it is never sent from here: owner_food_save_settings
 * changes only the keys it gets.
 */
export async function saveFoodSettings(formData: FormData) {
  const { session, shopId, slug, page } = await start(formData);
  const p: Record<string, boolean | number | string> = {};
  for (const b of BOOLEANS) p[b] = formData.get(b) === "on";
  if (p.delivery_on) p.courier_app = formData.get("courier_app") === "on";
  if (p.payments_on) p.qr_terminal = formData.get("qr_terminal") === "on";
  for (const [k, allowed] of Object.entries(CHOICES)) {
    const v = String(formData.get(k) ?? "");
    if ((allowed as readonly string[]).includes(v)) p[k] = v;
  }
  for (const [k, [lo, hi]] of Object.entries(NUMBERS)) {
    const n = Math.floor(Number(formData.get(k)));
    if (Number.isFinite(n) && n >= lo && n <= hi) p[k] = n;
  }
  // update 85: "Poznámka k platbe po objednaní" (empty = the default line, "-" = none; SQL cleans it, ≤ 120)
  if (formData.has("pay_note")) p.pay_note = String(formData.get("pay_note") ?? "").slice(0, 300);
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
    // update 87: "Názov pre zákazníka" ('' = none; SQL keeps plain text, ≤ 40)
    p_label: String(formData.get("label") ?? "").slice(0, 200),
  });
  if (error) page({ err: reason(error.message) }, "#zones");
  if (slug) refreshShop(slug);
  page({ ok: "ok_zone" }, "#zones");
}

/** ▲ ▼ (update 87): one zone a place up or down; the database stores the whole order (owner_food_order_zones). */
export async function moveZone(formData: FormData) {
  const { session, shopId, slug, page } = await start(formData);
  const zone = String(formData.get("zone_id") ?? "");
  const dir = formData.get("dir") === "up" ? -1 : 1;
  if (!UUID.test(zone)) page({ err: "err_not_found" }, "#zones");
  const { data, error: readError } = await session.supabase.rpc("owner_food_settings", { p_shop_id: shopId });
  if (readError) page({ err: reason(readError.message) }, "#zones");
  const ids = ((data as { zones?: { id: string }[] } | null)?.zones ?? []).map((z) => z.id);
  const at = ids.indexOf(zone);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= ids.length) page({}, "#zones");
  [ids[at], ids[to]] = [ids[to], ids[at]];
  const { error } = await session.supabase.rpc("owner_food_order_zones", { p_shop_id: shopId, p_ids: ids });
  if (error) page({ err: reason(error.message) }, "#zones");
  if (slug) refreshShop(slug);
  page({ ok: "ok_zones_ordered" }, "#zones");
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

// ---------------------------------------------------------------- update 75: couriers ("Kuriéri", board 19 / artboard 6)

/** "Pridať" / "Uložiť" a courier (a name and a mobile number; the shop's country decides a number without +). */
export async function saveCourier(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const id = String(formData.get("courier_id") ?? "");
  const { error } = await session.supabase.rpc("owner_food_courier_save", {
    p_shop_id: shopId,
    p_id: UUID.test(id) ? id : null,
    p_name: text(formData, "name", 60),
    p_phone: text(formData, "phone", 40),
    p_active: null,
  });
  if (error) page({ err: reason(error.message) }, UUID.test(id) ? `#c-${id}` : "#add");
  page({ ok: "ok_courier_saved" }, UUID.test(id) ? `#c-${id}` : "");
}

/** "Deaktivovať" / "Aktivovať": switching a courier off signs every phone of theirs out at once (in SQL). */
export async function setCourierActive(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const id = String(formData.get("courier_id") ?? "");
  if (!UUID.test(id)) page({ err: "err_not_found" });
  const { data } = await session.supabase.rpc("owner_food_couriers", { p_shop_id: shopId });
  const c = ((data as { couriers?: { id: string; name: string; phone: string }[] } | null)?.couriers ?? []).find((x) => x.id === id);
  if (!c) page({ err: "err_not_found" });
  const { error } = await session.supabase.rpc("owner_food_courier_save", {
    p_shop_id: shopId,
    p_id: id,
    p_name: c!.name,
    p_phone: c!.phone,
    p_active: formData.get("active") === "1",
  });
  if (error) page({ err: reason(error.message) }, `#c-${id}`);
  page({ ok: "ok_courier_saved" }, `#c-${id}`);
}

/** "Poslať pozvánku SMS": written down in SQL first (the owner quota), then sent by crm-messages. */
export async function inviteCourier(formData: FormData) {
  const { lang, session, shopId, page } = await start(formData);
  const id = String(formData.get("courier_id") ?? "");
  if (!UUID.test(id)) page({ err: "err_not_found" });
  const { data, error } = await session.supabase.functions.invoke<{ status?: string }>("crm-messages", {
    body: { action: "courier_invite", shop_id: shopId, courier_id: id, lang },
  });
  if (!error && data?.status) page(data.status === "failed" ? { err: "err_sms_failed" } : { ok: "ok_courier_invited" }, `#c-${id}`);
  let why: string | undefined;
  try {
    const context = (error as { context?: Response } | null)?.context;
    why = context ? ((await context.json()) as { error?: string }).error : undefined;
  } catch {
    why = undefined;
  }
  page({ err: why ? reason(why) : "err_sms_failed" }, `#c-${id}`);
}

/** "Odhlásiť z telefónu": every key of the courier ends. */
export async function logoutCourier(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const id = String(formData.get("courier_id") ?? "");
  if (!UUID.test(id)) page({ err: "err_not_found" });
  const { error } = await session.supabase.rpc("owner_food_courier_logout", { p_shop_id: shopId, p_id: id });
  if (error) page({ err: reason(error.message) }, `#c-${id}`);
  page({ ok: "ok_courier_logged_out" }, `#c-${id}`);
}

/** "Vyúčtovať hotovosť": the courier handed the cash over. */
export async function settleCourier(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const id = String(formData.get("courier_id") ?? "");
  if (!UUID.test(id)) page({ err: "err_not_found" });
  const { error } = await session.supabase.rpc("owner_food_courier_settle", { p_shop_id: shopId, p_id: id });
  if (error) page({ err: reason(error.message) }, `#c-${id}`);
  page({ ok: "ok_courier_settled" }, `#c-${id}`);
}

/** "Prideľovanie donášok": manual or automatic, and what couriers may mark (an unticked switch = off). */
export async function saveCourierSettings(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const p = {
    assign_mode: formData.get("assign_mode") === "auto" ? "auto" : "manual",
    courier_can_qr: formData.get("courier_can_qr") === "on",
    courier_can_cash: formData.get("courier_can_cash") === "on",
    courier_has_card: formData.get("courier_has_card") === "on",
  };
  const { error } = await session.supabase.rpc("owner_food_save_settings", { p_shop_id: shopId, p });
  if (error) page({ err: reason(error.message) }, "#assign");
  page({ ok: "ok_saved" }, "#assign");
}

/** "Prideliť" on an order: a courier (or none); the step's own UUID once. */
export async function assignCourier(formData: FormData) {
  const { session, shopId, order, page } = await start(formData);
  const courier = String(formData.get("courier_id") ?? "");
  const step = String(formData.get("step_id") ?? "");
  if (!UUID.test(order) || !UUID.test(step)) page({ err: "err_failed" });
  const { error } = await session.supabase.rpc("owner_food_assign", {
    p_shop_id: shopId,
    p_order_id: order,
    p_courier_id: UUID.test(courier) ? courier : null,
    p_step_id: step,
  });
  if (error) page({ err: reason(error.message) });
  page({ ok: "ok_assigned" });
}
