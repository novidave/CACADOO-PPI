"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { callerHash } from "@/lib/apiHttp";
import { bookingsCall } from "@/lib/bookings";
import { COURIER_COOKIE, COURIER_COOKIE_DAYS, signCourierKey } from "@/lib/courier";
import { createPublicClient } from "@/lib/supabase/public";

const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang = isLocale(langValue) ? langValue : "sk";
  const slug = String(formData.get("slug") ?? "");
  if (!SLUG.test(slug)) redirect(`/${lang}/kurier`);
  const page = `/${lang}/kurier/prihlasenie/${slug}`;
  return { lang, slug, page };
}

/**
 * "Poslať kód": the bookings function (website secret) asks the database; only an active courier of the shop gets the
 * SMS — any other number sees the same next screen. The code's id travels in the address, the code itself never.
 */
export async function sendCourierCode(formData: FormData) {
  const { lang, slug, page } = base(formData);
  const phone = String(formData.get("phone") ?? "").slice(0, 40);
  const caller = callerHash(new Request("https://cacaduu.invalid/", { headers: await headers() }));
  const result = await bookingsCall<{ id: string; phone: string; test_code?: string }>({ action: "courier_code", slug, phone, caller, lang });
  if (result.error || !result.data) redirect(`${page}?${new URLSearchParams({ err: result.error ?? "failed" })}`);
  const q = new URLSearchParams({ code: result.data!.id, to: result.data!.phone });
  if (result.data!.test_code) q.set("test", result.data!.test_code);
  redirect(`${page}?${q}`);
}

/** "Prihlásiť sa": the database checks the code (5 tries) and gives a key for 30 days, kept in the signed cookie. */
export async function courierLogin(formData: FormData) {
  const { lang, page } = base(formData);
  const id = String(formData.get("code_id") ?? "");
  const to = String(formData.get("to") ?? "").slice(0, 40);
  const code = String(formData.get("code") ?? "").replace(/\s/g, "").slice(0, 12);
  if (!UUID.test(id)) redirect(page);
  const client = createPublicClient();
  if (!client) redirect(`${page}?err=unavailable`);
  const { data, error } = await client!.rpc("food_courier_login", { p_code_id: id, p_code: code });
  const v = (data ?? {}) as { ok?: boolean; reason?: string; attempts_left?: number; key?: string };
  if (error || !v.ok || !v.key) {
    const q = new URLSearchParams({ code: id, to, err: error ? "failed" : (v.reason ?? "failed") });
    if (v.attempts_left !== undefined) q.set("left", String(v.attempts_left));
    if (v.reason && v.reason !== "wrong_code") q.delete("code");
    redirect(`${page}?${q}`);
  }
  (await cookies()).set(COURIER_COOKIE, signCourierKey(v.key!), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COURIER_COOKIE_DAYS * 24 * 3600,
  });
  redirect(`/${lang}/kurier`);
}
