"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { getSession, requestOrigin } from "@/lib/auth";
import { validSkIco } from "@/lib/domainName";
import { callDomains, OWNER_FIELDS } from "@/lib/domains";
import { refreshShop } from "@/lib/publicCache";

/**
 * "Predplatné a doména" (database update 25). Every step that moves a domain goes to the
 * domains Edge Function with the owner's own login (it checks the shop and the plan); the
 * owner's details are saved with owner_save_legal() (RLS + is_shop_member).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const back = (query: Record<string, string> = {}, at = "domain"): never => {
    // A saved change a visitor can see: the public pages read it again at once.
    if (query.ok) refreshShop(slug);
    return redirect(`/${lang}/dashboard/plan?${new URLSearchParams({ shop: slug, ...query })}#${at}`);
  };
  const returnUrl = `${await requestOrigin()}/${lang}/dashboard/plan?${new URLSearchParams({ shop: slug })}`;
  return { lang, session, shopId, slug, back, returnUrl };
}

/** Stripe's pages are https (http only for a stand-in on this computer). */
function paymentPage(url: unknown): string | null {
  if (typeof url !== "string") return null;
  return /^https:\/\/[^/]+\.stripe\.com\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url) ? url : null;
}

export interface CheckState {
  state: "idle" | "available" | "taken" | "unsupported" | "invalid" | "has_domain" | "in_use" | "error" | "not_configured";
  domain?: string;
  problem?: string;
  order_id?: string;
  price_cents?: number;
  renewal_cents?: number;
  vat_included?: boolean;
  test?: boolean;
}

/** Step 2: the pasted name, checked by the function (Websupport) with the table's price. */
export async function checkDomain(_previous: CheckState, formData: FormData): Promise<CheckState> {
  const { session, shopId, returnUrl } = await start(formData);
  if (!UUID.test(shopId)) return { state: "error" };
  const { data, error } = await callDomains<CheckState>(session.supabase, {
    action: "check",
    shop_id: shopId,
    domain: String(formData.get("domain") ?? "").slice(0, 300),
    return_url: returnUrl,
  });
  if (error) return { state: error === "not_configured" ? "not_configured" : "error" };
  return data ?? { state: "error" };
}

/** Step 3: the owner's details (only the fields sent are changed). */
export async function saveLegal(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const details: Record<string, string> = {};
  for (const field of OWNER_FIELDS) {
    const value = formData.get(field);
    if (typeof value === "string" && value.trim()) details[field] = value.trim().slice(0, 200);
  }
  // A Slovak IČO must be valid (the registrar refuses it otherwise): said here, before paying.
  if (details.ico) {
    const { data: current } = await session.supabase.rpc("domain_owner_details", { p_shop_id: shopId });
    const country = (details.country ?? (current as { country?: string | null } | null)?.country ?? "").toUpperCase();
    if (country === "SK" && !validSkIco(details.ico)) back({ err: "legal_ico" });
  }
  const { error } = await session.supabase.rpc("owner_save_legal", { p_shop_id: shopId, p_details: details });
  if (error) back({ err: "legal" });
  // Corrected after Websupport refused them: the registration goes on now.
  const retry = String(formData.get("retry_order") ?? "");
  if (UUID.test(retry)) await callDomains(session.supabase, { action: "recheck", order_id: retry });
  back({ ok: "legal" });
}

/** Step 4: one click with the saved card, else Stripe's payment page. */
export async function payDomain(formData: FormData) {
  const { lang, session, back, returnUrl } = await start(formData);
  const orderId = String(formData.get("order_id") ?? "");
  if (!UUID.test(orderId)) back({ err: "pay" });
  if (formData.get("accept_terms") !== "on") back({ err: "terms" });
  const dict = await getDictionary(lang);
  const { data, error, message } = await callDomains<{ paid?: boolean; url?: string; state?: string }>(session.supabase, {
    action: "pay",
    order_id: orderId,
    return_url: returnUrl,
    lang,
    accept_terms: true,
    company_id_label: dict.plan.company_id,
  });
  if (error === "stripe" && message) back({ err: "pay_reason", reason: message.slice(0, 200) });
  if (error) back({ err: error === "owner_details" ? "owner" : error === "owner_ico" ? "legal_ico" : error === "terms" ? "terms" : error === "not_configured" ? "not_configured" : "pay" });
  if (data?.state === "in_use") back({ err: "in_use" });
  if (data?.paid) back({ domain: "paid" });
  const url = paymentPage(data?.url);
  if (!url) back({ err: "pay" });
  redirect(url!);
}

