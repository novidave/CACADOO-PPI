"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { siteUrl } from "@/lib/site";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_ERRORS = ["phone", "too_many", "no_plan", "forbidden", "sms_quota", "sms_failed"];

/** Who is asking and for which shop; the owner_* functions and the hours-sms function decide what they may do. */
async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const page = (query: Record<string, string>) => `/${lang}/dashboard/hours-sms?${new URLSearchParams({ ...(slug ? { shop: slug } : {}), ...query })}`;
  return { lang, session, shopId, slug, page };
}

/** The function's error code from its JSON answer (supabase-js puts non-2xx answers into error.context). */
async function errorCode(error: unknown): Promise<string> {
  const context = (error as { context?: Response } | null)?.context;
  if (!context || typeof context.json !== "function") return "failed";
  const body = (await context.json().catch(() => ({}))) as { error?: string };
  return body.error ?? "failed";
}

/** "Pridať telefón": the hours-sms function sends a 6-digit code to the number (only it can make one). */
export async function startPhone(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const { data, error } = await session.supabase.functions.invoke<{ id: string; test_code?: string }>("hours-sms", {
    body: { action: "phone_start", shop_id: shopId, phone: String(formData.get("phone") ?? "").slice(0, 40) },
  });
  if (error || !data?.id) {
    const code = await errorCode(error);
    redirect(page({ err: `err_${PHONE_ERRORS.includes(code) ? code : "failed"}` }));
  }
  redirect(page({ verify: data.id, ok: "ok_code_sent", ...(data.test_code ? { test_code: data.test_code } : {}) }));
}

/** The code from the SMS: only the database checks it (5 tries, 10 minutes). */
export async function verifyPhone(formData: FormData) {
  const { session, page } = await start(formData);
  const id = String(formData.get("phone_id") ?? "");
  if (!UUID.test(id)) redirect(page({ err: "err_failed" }));
  const { data, error } = await session.supabase.rpc("owner_phone_verify", { p_id: id, p_code: String(formData.get("code") ?? "").slice(0, 12) });
  const r = (data ?? {}) as { ok?: boolean; reason?: string; attempts_left?: number };
  if (error) redirect(page({ err: "err_failed" }));
  if (!r.ok) {
    redirect(page({ verify: id, err: `err_${r.reason ?? "failed"}`, ...(typeof r.attempts_left === "number" ? { left: String(r.attempts_left) } : {}) }));
  }
  redirect(page({ ok: "ok_verified" }));
}

export async function removePhone(formData: FormData) {
  const { session, page } = await start(formData);
  const id = String(formData.get("phone_id") ?? "");
  if (!UUID.test(id)) redirect(page({ err: "err_failed" }));
  const { error } = await session.supabase.rpc("owner_phone_remove", { p_id: id });
  redirect(page(error ? { err: "err_failed" } : { ok: "ok_removed" }));
}

/** "Pripojiť Google profil firmy": the function returns Google's consent page (PKCE, business.manage only). */
export async function connectBusiness(formData: FormData) {
  const { lang, session, shopId, slug, page } = await start(formData);
  const back = `${siteUrl()}/${lang}/dashboard/hours-sms?${new URLSearchParams({ shop: slug })}`;
  const { data, error } = await session.supabase.functions.invoke<{ url?: string }>("hours-sms", {
    body: { action: "google_connect", shop_id: shopId, return_url: back },
  });
  if (error || !data?.url) redirect(page({ err: "google_failed" }));
  redirect(data.url);
}

/** The Google location whose hours Cacaduu keeps the same as the shop page's. */
export async function selectLocation(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const [name, ...title] = String(formData.get("location") ?? "").split("|");
  const { error } = await session.supabase.functions.invoke("hours-sms", {
    body: { action: "google_select", shop_id: shopId, location: name, title: title.join("|").slice(0, 200) },
  });
  redirect(page(error ? { err: "err_location" } : { ok: "ok_location" }));
}

/** "Poslať hodiny do Google teraz": the saved week and the coming special days. */
export async function pushBusiness(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const { error } = await session.supabase.functions.invoke("hours-sms", { body: { action: "google_push", shop_id: shopId } });
  redirect(page(error ? { err: "err_push" } : { ok: "ok_pushed" }));
}

/** "Odpojiť": revoked at Google, deleted here. */
export async function disconnectBusiness(formData: FormData) {
  const { session, shopId, page } = await start(formData);
  const { error } = await session.supabase.functions.invoke("hours-sms", { body: { action: "google_disconnect", shop_id: shopId } });
  redirect(page(error ? { err: "err_failed" } : { ok: "ok_disconnected" }));
}
