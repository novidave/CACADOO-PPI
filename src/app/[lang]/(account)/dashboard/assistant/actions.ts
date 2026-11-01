"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { localInstant } from "@/lib/bookingTools";
import { siteUrl } from "@/lib/site";

/**
 * Update 63, Asistent → Nastavenia: the automatic messages (crm_settings), the bookings' rules, services, resources and
 * blocked times, and the calendar link for a phone. Every rule and every refusal is in SQL (owner_* functions:
 * membership, the plan, the limits); here only the form's fields are read and the owner is sent back with a message.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The database's own refusals that have a text (`asst.err_<reason>`); anything else is "err_failed". */
const REASONS = [
  "no_plan", "name", "service", "resource", "too_many", "not_found", "rules", "block", "kind", "hours", "offset", "email",
  "duplicate",
] as const;

const reason = (message: string | undefined) => (REASONS.find((r) => r === message) ? `err_${message}` : "err_failed");

async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const part = String(formData.get("part") ?? "").replace(/[^a-z-]/g, "");
  const back = (query: Record<string, string>): never =>
    redirect(`/${lang}/dashboard/assistant?${new URLSearchParams({ shop: slug, at: "settings", ...(part ? { part } : {}), ...query })}${part ? `#${part}` : ""}`);
  if (!UUID.test(shopId)) back({ err: "err_failed" });
  return { lang, session, shopId, slug, back };
}

const int = (formData: FormData, name: string, fallback = 0) => {
  const n = Math.floor(Number(formData.get(name)));
  return Number.isFinite(n) ? n : fallback;
};
const text = (formData: FormData, name: string, max: number) => String(formData.get(name) ?? "").trim().slice(0, max);
const ids = (formData: FormData, name: string) => formData.getAll(name).map(String).filter((v) => UUID.test(v));
const optionalId = (formData: FormData, name: string) => {
  const v = String(formData.get(name) ?? "");
  return UUID.test(v) ? v : null;
};

/** "Automatické správy": the reminder (on, 2 h before or the evening before), the alert e-mail, SMS on owner changes. */
export async function saveCrmSettings(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const { error } = await session.supabase.rpc("owner_save_crm_settings", {
    p_shop_id: shopId,
    p_reminder_on: formData.get("reminder_on") === "on",
    p_reminder_offset: formData.get("reminder_offset") === "2h" ? "2h" : "day_before_18",
    p_alert_email: text(formData, "alert_email", 254) || null,
    p_notify_on_owner_change: formData.get("notify_on_owner_change") === "on",
  });
  back(error ? { err: reason(error.message) } : { ok: "ok_saved" });
}

/** "Pravidlá": bookings on/off, the earliest notice (hours), how far ahead (days), the step, bookings per contact a day. */
export async function saveBookingRules(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const { error } = await session.supabase.rpc("owner_save_booking_rules", {
    p_shop_id: shopId,
    p_enabled: formData.get("enabled") === "on",
    p_min_notice: Math.round(Number(formData.get("min_notice_hours") ?? 0) * 60) || 0,
    p_max_days: int(formData, "max_days", 30),
    p_step: [5, 10, 15, 30].includes(int(formData, "step", 15)) ? int(formData, "step", 15) : 15,
    p_max_per_contact_day: Math.min(Math.max(int(formData, "max_per_contact_day", 2), 1), 20),
  });
  back(error ? { err: reason(error.message) } : { ok: "ok_saved" });
}

/** "Služby": a new one (no id) or a change; the resources it may use are ticked. */
export async function saveService(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const { error } = await session.supabase.rpc("owner_save_booking_service", {
    p_shop_id: shopId,
    p_id: optionalId(formData, "service_id"),
    p_name: text(formData, "name", 80),
    p_duration: int(formData, "duration", 30),
    p_buffer_before: int(formData, "buffer_before"),
    p_buffer_after: int(formData, "buffer_after"),
    p_capacity: Math.max(int(formData, "capacity", 1), 1),
    p_needs_resource: formData.get("needs_resource") === "on",
    p_active: formData.get("active") === "on",
    p_offered_by_assistant: formData.get("offered_by_assistant") === "on",
    p_note: text(formData, "note", 300) || null,
    p_resource_ids: ids(formData, "resource_ids"),
  });
  back(error ? { err: reason(error.message) } : { ok: "ok_saved" });
}

