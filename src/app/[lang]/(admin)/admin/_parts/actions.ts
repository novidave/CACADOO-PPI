"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { callDomains } from "@/lib/domains";
import { adminBack } from "@/lib/adminPages";
import { refreshAll } from "@/lib/publicCache";

/**
 * The admin pages' actions (admin only; since 2026-11-05 each returns to its own page, @/lib/adminPages). The pages
 * are shown only to is_admin; every action is checked again where it runs: the admin_* SQL functions and the
 * functions both ask is_admin() with the caller's own login.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const keep = String(formData.get("keep") ?? "");
  // every form returns to its own page (@/lib/adminPages: the page its section lives on, that page's query kept)
  const back = (query: Record<string, string>, at = "shops"): never => {
    // A saved setting can change every shop's page (holidays, limits, languages): read again at once.
    if (query.ok) refreshAll();
    redirect(adminBack(lang, at, keep, query));
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

/**
 * "Cenník domén" (artboard 4): every row of the table at once (admin_save_domain_price per row, which checks is_admin()
 * and the values itself) and, when its ending is filled in, the new row.
 */
export async function saveDomainPrices(formData: FormData) {
  const { session, back } = await start(formData);
  const save = async (tld: string, prefix: string, vat: boolean, active: boolean) => {
    const price = cents(formData.get(`${prefix}price`));
    const renewal = cents(formData.get(`${prefix}renewal`));
    if (!price || !renewal) back({ err: "price" }, "prices");
    const { error } = await session.supabase.rpc("admin_save_domain_price", {
      p_tld: tld,
      p_price_cents: price,
      p_renewal_cents: renewal,
      p_vat_included: vat,
      p_sort: Math.floor(Number(formData.get(`${prefix}sort`)) || 100),
      p_active: active,
    });
    if (error) back({ err: error.message.slice(0, 200) }, "prices");
  };
  for (const tld of formData.getAll("tlds").map(String).slice(0, 200)) {
    await save(tld, `${tld}:`, formData.get(`${tld}:vat_included`) === "on", formData.get(`${tld}:active`) === "on");
  }
  const added = String(formData.get("new:tld") ?? "").trim();
  if (added) await save(added, "new:", true, true);
  back({ ok: "price" }, "prices");
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

/**
 * Limity plánov (artboard 5): every Zadarmo / Pro limit in ONE form — page content (database update 38:
 * admin_save_content_limits; update 30: admin_save_section_limits), blog posts (admin_save_blog_limits; empty = all),
 * pre-translated languages (admin_save_translation_limits) and the inventory programs (admin_save_inventory_settings).
 * Each part is saved only when the form carries it; every function checks is_admin() and its own ranges. The first
 * refusal returns to its card.
 */
export async function saveLimits(formData: FormData) {
  const { session, back } = await start(formData);
  const whole = (name: string) => {
    const text = String(formData.get(name) ?? "").trim();
    const n = Number(text);
    return text !== "" && Number.isInteger(n) ? n : null;
  };
  for (const plan of ["free", "pro"] as const) {
    if (formData.has(`${plan}:max_slides`)) {
      const { error } = await session.supabase.rpc("admin_save_content_limits", {
        p_plan: plan,
        p_max_slides: whole(`${plan}:max_slides`),
        p_max_pdf_slides: whole(`${plan}:max_pdf_slides`),
        p_max_items: whole(`${plan}:max_items`),
      });
      if (error) back({ err: error.message.slice(0, 200) }, "section-limits");
    }
    if (formData.has(`${plan}:max_pages`)) {
      const { error } = await session.supabase.rpc("admin_save_section_limits", {
        p_plan: plan,
        p_max_sections: whole(`${plan}:max_sections`),
        p_max_pages: whole(`${plan}:max_pages`),
        p_max_mb: whole(`${plan}:max_mb`),
      });
      if (error) back({ err: error.message.slice(0, 200) }, "section-limits");
    }
  }
  if (formData.has("blog:free")) {
    for (const plan of ["free", "pro"] as const) {
      const text = String(formData.get(`blog:${plan}`) ?? "").trim();
      const n = text === "" ? null : Number(text);
      if (n !== null && (!Number.isInteger(n) || n < 0 || n > 10_000)) back({ err: "blog_limits" }, "blog-limits");
      const { error } = await session.supabase.rpc("admin_save_blog_limits", { p_plan: plan, p_max_posts: n });
      if (error) back({ err: error.message.slice(0, 200) }, "blog-limits");
    }
  }
  if (formData.has("tr:free")) {
    const { error } = await session.supabase.rpc("admin_save_translation_limits", {
      p_free: Number(formData.get("tr:free")),
      p_pro: Number(formData.get("tr:pro")),
    });
    if (error) back({ err: error.message.slice(0, 200) }, "translation-limits");
  }
  if (formData.has("inv:pro_interval")) {
    const pro = Number(formData.get("inv:pro_interval"));
    const free = Number(formData.get("inv:free_interval"));
    if (![pro, free].every((n) => Number.isInteger(n) && n >= 5 && n <= 10_080)) back({ err: "inventory" }, "inventory-limits");
    const { error } = await session.supabase.rpc("admin_save_inventory_settings", {
      p_pro_interval: pro,
      p_free_allowed: formData.get("inv:free_allowed") === "on",
      p_free_interval: free,
    });
    if (error) back({ err: "inventory" }, "inventory-limits");
  }
  back({ ok: "limits" }, "section-limits");
}

/** "SMS" (database update 58): the two monthly quotas of every shop; admin_save_sms_quotas checks is_admin() itself. */
export async function saveSmsQuotas(formData: FormData) {
  const { session, back } = await start(formData);
  const booking = Number(formData.get("booking"));
  const owner = Number(formData.get("owner"));
  if (![booking, owner].every((n) => Number.isInteger(n) && n >= 0 && n <= 100_000)) back({ err: "sms" }, "sms");
  const { error } = await session.supabase.rpc("admin_save_sms_quotas", { p_booking: booking, p_owner: owner });
  if (error) back({ err: "sms" }, "sms");
  // the food orders' SMS codes and "on the way" SMS (database updates 73–74), when the form shows it
  if (formData.has("order")) {
    const order = Number(formData.get("order"));
    if (!Number.isInteger(order) || order < 0 || order > 100_000) back({ err: "sms" }, "sms");
    const saved = await session.supabase.rpc("admin_save_sms_quota", { p_quota: "order", p_monthly: order });
    if (saved.error) back({ err: "sms" }, "sms");
  }
  back({ ok: "sms" }, "sms");
}

/** A built program on or off (a program that is not built stays off; the SQL decides). */
export async function setInventoryProvider(formData: FormData) {
  const { session, back } = await start(formData);
  const code = String(formData.get("code") ?? "");
  if (!/^[a-z]{2,30}$/.test(code)) back({ err: "inventory" }, "inventory");
  const { error } = await session.supabase.rpc("admin_set_inventory_provider", { p_code: code, p_enabled: formData.get("enabled") === "1" });
  if (error) back({ err: "inventory" }, "inventory");
  back({ ok: "inventory" }, "inventory");
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

const SEARCH_ERRORS = ["domain", "search_url", "label", "layer", "too_many"];

/** "…_failed" codes from the admin_* search functions become the page's own messages. */
function searchError(message: string): string {
  return SEARCH_ERRORS.includes(message) ? `search_${message}` : message.slice(0, 200);
}

/** "0,032" / "0.032" → 0.032; null when it is not a number. */
function amount(value: FormDataEntryValue | null): number | null {
  const n = Number.parseFloat(String(value ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * "Vyhľadávanie mimo Cacaduu" (database update 34; artboard 9): every layer's switch and its estimated prices at once
 * ("<layer>:enabled", "<layer>:cost_per_call", …); admin_save_search_layer checks is_admin() and the ranges itself.
 */
export async function saveSearchLayers(formData: FormData) {
  const { session, back } = await start(formData);
  for (const layer of formData.getAll("layers").map(String).slice(0, 10)) {
    const { error } = await session.supabase.rpc("admin_save_search_layer", {
      p_layer: layer,
      p_enabled: formData.get(`${layer}:enabled`) === "on",
      p_cost_per_call_usd: amount(formData.get(`${layer}:cost_per_call`)) ?? -1,
      p_input_usd_per_mtok: amount(formData.get(`${layer}:input_per_mtok`)) ?? 0,
      p_output_usd_per_mtok: amount(formData.get(`${layer}:output_per_mtok`)) ?? 0,
    });
    if (error) back({ err: searchError(error.message) }, "external-search");
  }
  back({ ok: "layer" }, "external-search");
}

/**
 * The allowed web domains (artboard 9): every row's label, search address (deep link), order and switch at once, and
 * — when its domain is filled in — the new one; admin_save_web_domain checks is_admin() and every value itself.
 */
export async function saveWebDomains(formData: FormData) {
  const { session, back } = await start(formData);
  const save = async (domain: string, prefix: string, enabled: boolean) => {
    const { error } = await session.supabase.rpc("admin_save_web_domain", {
      p_domain: domain.slice(0, 300),
      p_label: String(formData.get(`${prefix}label`) ?? "").slice(0, 200),
      p_search_url: String(formData.get(`${prefix}search_url`) ?? "").slice(0, 600),
      p_enabled: enabled,
      p_sort: Math.floor(Number(formData.get(`${prefix}sort`)) || 100),
    });
    if (error) back({ err: searchError(error.message) }, "web-domains");
  };
  for (const domain of formData.getAll("domains").map(String).slice(0, 100)) {
    await save(domain, `${domain}:`, formData.get(`${domain}:enabled`) === "on");
  }
  const added = String(formData.get("new:domain") ?? "").trim();
  if (added) await save(added, "new:", true);
  back({ ok: "domain" }, "web-domains");
}

export async function deleteWebDomain(formData: FormData) {
  const { session, back } = await start(formData);
  const { error } = await session.supabase.rpc("admin_delete_web_domain", { p_domain: String(formData.get("domain") ?? "") });
  back(error ? { err: searchError(error.message) } : { ok: "domain" }, "web-domains");
}

/** "Telegram bot" (database update 66): the limits for AI answers and notifications. */
export async function saveTelegramSettings(formData: FormData) {
  const { session, back } = await start(formData);
  const ai = Number(formData.get("ai_daily_limit"));
  const notify = Number(formData.get("notify_daily_cap"));
  if (!Number.isInteger(ai) || ai < 0 || ai > 1000 || !Number.isInteger(notify) || notify < 0 || notify > 200) back({ err: "telegram" }, "telegram");
  const { error } = await session.supabase.rpc("admin_save_telegram_settings", {
    p_ai_enabled: formData.get("ai_enabled") === "on",
    p_ai_daily_limit: ai,
    p_notify_daily_cap: notify,
  });
  back(error ? { err: "telegram" } : { ok: "telegram" }, "telegram");
}

/**
 * "AI pre majiteľov" (database update 76): the daily limit of "Opraviť gramatiku" per shop; since update 77 also the
 * blog editor's AI limit per shop (Opraviť gramatiku + Skrášliť článok).
 */
export async function saveOwnerAi(formData: FormData) {
  const { session, back } = await start(formData);
  const limit = Number(formData.get("grammar_daily_limit"));
  const blogField = formData.get("blog_daily_limit");
  const blog = blogField === null ? null : Number(blogField);
  const bad = (n: number) => !Number.isInteger(n) || n < 0 || n > 1000;
  if (bad(limit) || (blog !== null && bad(blog))) back({ err: "owner_ai" }, "owner-ai");
  const { error } = await session.supabase.rpc("admin_save_owner_ai", { p_grammar_daily_limit: limit });
  const blogSaved = blog === null || !(await session.supabase.rpc("admin_save_blog_ai", { p_blog_daily_limit: blog })).error;
  back(error || !blogSaved ? { err: "owner_ai" } : { ok: "owner_ai" }, "owner-ai");
}

/** "Nastaviť webhook": the telegram function tells Telegram its address and the secret header (is_admin checked there). */
export async function setTelegramWebhook(formData: FormData) {
  const { session, back } = await start(formData);
  const { data, error } = await session.supabase.functions.invoke<{ set?: boolean }>("telegram", { body: { action: "set_webhook" } });
  back(error || !data?.set ? { err: "telegram_webhook" } : { ok: "telegram_webhook" }, "telegram");
}
