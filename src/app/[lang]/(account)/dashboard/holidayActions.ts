"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { sectionUrl } from "@/lib/dashboardPages";
import { rangesFor, weekdayOf, type OpeningHours } from "@/lib/hours";
import { refreshShop } from "@/lib/publicCache";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

/**
 * "Sviatky a mimoriadne zatvorenie" (database update 27): every change goes through an owner
 * function that checks the caller owns the shop; the form comes back to its section.
 */
async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const back = (query: Record<string, string>) => {
    // A saved change a visitor can see: the public pages read it again at once.
    if (query.ok) refreshShop(slug);
    return redirect(sectionUrl(lang, "holidays", { shop: slug, ...query }));
  };
  if (!UUID.test(shopId)) back({ err: "invalid shop" });
  return { session, shopId, back };
}

const errorOf = (message: string) => (message === "dates" ? "special_dates" : message === "ranges" ? "special_ranges" : message);

/** "Automatické štátne sviatky" on or off (owner_set_auto_holidays). */
export async function setAutoHolidays(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const { error } = await session.supabase.rpc("owner_set_auto_holidays", { p_shop_id: shopId, p_on: formData.get("auto") === "on" });
  back(error ? { err: error.message } : { ok: "holidays_auto" });
}

/** A special day or a date range: closed all day, or other hours (a break allowed), with a note. */
export async function saveSpecialHours(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const from = String(formData.get("from") ?? "");
  const to = String(formData.get("to") ?? "") || from;
  if (!DATE.test(from) || !DATE.test(to)) back({ err: "special_dates" });
  const closed = formData.get("mode") !== "hours";
  const ranges: [string, string][] = [];
  for (const n of [1, 2]) {
    const a = String(formData.get(`r${n}_from`) ?? "");
    const b = String(formData.get(`r${n}_to`) ?? "");
    if (a && b && TIME.test(a) && TIME.test(b)) ranges.push([a, b]);
  }
  if (!closed && ranges.length === 0) back({ err: "special_ranges" });
  const { error } = await session.supabase.rpc("owner_save_special_hours", {
    p_shop_id: shopId,
    p_from: from,
    p_to: to,
    p_closed: closed,
    p_ranges: closed ? [] : ranges,
    p_note: String(formData.get("note") ?? "").slice(0, 400),
  });
  back(error ? { err: errorOf(error.message), date: from } : { ok: "special_saved" });
}

export async function deleteSpecialHours(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const date = String(formData.get("date") ?? "");
  if (!DATE.test(date)) back({ err: "special_dates" });
  const { error } = await session.supabase.rpc("owner_delete_special_hours", { p_shop_id: shopId, p_date: date });
  back(error ? { err: error.message } : { ok: "special_deleted" });
}

/**
 * "Vymazať vybrané": the ticked special days, each through owner_delete_special_hours (which
 * checks the caller owns the shop), a few at a time.
 */
export async function deleteSpecialDays(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const dates = [...new Set(formData.getAll("dates").map(String))].filter((d) => DATE.test(d)).slice(0, 400);
  if (dates.length === 0) back({ err: "special_none" });
  for (let i = 0; i < dates.length; i += 10) {
    const results = await Promise.all(
      dates.slice(i, i + 10).map((date) => session.supabase.rpc("owner_delete_special_hours", { p_shop_id: shopId, p_date: date })),
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) back({ err: failed.error.message });
  }
  back({ ok: "special_deleted_many" });
}

/** A holiday's button: "Otvorené ako zvyčajne" (that weekday's regular hours) or "Zatvorené". */
export async function holidayChoice(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const date = String(formData.get("date") ?? "");
  if (!DATE.test(date)) back({ err: "special_dates" });
  let ranges: [string, string][] = [];
  if (formData.get("choice") === "usual") {
    const { data } = await session.supabase.from("shops").select("opening_hours").eq("id", shopId).maybeSingle();
    ranges = rangesFor((data?.opening_hours ?? null) as OpeningHours | null, weekdayOf(date)).slice(0, 4);
  }
  const { error } = await session.supabase.rpc("owner_save_special_hours", {
    p_shop_id: shopId,
    p_from: date,
    p_to: date,
    p_closed: ranges.length === 0,
    p_ranges: ranges,
    p_note: null,
  });
  back(error ? { err: errorOf(error.message) } : { ok: "special_saved" });
}