export async function removeService(formData: FormData) {
  const { session, back } = await start(formData);
  const id = optionalId(formData, "service_id");
  const { error } = id ? await session.supabase.rpc("owner_remove_booking_service", { p_id: id }) : { error: { message: "not_found" } };
  back(error ? { err: reason(error.message) } : { ok: "ok_removed" });
}

/** "Zdroje" (a person, a machine or a room): its own hours = the shop's hours unless the owner sets them later. */
export async function saveResource(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const kind = String(formData.get("kind") ?? "person");
  const { error } = await session.supabase.rpc("owner_save_booking_resource", {
    p_shop_id: shopId,
    p_id: optionalId(formData, "resource_id"),
    p_name: text(formData, "name", 80),
    p_kind: ["person", "machine", "room"].includes(kind) ? kind : "person",
    p_active: formData.get("active") === "on",
    p_hours: null,
    p_service_ids: ids(formData, "service_ids"),
  });
  back(error ? { err: reason(error.message) } : { ok: "ok_saved" });
}

export async function removeResource(formData: FormData) {
  const { session, back } = await start(formData);
  const id = optionalId(formData, "resource_id");
  const { error } = id ? await session.supabase.rpc("owner_remove_booking_resource", { p_id: id }) : { error: { message: "not_found" } };
  back(error ? { err: reason(error.message) } : { ok: "ok_removed" });
}

/** "Blokované časy": a time nobody can book (the whole shop or one resource). */
export async function saveBlock(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const tz = text(formData, "timezone", 60) || "UTC";
  // two datetime-local fields ("2026-11-06T10:30") in the shop's time zone
  const at = (name: string) => {
    const [day, time] = text(formData, name, 16).split("T");
    return localInstant(day ?? "", time ?? "", tz)?.toISOString() ?? null;
  };
  const from = at("from");
  const to = at("to");
  if (!from || !to) back({ err: "err_block" });
  const { error } = await session.supabase.rpc("owner_save_booking_block", {
    p_shop_id: shopId,
    p_id: null,
    p_resource_id: optionalId(formData, "resource_id"),
    p_starts_at: from,
    p_ends_at: to,
    p_note: text(formData, "note", 200) || null,
  });
  back(error ? { err: reason(error.message) } : { ok: "ok_saved" });
}

export async function removeBlock(formData: FormData) {
  const { session, back } = await start(formData);
  const id = optionalId(formData, "block_id");
  const { error } = id ? await session.supabase.rpc("owner_remove_booking_block", { p_id: id }) : { error: { message: "not_found" } };
  back(error ? { err: reason(error.message) } : { ok: "ok_removed" });
}

export interface FeedState {
  url?: string;
  error?: string;
}

/**
 * "Odkaz pre kalendár v telefóne": a new secret link (the old one stops at once). It is shown once, here in the page and
 * never in an address bar or a log; only its hash is stored.
 */
export async function newCalendarFeed(_state: FeedState, formData: FormData): Promise<FeedState> {
  const session = await getSession();
  if (!session) return { error: "err_failed" };
  const shopId = String(formData.get("shop_id") ?? "");
  if (!UUID.test(shopId)) return { error: "err_failed" };
  const { data, error } = await session.supabase.rpc("owner_calendar_feed_new", { p_shop_id: shopId });
  if (error || typeof data !== "string") return { error: reason(error?.message) };
  return { url: `${siteUrl()}/api/calendar/${data}` };
}

export async function calendarFeedOff(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const { error } = await session.supabase.rpc("owner_calendar_feed_off", { p_shop_id: shopId });
  back(error ? { err: reason(error.message) } : { ok: "ok_feed_off" });
}
