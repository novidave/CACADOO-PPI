"use server";

import sharp from "sharp";
import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { sectionUrl } from "@/lib/dashboardPages";
import { POSITIONS, type SectionPosition } from "@/lib/sectionLimits";

/**
 * Page sections from PDFs and the header logo of an own domain and its link (database updates 28–32). Every
 * change goes through an owner function that checks the caller owns the shop (and, for
 * sections, its plan's limits: every shop since update 30); after a change of what visitors see, the page-sections
 * function moves the pictures in or out of the public bucket at once (the hourly job would too).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function start(formData: FormData, at: "sections" | "header") {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const back = (query: Record<string, string>) => redirect(sectionUrl(lang, at, { shop: slug, ...query }));
  if (!UUID.test(shopId)) back({ err: "invalid shop" });
  return { session, shopId, back };
}

const dateOrNull = (value: FormDataEntryValue | null) => (DATE.test(String(value ?? "")) ? String(value) : null);
const position = (value: unknown): SectionPosition =>
  (POSITIONS as readonly string[]).includes(String(value)) ? (value as SectionPosition) : "after_details";
const layout = (value: unknown) => (value === "stacked" ? "stacked" : "slider");

type Rpc = NonNullable<Awaited<ReturnType<typeof getSession>>>["supabase"];

/**
 * owner_save_section with "Zobrazenie strán" (database update 29); before update 29 the same
 * call without it (the database then has no such choice and every section is a slider).
 */
async function saveSection(supabase: Rpc, args: Record<string, unknown>, pageLayout: string) {
  const result = await supabase.rpc("owner_save_section", { ...args, p_page_layout: pageLayout });
  if (result.error?.code !== "PGRST202") return result;
  return await supabase.rpc("owner_save_section", args);
}

const sectionError = (message: string) =>
  ["no_plan", "title", "dates", "limit", "empty", "bad"].includes(message) ? `sections_${message}` : message;

type Supabase = NonNullable<Awaited<ReturnType<typeof getSession>>>["supabase"];

/** The pictures follow what the database now says (errors here are only logged: the job retries). */
async function sync(supabase: Supabase, sectionId: string) {
  const { error } = await supabase.functions.invoke("page-sections", { body: { action: "sync", section_id: sectionId } });
  if (error) console.error("page-sections sync:", error.message);
}

/**
 * "Pridať sekciu": the settings first (the browser then reads and sends the PDF). Called by
 * the uploader in the browser; answers the new section's id or the reason.
 */
export async function createSection(input: {
  shopId: string;
  title: string;
  display: string;
  position: string;
  allowDownload: boolean;
  from: string | null;
  until: string | null;
  pageLayout: string;
}): Promise<{ id: string } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "login" };
  if (!UUID.test(input.shopId)) return { error: "bad" };
  const { data, error } = await saveSection(session.supabase, {
    p_shop_id: input.shopId,
    p_section_id: null,
    p_title: String(input.title ?? "").slice(0, 200),
    p_display: input.display === "open" ? "open" : "collapsed",
    p_position: position(input.position),
    p_allow_download: Boolean(input.allowDownload),
    p_from: DATE.test(input.from ?? "") ? input.from : null,
    p_until: DATE.test(input.until ?? "") ? input.until : null,
  }, layout(input.pageLayout));
  if (error) return { error: error.message };
  return { id: String(data) };
}

/** "Upraviť": title, display, page layout, position, download, dates (a changed date may show or hide it). */
export async function updateSection(formData: FormData) {
  const { session, shopId, back } = await start(formData, "sections");
  const sectionId = String(formData.get("section_id") ?? "");
  if (!UUID.test(sectionId)) back({ err: "bad" });
  const { error } = await saveSection(session.supabase, {
    p_shop_id: shopId,
    p_section_id: sectionId,
    p_title: String(formData.get("title") ?? "").slice(0, 200),
    p_display: formData.get("display") === "open" ? "open" : "collapsed",
    p_position: position(formData.get("position")),
    p_allow_download: formData.get("allow_download") === "on",
    p_from: dateOrNull(formData.get("from")),
    p_until: dateOrNull(formData.get("until")),
  }, layout(formData.get("page_layout")));
  if (error) back({ err: sectionError(error.message), section: sectionId });
  await sync(session.supabase, sectionId);
  back({ ok: "section_saved" });
}

/** "Zverejniť" (after the preview), "Skryť", "Zobraziť". */
export async function setSectionState(formData: FormData) {
  const { session, back } = await start(formData, "sections");
  const sectionId = String(formData.get("section_id") ?? "");
  const action = String(formData.get("state") ?? "");
  if (!UUID.test(sectionId) || !["publish", "hide", "show"].includes(action)) back({ err: "bad" });
  const { error } = await session.supabase.rpc("owner_set_section_state", { p_section_id: sectionId, p_action: action });
  if (error) back({ err: sectionError(error.message) });
  await sync(session.supabase, sectionId);
  back({ ok: action === "publish" ? "section_published" : action === "hide" ? "section_hidden" : "section_shown" });
}

/** Drag and drop or ↑ ↓: the new order of one position (called from the browser). */
export async function reorderSections(input: { shopId: string; position: string; ids: string[] }): Promise<boolean> {
  const session = await getSession();
  if (!session || !UUID.test(input.shopId)) return false;
  const ids = (input.ids ?? []).filter((id) => UUID.test(id)).slice(0, 10);
  const { error } = await session.supabase.rpc("owner_reorder_sections", {
    p_shop_id: input.shopId,
    p_position: position(input.position),
    p_ids: ids,
  });
  // On a free shop the order decides which section is shown: the pictures follow.
  if (!error && ids[0]) await sync(session.supabase, ids[0]);
  return !error;
}

