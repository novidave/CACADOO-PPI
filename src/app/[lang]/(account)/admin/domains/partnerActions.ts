"use server";

import sharp from "sharp";
import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";

/**
 * "Partnerské feedy" on the admin page (database update 35). The page is shown only to is_admin;
 * every admin_* SQL function and the partner-feeds function check is_admin() again with the
 * admin's own login. Feed files go from the admin's browser straight to the private bucket
 * partner-feeds (PartnerFileUpload); this file only registers them.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTNER_ERRORS = ["name", "feed_url", "inventory_url", "format", "inventory_format", "currency", "heureka_currency",
  "timezone", "schedule", "too_many", "logo", "file", "stores"];
const LOGO_TYPES: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/webp": true };
const MAX_LOGO_BYTES = 1024 * 1024;

async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const keep = String(formData.get("keep") ?? "");
  const id = String(formData.get("partner_id") ?? "");
  const back = (query: Record<string, string>, at = UUID.test(id) ? `partner-${id}` : "partner-feeds"): never => {
    const params = new URLSearchParams(keep.startsWith("?") ? keep.slice(1) : keep);
    for (const [k, v] of Object.entries(query)) params.set(k, v);
    redirect(`/${lang}/admin/domains?${params}#${at}`);
  };
  return { session, back, id: UUID.test(id) ? id : null };
}

/** The admin_* functions' codes become the page's own messages ("partner_<code>"). */
function partnerError(message: string): Record<string, string> {
  const stores = /^stores:(\d+)$/.exec(message);
  if (stores) return { err: "partner_stores", line: stores[1] };
  return { err: PARTNER_ERRORS.includes(message) ? `partner_${message}` : message.slice(0, 200) };
}

/** Starts the due imports now (the partner-feeds function, with the admin's login); the 5-minute job would too. */
async function runImports(supabase: NonNullable<Awaited<ReturnType<typeof getSession>>>["supabase"]): Promise<boolean> {
  try {
    const { error } = await supabase.functions.invoke("partner-feeds", { body: { action: "run" } });
    return !error;
  } catch {
    return false;
  }
}

/** Adds or changes a partner (empty partner_id = new); a new address or format is read again soon. */
export async function savePartner(formData: FormData) {
  const { session, back, id } = await start(formData);
  const text = (name: string, max: number) => String(formData.get(name) ?? "").trim().slice(0, max);
  const { data, error } = await session.supabase.rpc("admin_save_partner", {
    p: {
      id: id ?? "",
      name: text("name", 200),
      feed_url: text("feed_url", 2100),
      feed_format: text("feed_format", 40),
      inventory_url: text("inventory_url", 2100),
      inventory_format: text("inventory_format", 40),
      currency: text("currency", 10),
      timezone: text("timezone", 100),
      schedule: text("schedule", 20),
      affiliate: formData.get("affiliate") === "on",
      enabled: formData.get("enabled") === "on",
    },
  });
  if (error) back(partnerError(error.message));
  const saved = String(data ?? id ?? "");
  await runImports(session.supabase);
  back({ ok: "partner_saved" }, UUID.test(saved) ? `partner-${saved}` : "partner-feeds");
}

/** Removes the partner with its rows, stores and imports, then its logo and uploaded files. */
export async function deletePartner(formData: FormData) {
  const { session, back, id } = await start(formData);
  if (!id) back({ err: "partner_file" });
  const { data, error } = await session.supabase.rpc("admin_delete_partner", { p_partner: id });
  if (error) back(partnerError(error.message));
  const removed = data as { logo: string | null; files: string[] } | null;
  if (removed?.logo) await session.supabase.storage.from("partner-logos").remove([removed.logo]);
  if (removed?.files?.length) await session.supabase.storage.from("partner-feeds").remove(removed.files);
  back({ ok: "partner_deleted" }, "partner-feeds");
}

/**
 * The store list as typed: one store per line, "code;name;address;town;postcode;country;lat;lng"
 * (a tab or a comma works too when there is no semicolon). The database checks every row.
 */
