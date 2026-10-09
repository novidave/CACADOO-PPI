"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { getSession, requestOrigin } from "@/lib/auth";
import { sanitizeHours } from "@/lib/hours";
import { MAPPING_FIELDS } from "@/lib/myShops";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_LOGO_BYTES = 1024 * 1024;

/**
 * Common start of every dashboard action: who is asking, for which shop.
 * Identity comes from the session; the shop id from the form is only a
 * reference, and RLS decides whether this user may change that shop.
 */
async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  // Back to the section the form was in, with the message shown there.
  const at = String(formData.get("at") ?? "").replace(/[^a-z]/g, "");
  const back = (query: Record<string, string>) =>
    redirect(`/${lang}/dashboard?${new URLSearchParams({ shop: slug, ...query, ...(at ? { at } : {}) })}${at ? `#${at}` : ""}`);
  if (!UUID.test(shopId)) back({ err: "invalid shop" });
  return { session, shopId, back };
}

/** Update the shop row and fail loudly if RLS let nothing through. */
async function updateShop(
  supabase: NonNullable<Awaited<ReturnType<typeof getSession>>>["supabase"],
  shopId: string,
  values: Record<string, unknown>,
): Promise<string | null> {
  const { data, error } = await supabase.from("shops").update(values).eq("id", shopId).select("id");
  if (error) return error.message;
  if (!data?.length) return "not allowed";
  return null;
}

export async function saveVisibility(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const mode = String(formData.get("visibility_mode") ?? "");
  const threshold = Math.round(Number(formData.get("low_stock_threshold")));
  if (!["exact", "in_stock", "yes_no"].includes(mode) || !(threshold >= 1 && threshold <= 50)) {
    back({ err: "invalid visibility" });
  }
  const error = await updateShop(session.supabase, shopId, { visibility_mode: mode, low_stock_threshold: threshold });
  back(error ? { err: error } : { ok: "visibility" });
}

export async function uploadLogo(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_LOGO_BYTES || !LOGO_TYPES[file.type]) {
    back({ err: "logo" });
    return;
  }
  // Folder = shop id: the storage policy only lets members of that shop write there.
  const path = `${shopId}/logo-${Date.now()}.${LOGO_TYPES[file.type]}`;
  const storage = session.supabase.storage.from("logos");
  const { error: uploadError } = await storage.upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) back({ err: uploadError.message });
  const error = await updateShop(session.supabase, shopId, { logo_url: storage.getPublicUrl(path).data.publicUrl });
  back(error ? { err: error } : { ok: "logo" });
}

export async function setItemPublic(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const itemId = String(formData.get("item_id") ?? "");
  const isPublic = formData.get("is_public") === "true";
  if (!UUID.test(itemId)) back({ err: "invalid item" });
  // Owners may only change is_public (column grant); RLS limits rows to own shops.
  const { data, error } = await session.supabase
    .from("shop_items")
    .update({ is_public: isPublic })
    .eq("id", itemId)
    .eq("shop_id", shopId)
    .select("id");
  const q = String(formData.get("q") ?? "");
  const page = String(formData.get("page") ?? "1");
  back(error ? { err: error.message } : !data?.length ? { err: "not allowed" } : { ok: "item", ...(q ? { q } : {}), page });
}

const text = (formData: FormData, key: string, max = 200) => String(formData.get(key) ?? "").trim().slice(0, max);

/**
 * The owner's own Slovak, Hungarian and English names for an item (never overwritten by
 * the automatic translation), or back to the automatic translation.
 */
export async function saveTranslation(formData: FormData) {
  const { session, back } = await start(formData);
  const itemId = String(formData.get("item_id") ?? "");
  const q = String(formData.get("q") ?? "");
  const page = String(formData.get("page") ?? "1");
  const keep = { ...(q ? { q } : {}), page };
  if (!UUID.test(itemId)) back({ err: "invalid item", ...keep });
  const automatic = formData.get("intent") === "auto";
  const names = automatic
    ? null
    : { sk: text(formData, "name_sk", 300), hu: text(formData, "name_hu", 300), en: text(formData, "name_en", 300) };
  // The database checks that the item belongs to one of this owner's shops.
  const { error } = await session.supabase.rpc("owner_set_item_translation", { p_item_id: itemId, p_names: names });
  if (error) back({ err: error.code === "22023" ? "translation" : error.message, ...keep });
  back({ ok: automatic ? "translation_auto" : "translation", ...keep });
}