/** "Zrušiť objednávku": an unpaid domain order is given up (its Stripe page is closed). */
export async function cancelDomainPayment(formData: FormData) {
  const { session, back } = await start(formData);
  const { error } = await callDomains(session.supabase, { action: "cancel_payment", order_id: String(formData.get("order_id") ?? "") });
  back(error ? { err: "error" } : { ok: "order_canceled" });
}

/** Flow 14: the shop's own domain (Pro only). */
export async function connectDomain(formData: FormData) {
  const { session, shopId, back, returnUrl } = await start(formData);
  const { data, error } = await callDomains<{ state?: string; problem?: string }>(session.supabase, {
    action: "connect",
    shop_id: shopId,
    domain: String(formData.get("domain") ?? "").slice(0, 300),
    return_url: returnUrl,
  });
  if (error) back({ err: error === "not_configured" ? "not_configured" : "error" }, "own");
  const state = data?.state;
  if (state === "started") back({ ok: "connect" });
  if (state === "no_plan") back({ err: "own_needs_pro" }, "own");
  if (state === "in_use") back({ err: "own_in_use" }, "own");
  if (state === "has_domain") back({ err: "has_domain" }, "own");
  back({ err: data?.problem === "accents" ? "accents" : "invalid" }, "own");
}

/** "Odpojiť doménu" (own domains only). */
export async function disconnectDomain(formData: FormData) {
  const { session, back } = await start(formData);
  if (formData.get("confirm") !== "on") back({ err: "confirm" });
  const { error } = await callDomains(session.supabase, { action: "disconnect", order_id: String(formData.get("order_id") ?? "") });
  back(error ? { err: "error" } : { ok: "disconnected" });
}

/** The transfer code of a bought domain (the page shows it from the shop's own row). */
export async function requestAuthCode(formData: FormData) {
  const { session, back } = await start(formData);
  const { data, error } = await callDomains<{ auth_code?: string | null; requested?: boolean }>(session.supabase, {
    action: "auth_code",
    order_id: String(formData.get("order_id") ?? ""),
  });
  if (error) back({ err: "auth" }, "transfer");
  back({ ok: data?.auth_code ? "auth" : "auth_requested" }, "transfer");
}

/** "Overiť v Google Search Console": the TXT value into the domain's DNS, or the record to add by hand. */
export async function verifyGoogle(formData: FormData) {
  const { session, back } = await start(formData);
  const { data, error } = await callDomains<{ state?: string }>(session.supabase, {
    action: "google_verify",
    order_id: String(formData.get("order_id") ?? ""),
    value: String(formData.get("value") ?? "").slice(0, 300),
  });
  if (error === "too_soon") back({ err: "google_too_soon" }, "findable");
  if (error) back({ err: "error" }, "findable");
  const state = data?.state;
  if (state === "added" || state === "present" || state === "manual") back({ ok: `google_${state}` }, "findable");
  back({ err: state === "too_many" ? "google_too_many" : "google_invalid" }, "findable");
}

/**
 * "Odstrániť" (update 36): the Search Console value is forgotten; from the DNS the function removes
 * only the record Cacaduu added (never one that was there already, never another record).
 */
export async function removeGoogle(formData: FormData) {
  const { session, back } = await start(formData);
  const { data, error } = await callDomains<{ state?: string; dns?: boolean }>(session.supabase, {
    action: "google_remove",
    order_id: String(formData.get("order_id") ?? ""),
  });
  if (error || data?.state !== "removed") back({ err: "error" }, "findable");
  back({ ok: data?.dns ? "google_removed_dns" : "google_removed" }, "findable");
}

/**
 * The meta tag of Google ("HTML značka") or Bing (msvalidate.01) on the domain's pages (update 36):
 * owner_set_site_verification() checks the shop, the live domain and the format; "remove" = empty.
 */
export async function saveVerificationMeta(formData: FormData) {
  const { session, back } = await start(formData);
  const kind = formData.get("kind") === "bing" ? "bing" : "google";
  const remove = formData.get("remove") === "1";
  const { error } = await session.supabase.rpc("owner_set_site_verification", {
    p_order_id: String(formData.get("order_id") ?? ""),
    p_kind: kind,
    p_value: remove ? "" : String(formData.get("value") ?? "").slice(0, 500),
  });
  if (error) back({ err: error.message === "value" ? `meta_${kind}_invalid` : "error" }, `verify-${kind}`);
  back({ ok: remove ? `meta_${kind}_removed` : `meta_${kind}_saved` }, `verify-${kind}`);
}

/** "Kategórie tovaru" for the domain's llms.txt (owner_set_categories: plain text, at most 12). */
export async function saveCategories(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const { error } = await session.supabase.rpc("owner_set_categories", {
    p_shop_id: shopId,
    p_categories: String(formData.get("categories") ?? "").slice(0, 1000),
  });
  back(error ? { err: "categories" } : { ok: "categories" }, "findable");
}