export async function savePartnerStores(formData: FormData) {
  const { session, back, id } = await start(formData);
  if (!id) back({ err: "partner_file" });
  const lines = String(formData.get("stores") ?? "").replace(/\r/g, "").split("\n").slice(0, 5001);
  const stores: Record<string, string>[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const sep = raw.includes(";") ? ";" : raw.includes("\t") ? "\t" : ",";
    const [code = "", name = "", address = "", city = "", postal = "", country = "", lat = "", lng = ""] = raw.split(sep).map((v) => v.trim());
    stores.push({ code, name, address, city, postal_code: postal, country, lat: lat.replace(",", "."), lng: lng.replace(",", ".") });
  }
  const { error } = await session.supabase.rpc("admin_save_partner_stores", { p_partner: id, p_stores: stores });
  if (error) back(partnerError(error.message));
  back({ ok: "partner_saved" });
}

/** The partner's logo: PNG, JPG or WebP up to 1 MB, stored as WebP at most 256 × 64 (public bucket partner-logos). */
export async function uploadPartnerLogo(formData: FormData) {
  const { session, back, id } = await start(formData);
  const file = formData.get("logo");
  if (!id || !(file instanceof File) || file.size === 0 || file.size > MAX_LOGO_BYTES || !LOGO_TYPES[file.type]) back({ err: "partner_logo" });
  const input = Buffer.from(await (file as File).arrayBuffer());
  const meta = await sharp(input).metadata().catch(() => null);
  if (!meta || !["png", "jpeg", "webp"].includes(meta.format ?? "") || !meta.width || !meta.height) back({ err: "partner_logo" });
  const webp = await sharp(input).resize({ width: 256, height: 64, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  const path = `${id}/logo-${Date.now()}.webp`;
  const storage = session.supabase.storage.from("partner-logos");
  const { error: uploadError } = await storage.upload(path, webp, { contentType: "image/webp", upsert: false });
  if (uploadError) back({ err: uploadError.message.slice(0, 200) });
  const { data: old, error } = await session.supabase.rpc("admin_set_partner_logo", { p_partner: id, p_path: path });
  if (error) {
    await storage.remove([path]);
    back(partnerError(error.message));
  }
  if (typeof old === "string" && old) await storage.remove([old]);
  back({ ok: "partner_saved" });
}

export async function removePartnerLogo(formData: FormData) {
  const { session, back, id } = await start(formData);
  if (!id) back({ err: "partner_logo" });
  const { data: old, error } = await session.supabase.rpc("admin_set_partner_logo", { p_partner: id, p_path: null });
  if (error) back(partnerError(error.message));
  if (typeof old === "string" && old) await session.supabase.storage.from("partner-logos").remove([old]);
  back({ ok: "partner_saved" });
}

/** "Importovať teraz": the partner's feeds are read again in full, starting now. */
export async function importPartnerNow(formData: FormData) {
  const { session, back, id } = await start(formData);
  if (!id) back({ err: "partner_file" });
  const { error } = await session.supabase.rpc("admin_queue_partner_import", { p_partner: id });
  if (error) back(partnerError(error.message));
  back((await runImports(session.supabase)) ? { ok: "partner_queued" } : { err: "partner_function" });
}

/**
 * A feed file the admin's browser has just put into partner-feeds ("<partner>/feed-<ms>.xml"): it
 * becomes the partner's feed (or local inventory feed) and is read at once. The file it replaces is
 * deleted. Returns an error code for the page, or null.
 */
export async function registerPartnerFile(partnerId: string, kind: "products" | "inventory", path: string): Promise<string | null> {
  const session = await getSession();
  if (!session) return "login";
  if (!UUID.test(partnerId) || (kind !== "products" && kind !== "inventory")) return "partner_file";
  const { data: old, error } = await session.supabase.rpc("admin_set_partner_file", { p_partner: partnerId, p_kind: kind, p_path: path });
  if (error) {
    await session.supabase.storage.from("partner-feeds").remove([path]);
    return partnerError(error.message).err;
  }
  if (typeof old === "string" && old) await session.supabase.storage.from("partner-feeds").remove([old]);
  return (await runImports(session.supabase)) ? null : "partner_function";
}