/** "Potraviny Čierna" + "Košice" → "potraviny-cierna-kosice" (the database makes it unique). */
function slugBase(...parts: string[]): string {
  return parts
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Create a new shop (no shop_id) or save the details of one of your shops. */
export async function saveShop(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const isNew = !UUID.test(shopId);
  const fail = (err: string) =>
    redirect(
      isNew
        ? `/${lang}/dashboard?new=1&err=${encodeURIComponent(err)}`
        : `/${lang}/dashboard?${new URLSearchParams({ shop: text(formData, "shop_slug", 80), err, at: "details" })}#details`,
    );

  const name = text(formData, "name");
  const city = text(formData, "city", 100);
  if (!name) fail("name");
  let website = text(formData, "website", 300);
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
  if (website) {
    try {
      website = new URL(website).toString();
    } catch {
      fail("website");
    }
  }

  const { data, error } = await session.supabase.rpc("owner_save_shop", {
    p: {
      id: isNew ? null : shopId,
      slug_base: slugBase(name, city),
      name,
      ico: text(formData, "ico", 40),
      address: text(formData, "address"),
      city,
      country: text(formData, "country", 2).toUpperCase(),
      timezone: text(formData, "timezone", 64),
      lat: text(formData, "lat", 20),
      lng: text(formData, "lng", 20),
      phone: text(formData, "phone", 40),
      website,
      opening_hours: sanitizeHours(formData.get("opening_hours")),
      is_active: formData.get("is_active") === "on",
      has_toilet: formData.get("has_toilet") === "on",
      has_douchette: formData.get("has_douchette") === "on",
      has_card_terminal: formData.get("has_card_terminal") === "on",
    },
  });
  if (error) fail(error.code === "54000" ? "limit" : error.message);
  const { data: saved } = await session.supabase.from("shops").select("slug").eq("id", String(data)).maybeSingle();
  redirect(
    `/${lang}/dashboard?${new URLSearchParams({ shop: saved?.slug ?? "", ok: isNew ? "created" : "details", ...(isNew ? {} : { at: "details" }) })}${isNew ? "" : "#details"}`,
  );
}

/** The owner approves which column of the stock file is which. */
export async function approveColumns(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const mapping = Object.fromEntries(MAPPING_FIELDS.map((f) => [f, text(formData, `col_${f}`) || null]));
  const { error } = await session.supabase.rpc("owner_set_mapping", { p_shop_id: shopId, p_mapping: mapping });
  back(error ? { err: error.code === "22023" ? "columns" : error.message } : { ok: "columns" });
}

/** Deletes one of your shops, after the confirmation box is ticked. */
export async function deleteShop(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  if (formData.get("confirm") !== "on") back({ err: "confirm" });
  const { error } = await session.supabase.rpc("owner_delete_shop", { p_shop_id: shopId });
  if (error) back({ err: error.code === "55000" ? "plan_active" : error.code === "55006" ? "docs_present" : error.message });
  const langValue = String(formData.get("lang") ?? "");
  redirect(`/${isLocale(langValue) ? langValue : "en"}/dashboard?ok=deleted`);
}

/** Stripe pages are only ever https (http only for a stand-in on this computer). */
function stripePage(url: unknown): string | null {
  if (typeof url !== "string") return null;
  return /^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url) ? url : null;
}

/**
 * "Upgrade" or "Manage subscription": the stripe-checkout Edge Function checks the login
 * and the shop with the owner's own login and returns the Stripe page to go to. No Stripe
 * key is on the website; the paid state is written only by the stripe-webhook function.
 */
export async function openBilling(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const slug = String(formData.get("shop_slug") ?? "");
  const dict = await getDictionary(lang);
  const { data, error } = await session.supabase.functions.invoke<{ url?: string }>("stripe-checkout", {
    body: {
      shop_id: shopId,
      action: formData.get("intent") === "portal" ? "portal" : "checkout",
      lang,
      return_url: `${await requestOrigin()}/${lang}/dashboard?${new URLSearchParams({ shop: slug })}`,
      company_id_label: dict.plan.company_id,
    },
  });
  const url = error ? null : stripePage(data?.url);
  if (!url) back({ err: await billingError(error) });
  redirect(url!);
}

/** The function's own reason (it answers JSON {error, message}), for the message on the page. */
async function billingError(error: unknown): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  const reply = context instanceof Response ? await context.json().catch(() => null) : null;
  if (reply?.error === "not_configured") return "plan_unavailable";
  const message = reply?.message ?? (error instanceof Error ? error.message : "no answer");
  return `stripe:${String(message).slice(0, 300)}`;
}
