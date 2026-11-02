"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { refreshShop } from "@/lib/publicCache";
import { DEVICE_COOKIE, DEVICE_COOKIE_DAYS, deviceRpc, deviceToken, deviceWhoami } from "@/lib/skladDevice";
import { createPublicClient } from "@/lib/supabase/public";

/**
 * A paired phone's actions (database update 72). Pairing turns the one-time code (from the QR code's "#") into the
 * phone's key, kept only in an HttpOnly cookie. Everything else goes through the phone's door (deviceRpc →
 * sklad_device_call), which decides what the phone may do.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^skp_[0-9a-f]{64}$/;
const langOf = (v: unknown): Locale => (isLocale(String(v ?? "")) ? (String(v) as Locale) : "sk");
const reasonOf = (m: string | undefined) =>
  ["device", "device_expired", "forbidden", "too_many", "qty", "not_found", "done", "cancelled", "no_price", "empty", "sale_source", "sklad_active"].find(
    (r) => r === m,
  ) ?? "failed";

/** "Pripojiť toto zariadenie": the code once → the key in this browser's cookie. */
export async function pairDevice(input: { lang: string; code: string }): Promise<{ ok: boolean; error?: string }> {
  const code = String(input.code ?? "").trim();
  if (!CODE.test(code)) return { ok: false, error: "code" };
  const client = createPublicClient();
  if (!client) return { ok: false, error: "failed" };
  const { data, error } = await client.rpc("sklad_device_claim", { p_code: code });
  if (error || !data) return { ok: false, error: error?.message === "code" ? "code" : "failed" };
  (await cookies()).set(DEVICE_COOKIE, (data as { token: string }).token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_COOKIE_DAYS * 86400,
  });
  return { ok: true };
}

/** "Odpojiť toto zariadenie" on the phone: its key stops working, the cookie goes. */
export async function forgetDevice(formData: FormData) {
  const lang = langOf(formData.get("lang"));
  const token = await deviceToken();
  const client = createPublicClient();
  if (token && client) await client.rpc("sklad_device_forget", { p_token: token });
  (await cookies()).delete(DEVICE_COOKIE);
  redirect(`/${lang}/zariadenie?ok=forgotten`);
}

/** "Príjem tovaru": pieces of one product into the shop's receiving place (never a purchase price). */
export async function receiveStock(formData: FormData) {
  const lang = langOf(formData.get("lang"));
  const back = (q: Record<string, string>) => redirect(`/${lang}/zariadenie/prijem?${new URLSearchParams(q)}`);
  const rpc = await deviceRpc();
  const item = String(formData.get("item_id") ?? "");
  const mid = String(formData.get("mid") ?? "");
  const qty = Number(String(formData.get("qty") ?? "").replace(",", "."));
  if (!rpc) redirect(`/${lang}/zariadenie`);
  if (!UUID.test(item) || !UUID.test(mid)) back({ err: "failed" });
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) back({ item, err: "qty" });
  const { error } = await rpc!("owner_sklad_move", { p_id: mid, p_item_id: item, p_kind: "receipt", p_qty: Math.round(qty * 1000) / 1000 });
  if (error) back({ item, err: reasonOf(error.message) });
  const slug = String(formData.get("shop_slug") ?? "");
  if (slug) refreshShop(slug);
  back({ ok: "received", n: String(qty), name: String(formData.get("item_name") ?? "").slice(0, 120) });
}

async function saleAct(formData: FormData, fn: "owner_sklad_sale_paid" | "owner_sklad_sale_cancel") {
  const lang = langOf(formData.get("lang"));
  const sale = String(formData.get("sale_id") ?? "");
  const rpc = await deviceRpc();
  if (!rpc) redirect(`/${lang}/zariadenie`);
  if (!UUID.test(sale)) redirect(`/${lang}/zariadenie/predaj`);
  const { error } = await rpc!(fn, { p_sale_id: sale });
  const page = `/${lang}/zariadenie/predaj/${sale}`;
  if (error) redirect(`${page}?err=${reasonOf(error.message)}`);
  return { lang, sale, page };
}

/** "Zaplatené – potvrdiť predaj" on the phone's QR page. */
export async function deviceSalePaid(formData: FormData) {
  const { page } = await saleAct(formData, "owner_sklad_sale_paid");
  const who = await deviceWhoami();
  if (who) refreshShop(who.shop.slug);
  redirect(`${page}?ok=sold`);
}

/** "Zrušiť predaj" / "Zaplatí inak" on the phone's QR page. */
export async function deviceSaleCancel(formData: FormData) {
  const { lang } = await saleAct(formData, "owner_sklad_sale_cancel");
  redirect(`/${lang}/zariadenie/predaj${formData.get("other") === "1" ? "" : "?ok=sale_cancelled"}`);
}
