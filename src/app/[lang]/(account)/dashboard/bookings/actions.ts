"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { localInstant } from "@/lib/bookingTools";
import { siteUrl } from "@/lib/site";

/**
 * Asistent → Rezervácie (update 63): the owner adds, moves, cancels and marks bookings. Cacaduu's own booking system is the
 * source of truth: owner_booking_create / _move check the time again under the lane's lock (opening hours, blocks, other
 * bookings with their buffers, capacity), so nothing here is trusted; a move or a cancel queues the customer's SMS when
 * "SMS pri zmene" is on, and the optional Google Calendar follows from the job.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REASONS = [
  "no_plan", "slot_taken", "not_available", "service", "resource", "people", "phone", "name", "not_found", "status",
  "not_confirmed", "contact_limit", "no_contact",
] as const;
const reason = (message: string | undefined) => (REASONS.find((r) => r === message) ? `err_${message}` : "err_failed");

/** Who is asking and for which shop; the owner_* functions and the bookings function decide what they may do. */
async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const day = String(formData.get("day") ?? "");
  const page = (query: Record<string, string>): never =>
    redirect(`/${lang}/dashboard/bookings?${new URLSearchParams({
      ...(slug ? { shop: slug } : {}),
      ...(DAY.test(day) ? { day } : {}),
      ...query,
    })}`);
  return { lang, session, shopId, slug, page };
}

const text = (formData: FormData, name: string, max: number) => String(formData.get(name) ?? "").trim().slice(0, max);
const id = (formData: FormData, name: string) => {
  const v = String(formData.get(name) ?? "");
  return UUID.test(v) ? v : null;
};

/** "+ Rezervácia": a free time the page offered (owner_booking_free_slots) for a contact or a new name + phone. */
export async function createBooking(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const startsAt = text(formData, "starts_at", 40);
  if (Number.isNaN(Date.parse(startsAt))) page({ new: "1", err: "err_time" });
  const { error } = await session.supabase.rpc("owner_booking_create", {
    p_shop_id: shopId,
    p_service_id: id(formData, "service_id"),
    p_starts_at: new Date(startsAt).toISOString(),
    p_resource_id: id(formData, "resource_id"),
    p_people: Math.min(Math.max(Math.floor(Number(formData.get("people")) || 1), 1), 500),
    p_contact_id: id(formData, "contact_id"),
    p_name: text(formData, "name", 120) || null,
    p_phone: text(formData, "phone", 40) || null,
    p_note: text(formData, "note", 500) || null,
  });
  page(error ? { new: "1", err: reason(error.message) } : { ok: "ok_created" });
}

/** "Presunúť": a new day and time in the shop's time zone (checked again like a new booking; the customer gets an SMS). */
export async function moveBooking(formData: FormData) {
  const { session, page } = await start(formData);
  const booking = id(formData, "booking_id");
  const [day, time] = text(formData, "to", 16).split("T");
  const to = localInstant(day ?? "", time ?? "", text(formData, "timezone", 60) || "UTC");
  if (!booking || !to) page({ err: "err_time" });
  const { error } = await session.supabase.rpc("owner_booking_move", { p_id: booking, p_starts_at: to!.toISOString(), p_resource_id: null });
  page(error ? { err: reason(error.message) } : { ok: "ok_moved", day: day ?? "" });
}

export async function cancelBooking(formData: FormData) {
  const { session, page } = await start(formData);
  const booking = id(formData, "booking_id");
  const { error } = booking ? await session.supabase.rpc("owner_booking_cancel", { p_id: booking }) : { error: { message: "not_found" } };
  page(error ? { err: reason(error.message) } : { ok: "ok_cancelled" });
}

/** "Prišiel" (done) / "Neprišiel" (no_show). */
export async function markBooking(formData: FormData) {
  const { session, page } = await start(formData);
  const booking = id(formData, "booking_id");
  const status = formData.get("status") === "no_show" ? "no_show" : "done";
  const { error } = booking ? await session.supabase.rpc("owner_booking_mark", { p_id: booking, p_status: status }) : { error: { message: "not_found" } };
  page(error ? { err: reason(error.message) } : { ok: "ok_marked" });
}

/** "Pripojiť Google Kalendár": the bookings function returns Google's consent page (PKCE, the two scopes only). */
export async function connectGoogle(formData: FormData) {
  const { lang, session, shopId, slug, page } = await start(formData);
  // Google comes back to this page (the function accepts only /dashboard/bookings), which forwards to Nastavenia.
  const back = `${siteUrl()}/${lang}/dashboard/bookings?${new URLSearchParams({ shop: slug, view: "settings" })}`;
  const { data, error } = await session.supabase.functions.invoke<{ url?: string }>("bookings", {
    body: { action: "google_connect", shop_id: shopId, return_url: back },
  });
  if (error || !data?.url) page({ view: "settings", err: "calendar_failed" });
  redirect(data!.url!);
}

/** "Odpojiť": the token is revoked at Google and deleted here; no booking changes. */
export async function disconnectGoogle(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const { error } = await session.supabase.functions.invoke("bookings", { body: { action: "google_disconnect", shop_id: shopId } });
  page({ view: "settings", ...(error ? { err: "err_failed" } : { ok: "calendar_disconnected" }) });
}
