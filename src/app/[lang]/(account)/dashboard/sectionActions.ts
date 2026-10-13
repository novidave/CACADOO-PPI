"use server";

import sharp from "sharp";
import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { sectionUrl } from "@/lib/dashboardPages";
import { POSITIONS, type SectionPosition } from "@/lib/sectionLimits";

/**
 * Page sections from PDFs and the header picture of an own domain (database update 28). Every
 * change goes through an owner function that checks the caller owns the shop (and, for
 * sections, that it has the paid plan); after a change of what visitors see, the page-sections
 * function moves the pictures in or out of the public bucket at once (the hourly job would too).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PICTURE_TYPES: Record<string, string> = { "image/webp": "webp", "image/jpeg": "jpg" };
const MAX_PICTURE_BYTES = 1024 * 1024;

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

// ---------------------------------------------------------------- the header picture (own domain)

/** The storage path of a picture of this shop's folder in the public bucket "logos", or null. */
function logoPath(url: string | null, shopId: string): string | null {
  const m = url?.match(/\/storage\/v1\/object\/public\/logos\/(.+)$/);
  return m && m[1].startsWith(`${shopId}/header-`) ? decodeURIComponent(m[1]) : null;
}

async function oldHeader(supabase: Supabase, shopId: string): Promise<string[]> {
  const { data } = await supabase.from("shops").select("header_url, header_small_url").eq("id", shopId).maybeSingle();
  const row = data as { header_url: string | null; header_small_url: string | null } | null;
  return [logoPath(row?.header_url ?? null, shopId), logoPath(row?.header_small_url ?? null, shopId)].filter((p): p is string => Boolean(p));
}

/** "Vybrať obrázok": the 1600 px and 800 px versions made in the browser, checked again here. */
export async function uploadHeaderPicture(formData: FormData) {
  const { session, shopId, back } = await start(formData, "header");
  const large = formData.get("header");
  const small = formData.get("header_small");
  const checked = async (file: FormDataEntryValue | null, width: number) => {
    if (!(file instanceof File) || file.size === 0 || file.size > MAX_PICTURE_BYTES || !PICTURE_TYPES[file.type]) return null;
    const bytes = Buffer.from(await file.arrayBuffer());
    const meta = await sharp(bytes).metadata().catch(() => null);
    const format = meta?.format === "jpeg" ? "image/jpeg" : meta?.format === "webp" ? "image/webp" : null;
    if (!meta || format !== file.type || meta.width !== width || !meta.height || meta.height < 50 || meta.height > 4000) return null;
    return { bytes, type: file.type, height: meta.height };
  };
  const [big, little] = await Promise.all([checked(large, 1600), checked(small, 800)]);
  if (!big || !little || big.type !== little.type) back({ err: "header_picture" });
  const ext = PICTURE_TYPES[big!.type];
  const base = `${shopId}/header-${Date.now()}`;
  const storage = session.supabase.storage.from("logos");
  const old = await oldHeader(session.supabase, shopId);
  for (const [path, file] of [[`${base}.${ext}`, big!], [`${base}-800.${ext}`, little!]] as const) {
    const { error } = await storage.upload(path, file.bytes, { contentType: file.type, upsert: false });
    if (error) back({ err: error.message });
  }
  const { error } = await session.supabase.rpc("owner_set_header_picture", {
    p_shop_id: shopId,
    p_url: storage.getPublicUrl(`${base}.${ext}`).data.publicUrl,
    p_small_url: storage.getPublicUrl(`${base}-800.${ext}`).data.publicUrl,
    p_width: 1600,
    p_height: big!.height,
  });
  if (error) {
    await storage.remove([`${base}.${ext}`, `${base}-800.${ext}`]);
    back({ err: error.message === "no_plan" ? "sections_no_plan" : "header_picture" });
  }
  if (old.length) await storage.remove(old);
  back({ ok: "header_saved" });
}

/** "Odstrániť obrázok". */
export async function removeHeaderPicture(formData: FormData) {
  const { session, shopId, back } = await start(formData, "header");
  const old = await oldHeader(session.supabase, shopId);
  const { error } = await session.supabase.rpc("owner_set_header_picture", {
    p_shop_id: shopId,
    p_url: null,
    p_small_url: null,
    p_width: null,
    p_height: null,
  });
  if (error) back({ err: error.message });
  if (old.length) await session.supabase.storage.from("logos").remove(old);
  back({ ok: "header_removed" });
}
