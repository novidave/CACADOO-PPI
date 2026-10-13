"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { callDomains } from "@/lib/domains";

/**
 * "Predplatné a domény" (admin only). The page is shown only to is_admin; every action is
 * checked again where it runs: the admin_* SQL functions and the domains function both ask
 * is_admin() with the caller's own login.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const keep = String(formData.get("keep") ?? "");
  const back = (query: Record<string, string>, at = "shops"): never => {
    const params = new URLSearchParams(keep.startsWith("?") ? keep.slice(1) : keep);
    for (const [k, v] of Object.entries(query)) params.set(k, v);
    redirect(`/${lang}/admin/domains?${params}#${at}`);
  };
  return { session, back };
}

/** "19,90" / "19.90" → 1990. */
function cents(value: FormDataEntryValue | null): number | null {
  const n = Number.parseFloat(String(value ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

export async function saveDomainSettings(formData: FormData) {
  const { session, back } = await start(formData);
  const low = Number.parseFloat(String(formData.get("low_credit") ?? "").replace(",", "."));
  const { error } = await session.supabase.rpc("admin_save_domain_settings", {
    p_search_url: String(formData.get("search_url") ?? "").trim(),
    p_same_price: formData.get("same_price") === "on",
    p_low_credit: Number.isFinite(low) && low >= 0 ? low : null,
    p_test_domain: String(formData.get("test_domain") ?? "").trim(),
  });
  back(error ? { err: error.message.slice(0, 200) } : { ok: "settings" }, "settings");
}

export async function saveDomainPrice(formData: FormData) {
  const { session, back } = await start(formData);
  const price = cents(formData.get("price"));
  const renewal = cents(formData.get("renewal"));
  if (!price || !renewal) back({ err: "price" }, "prices");
  const { error } = await session.supabase.rpc("admin_save_domain_price", {
    p_tld: String(formData.get("tld") ?? "").trim(),
    p_price_cents: price,
    p_renewal_cents: renewal,
    p_vat_included: formData.get("vat_included") === "on",
    p_sort: Math.floor(Number(formData.get("sort")) || 100),
    p_active: formData.get("active") === "on",
  });
  back(error ? { err: error.message.slice(0, 200) } : { ok: "price" }, "prices");
}

export async function deleteDomainPrice(formData: FormData) {
  const { session, back } = await start(formData);
  const { error } = await session.supabase.rpc("admin_delete_domain_price", { p_tld: String(formData.get("tld") ?? "") });
  back(error ? { err: error.message.slice(0, 200) } : { ok: "price" }, "prices");
}

export async function refreshCredit(formData: FormData) {
  const { session, back } = await start(formData);
  const { error } = await callDomains(session.supabase, { action: "admin_credit" });
  back(error ? { err: error } : { ok: "credit" }, "credit");
}

/** One row's action: retry the step / resend the e-mail / resolved / transfer code / check DNS. */
export async function domainAction(formData: FormData) {
  const { session, back } = await start(formData);
  const id = String(formData.get("order_id") ?? "");
  const action = String(formData.get("do") ?? "");
  if (!UUID.test(id)) back({ err: "order" });
  if (action === "resolve") {
    const { error } = await session.supabase.rpc("admin_resolve_domain", { p_id: id });
    back(error ? { err: error.message.slice(0, 200) } : { ok: "done" });
  }
  const map: Record<string, string> = {
    retry: "admin_retry",
    dns: "admin_retry",
    email: "admin_email",
    auth: "admin_auth_code",
    save_auth: "admin_save_auth_code",
  };
  if (!map[action]) back({ err: "action" });
  const { error } = await callDomains(session.supabase, {
    action: map[action],
    order_id: id,
    ...(action === "save_auth" ? { auth_code: String(formData.get("auth_code") ?? "").slice(0, 100) } : {}),
  });
  back(error ? { err: error } : { ok: "done", ...(action === "auth" ? { code_for: id } : {}) });
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "Sviatky": the admin adds, changes or removes a public holiday per country (database update
 * 27). The admin's rows always win over the library's and the script never touches them;
 * admin_save_holiday / admin_delete_holiday check is_admin() themselves.
 */
export async function saveHoliday(formData: FormData) {
  const { session, back } = await start(formData);
  const country = String(formData.get("country") ?? "").trim().toUpperCase();
  const date = String(formData.get("date") ?? "");
  const kind = String(formData.get("kind") ?? "");
  if (!/^[A-Z]{2}$/.test(country) || !DATE.test(date) || !["day_off", "shops_closed", "removed"].includes(kind)) {
    back({ err: "holiday" }, "holidays");
  }
  const { error } = await session.supabase.rpc("admin_save_holiday", {
    p_country: country,
    p_date: date,
    p_kind: kind,
    p_closed_from: String(formData.get("closed_from") ?? "") || null,
    p_name_sk: String(formData.get("name_sk") ?? ""),
    p_name_hu: String(formData.get("name_hu") ?? ""),
    p_name_en: String(formData.get("name_en") ?? ""),
  });
  back(error ? { err: error.message.slice(0, 200) } : { ok: "holiday" }, "holidays");
}

/** Deletes the admin's own row for a date: the library's row (if any) counts again. */
export async function deleteHoliday(formData: FormData) {
  const { session, back } = await start(formData);
  const { error } = await session.supabase.rpc("admin_delete_holiday", {
    p_country: String(formData.get("country") ?? "").trim().toUpperCase(),
    p_date: String(formData.get("date") ?? ""),
  });
  back(error ? { err: error.message.slice(0, 200) } : { ok: "holiday" }, "holidays");
}
