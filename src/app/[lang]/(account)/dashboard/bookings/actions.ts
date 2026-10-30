"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { siteUrl } from "@/lib/site";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["confirmed", "cancelled", "no_show"];

/** Who is asking and for which shop; the owner_* functions and the bookings function decide what they may do. */
async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const page = (query: Record<string, string>) => {
    const view = String(formData.get("view") ?? "");
    const week = String(formData.get("week") ?? "");
    return `/${lang}/dashboard/bookings?${new URLSearchParams({
      ...(slug ? { shop: slug } : {}),
      ...(view ? { view } : {}),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(week) ? { week } : {}),
      ...query,
    })}`;
  };
  return { lang, session, shopId, slug, page };
}

const int = (formData: FormData, name: string) => Math.floor(Number(formData.get(name)));

/** "Nastavenia rezervácií" (members with the plan). */
export async function saveBookingSettings(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const { error } = await session.supabase.rpc("owner_save_booking_settings", {
    p_shop_id: shopId,
    p_enabled: formData.get("enabled") === "on",
    p_service_name: String(formData.get("service_name") ?? "").slice(0, 80),
    p_duration: int(formData, "duration"),
    p_step: int(formData, "step"),
    p_buffer: int(formData, "buffer") || 0,
    p_lead: (int(formData, "lead_hours") || 0) * 60,
    p_horizon: int(formData, "horizon"),
    p_reminder: formData.get("reminder") === "on",
  });
  redirect(page({ view: "settings", ...(error ? { err: error.message === "no_plan" ? "err_no_plan" : "err_settings" } : { ok: "ok_settings" }) }));
}

/** Potvrdená / Zrušená / Neprišiel. */
export async function setBookingStatus(formData: FormData) {
  const { session, page } = await start(formData);
  const id = String(formData.get("booking_id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!UUID.test(id) || !STATUSES.includes(status)) redirect(page({ err: "err_failed" }));
  const { error } = await session.supabase.rpc("owner_set_booking_status", { p_id: id, p_status: status });
  redirect(page(error ? { err: error.message === "slot_taken" ? "err_slot_taken" : "err_failed" } : { ok: "ok_status" }));
}

/** "Pripojiť Google Kalendár": the bookings function returns Google's consent page (PKCE, the two scopes only). */
export async function connectGoogle(formData: FormData) {
  const { lang, session, shopId, slug, page } = await start(formData);
  const back = `${siteUrl()}/${lang}/dashboard/bookings?${new URLSearchParams({ shop: slug, view: "settings" })}`;
  const { data, error } = await session.supabase.functions.invoke<{ url?: string }>("bookings", {
    body: { action: "google_connect", shop_id: shopId, return_url: back },
  });
  if (error || !data?.url) redirect(page({ view: "settings", err: "calendar_failed" }));
  redirect(data.url);
}

/** "Odpojiť": the token is revoked at Google and deleted here. */
export async function disconnectGoogle(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const { error } = await session.supabase.functions.invoke("bookings", { body: { action: "google_disconnect", shop_id: shopId } });
  redirect(page({ view: "settings", ...(error ? { err: "err_failed" } : { ok: "calendar_disconnected" }) }));
}
