"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession, requestOrigin } from "@/lib/auth";
import { sanitizeHours } from "@/lib/hours";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Every admin action re-checks the session; the database checks is_admin() again. */
async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  if (!session.isAdmin) redirect(`/${lang}/dashboard`);
  const shopId = String(formData.get("shop_id") ?? "");
  const back = (query: Record<string, string>, id = shopId) =>
    redirect(`/${lang}/admin/shops/${UUID.test(id) ? id : "new"}?${new URLSearchParams(query)}`);
  return { lang, session, shopId, back };
}

const text = (formData: FormData, key: string, max = 200) => String(formData.get(key) ?? "").trim().slice(0, max);

export async function saveShop(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const slug = text(formData, "slug", 80).toLowerCase();
  const name = text(formData, "name");
  if (!SLUG.test(slug)) back({ err: "slug" });
  if (!name) back({ err: "name" });

  let website = text(formData, "website", 300);
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;

  const { data, error } = await session.supabase.rpc("admin_save_shop", {
    p: {
      id: UUID.test(shopId) ? shopId : null,
      slug,
      name,
      ico: text(formData, "ico", 40),
      address: text(formData, "address"),
      city: text(formData, "city", 100),
      country: text(formData, "country", 2).toUpperCase(),
      timezone: text(formData, "timezone", 64),
      lat: text(formData, "lat", 20),
      lng: text(formData, "lng", 20),
      phone: text(formData, "phone", 40),
      website,
      opening_hours: sanitizeHours(formData.get("opening_hours")),
      visibility_mode: text(formData, "visibility_mode", 20),
      low_stock_threshold: text(formData, "low_stock_threshold", 3),
      is_active: formData.get("is_active") === "on",
      has_toilet: formData.get("has_toilet") === "on",
      has_douchette: formData.get("has_douchette") === "on",
      has_card_terminal: formData.get("has_card_terminal") === "on",
    },
  });
  if (error) back({ err: error.message.includes("shops_slug_key") ? "slug_taken" : error.message });
  back({ ok: "saved" }, String(data));
}

export async function inviteOwner(formData: FormData) {
  const { lang, session, shopId, back } = await start(formData);
  const email = text(formData, "email", 254).toLowerCase();
  if (!UUID.test(shopId)) back({ err: "shop" });
  if (!EMAIL.test(email)) back({ err: "email" });

  // Needs the service role key, so it runs in a Supabase Edge Function that
  // checks again that the caller is the admin (see supabase/functions/invite-owner).
  const { data, error } = await session.supabase.functions.invoke("invite-owner", {
    body: { shop_id: shopId, email, redirect_to: `${await requestOrigin()}/auth/confirm?next=/${lang}/dashboard` },
  });
  if (error) {
    const status = (error as { context?: { status?: number } }).context?.status;
    let message = error.message;
    try {
      const body = await (error as { context?: Response }).context?.json();
      if (body?.error) message = body.error;
    } catch {
      // keep the generic message
    }
    back(status === 404 ? { err: "invite_fn_missing" } : { err: `invite:${message}` });
  }
  back({ ok: data?.invited ? "invited" : "linked", email });
}

export async function removeOwner(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const userId = text(formData, "user_id", 36);
  if (!UUID.test(shopId) || !UUID.test(userId)) back({ err: "owner" });
  const { error } = await session.supabase.from("shop_members").delete().eq("shop_id", shopId).eq("user_id", userId);
  back(error ? { err: error.message } : { ok: "saved" });
}

export async function saveSyncSource(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  if (!UUID.test(shopId)) back({ err: "shop" });
  const format = text(formData, "file_format", 10);
  if (!["xml", "csv", "xlsx"].includes(format)) back({ err: "format" });
  const fileUrl = text(formData, "file_url", 500);
  if (fileUrl && !/^https:\/\//i.test(fileUrl)) back({ err: "file_url must start with https://" });

  const rawMapping = text(formData, "field_mapping", 5000);
  let mapping: Record<string, unknown> | null = null;
  if (rawMapping) {
    try {
      const parsed = JSON.parse(rawMapping);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      mapping = parsed;
    } catch {
      back({ err: "mapping" });
    }
  }
  const approve = formData.get("intent") === "approve";
  if (approve && !mapping) back({ err: "mapping" });

  const values = {
    file_format: format,
    file_url: fileUrl || null,
    field_mapping: mapping,
    ...(approve ? { mapping_status: "confirmed" } : {}),
  };
  const { data, error } = await session.supabase.from("sync_sources").update(values).eq("shop_id", shopId).select("id");
  if (!error && !data?.length) {
    const { error: insertError } = await session.supabase.from("sync_sources").insert({ shop_id: shopId, ...values });
    if (insertError) back({ err: insertError.message });
  }
  if (error) back({ err: error.message });
  back({ ok: approve ? "approved" : "saved" });
}
