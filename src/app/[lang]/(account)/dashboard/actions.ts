"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { sanitizeHours } from "@/lib/hours";

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
  const back = (query: Record<string, string>) =>
    redirect(`/${lang}/dashboard?${new URLSearchParams({ shop: slug, ...query })}`);
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

export async function saveShopDetails(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const phone = String(formData.get("phone") ?? "").trim().slice(0, 40);
  let website = String(formData.get("website") ?? "").trim();
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
  if (website) {
    try {
      website = new URL(website).toString();
    } catch {
      back({ err: "website" });
    }
  }
  const error = await updateShop(session.supabase, shopId, {
    phone: phone || null,
    website: website || null,
    opening_hours: sanitizeHours(formData.get("opening_hours")),
  });
  back(error ? { err: error } : { ok: "details" });
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