/** "Vymazať": every file (both buckets) first, then the section and its text. */
export async function deleteSection(formData: FormData) {
  const { session, back } = await start(formData, "sections");
  const sectionId = String(formData.get("section_id") ?? "");
  if (!UUID.test(sectionId)) back({ err: "bad" });
  const { error } = await session.supabase.functions.invoke("page-sections", { body: { action: "delete", section_id: sectionId } });
  if (error) back({ err: `sections_failed:${error.message.slice(0, 120)}` });
  back({ ok: "section_deleted" });
}

// ---------------------------------------------------------------- the header logo (own domain)

const LOGO_TYPES: Record<string, string> = { "image/webp": "webp", "image/png": "png" };
const MAX_LOGO_BYTES = 1024 * 1024;

/** The storage path of this shop's header logo in the public bucket "logos", or null. */
function siteLogoPath(url: string | null, shopId: string): string | null {
  const m = url?.match(/\/storage\/v1\/object\/public\/logos\/(.+)$/);
  return m && m[1].startsWith(`${shopId}/site-logo-`) ? decodeURIComponent(m[1]) : null;
}

async function oldSiteLogo(supabase: Supabase, shopId: string): Promise<string[]> {
  const { data } = await supabase.from("shops").select("site_logo_url").eq("id", shopId).maybeSingle();
  const path = siteLogoPath((data as { site_logo_url: string | null } | null)?.site_logo_url ?? null, shopId);
  return path ? [path] : [];
}

/**
 * "Vybrať logo" (database update 31): the logo made in the browser (at most 120 px high, WebP or
 * PNG with its transparency), checked again here with sharp, stored in the shop's folder of the
 * public bucket "logos"; owner_set_site_logo() decides (Pro or a domain of its own).
 */
export async function uploadSiteLogo(formData: FormData) {
  const { session, shopId, back } = await start(formData, "header");
  const file = formData.get("site_logo");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_LOGO_BYTES || !LOGO_TYPES[file.type]) back({ err: "site_logo" });
  const bytes = Buffer.from(await (file as File).arrayBuffer());
  const meta = await sharp(bytes).metadata().catch(() => null);
  const format = meta?.format === "webp" ? "image/webp" : meta?.format === "png" ? "image/png" : null;
  if (!meta || format !== (file as File).type || !meta.width || !meta.height || meta.width < 16 || meta.width > 1600 ||
      meta.height < 16 || meta.height > 400) {
    back({ err: "site_logo" });
  }
  const path = `${shopId}/site-logo-${Date.now()}.${LOGO_TYPES[format!]}`;
  const storage = session.supabase.storage.from("logos");
  const old = await oldSiteLogo(session.supabase, shopId);
  const { error: uploadError } = await storage.upload(path, bytes, { contentType: format!, upsert: false });
  if (uploadError) back({ err: uploadError.message });
  const { error } = await session.supabase.rpc("owner_set_site_logo", {
    p_shop_id: shopId,
    p_url: storage.getPublicUrl(path).data.publicUrl,
    p_width: meta!.width,
    p_height: meta!.height,
  });
  if (error) {
    await storage.remove([path]);
    back({ err: error.message === "no_plan" ? "sections_site_logo_no_plan" : "site_logo" });
  }
  if (old.length) await storage.remove(old);
  back({ ok: "site_logo_saved" });
}

/** "Odstrániť logo": the shop's own logo is used again. */
export async function removeSiteLogo(formData: FormData) {
  const { session, shopId, back } = await start(formData, "header");
  const old = await oldSiteLogo(session.supabase, shopId);
  const { error } = await session.supabase.rpc("owner_set_site_logo", { p_shop_id: shopId, p_url: null, p_width: null, p_height: null });
  if (error) back({ err: error.message });
  if (old.length) await session.supabase.storage.from("logos").remove(old);
  back({ ok: "site_logo_removed" });
}

/**
 * "Odkaz loga" (database update 32): where a click on the own domain's header logo leads. The
 * address as the browser reads it (https only; the database checks it again);
 * owner_set_site_logo_link() decides (Pro or a domain of its own). Empty = the home page again.
 */
export async function saveSiteLogoLink(formData: FormData) {
  const { session, shopId, back } = await start(formData, "header");
  let link = String(formData.get("site_logo_link") ?? "").trim().slice(0, 500);
  if (link && !/^[a-z][a-z0-9+.-]*:/i.test(link)) link = `https://${link}`;
  if (link) {
    try {
      const url = new URL(link.replace(/^http:\/\//i, "https://"));
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("site_logo_link");
      link = url.toString();
    } catch {
      back({ err: "sections_site_logo_link" });
    }
  }
  const { error } = await session.supabase.rpc("owner_set_site_logo_link", { p_shop_id: shopId, p_link: link || null });
  if (error) {
    back({ err: error.message === "no_plan" ? "sections_site_logo_no_plan" : error.message === "link" ? "sections_site_logo_link" : error.message });
  }
  back({ ok: link ? "site_logo_link_saved" : "site_logo_link_removed" });
}

/** "Späť na úvodnú stránku": the logo leads to the shop's home page again (always allowed). */
export async function resetSiteLogoLink(formData: FormData) {
  const { session, shopId, back } = await start(formData, "header");
  const { error } = await session.supabase.rpc("owner_set_site_logo_link", { p_shop_id: shopId, p_link: null });
  if (error) back({ err: error.message });
  back({ ok: "site_logo_link_removed" });
}
