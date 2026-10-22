"use server";

import sharp from "sharp";
import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { sectionUrl } from "@/lib/dashboardPages";
import { MAX_SLIDES, type Slot, type SlotKind } from "@/lib/pageContent";
import { refreshShop } from "@/lib/publicCache";

/**
 * "Obsah stránky" (database update 38: the slider and its library of PDFs and pictures) and the header logo of an own
 * domain and its link (updates 31–32). Every change goes through an owner function that checks the caller owns the
 * shop and its plan's limits; after a change of what visitors see, the page-sections function moves the pictures in
 * or out of the public bucket at once (the hourly job would too).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function start(formData: FormData, at: "content" | "header") {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const back = (query: Record<string, string>) => {
    // A saved change a visitor can see: the public pages read it again at once.
    if (query.ok) refreshShop(slug);
    return redirect(sectionUrl(lang, at, { shop: slug, ...query }));
  };
  if (!UUID.test(shopId)) back({ err: "invalid shop" });
  return { session, shopId, back };
}

const dateOrNull = (value: FormDataEntryValue | string | null) => (DATE.test(String(value ?? "")) ? String(value) : null);
const layout = (value: unknown) => (value === "stacked" ? "stacked" : "slider");

type Supabase = NonNullable<Awaited<ReturnType<typeof getSession>>>["supabase"];

const itemError = (message: string) => (["title", "dates", "limit", "empty", "bad"].includes(message) ? `content_${message}` : message);

/** The shop's pictures follow what the database now says (errors here are only logged: the job retries). */
async function syncShop(supabase: Supabase, shopId: string) {
  const { error } = await supabase.functions.invoke("page-sections", { body: { action: "sync", shop_id: shopId } });
  if (error) console.error("page-sections sync:", error.message);
}

/**
 * A new file in the library (the browser then reads and sends the PDF or the picture). Called by the uploader in the
 * browser; answers the new file's id or the reason. `addSlot`: into a free slot of its kind, when the plan has room.
 */
export async function createItem(input: {
  shopId: string;
  kind: "pdf" | "picture";
  title: string;
  fileName: string;
  allowDownload: boolean;
  pageLayout: string;
  from: string | null;
  until: string | null;
  alt: string;
  addSlot: boolean;
}): Promise<{ id: string } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "login" };
  if (!UUID.test(input.shopId) || (input.kind !== "pdf" && input.kind !== "picture")) return { error: "bad" };
  const { data, error } = await session.supabase.rpc("owner_save_item", {
    p_shop_id: input.shopId,
    p_item_id: null,
    p_kind: input.kind,
    p_title: String(input.title ?? "").slice(0, 200),
    p_file_name: String(input.fileName ?? "").slice(0, 200),
    p_allow_download: Boolean(input.allowDownload),
    p_page_layout: layout(input.pageLayout),
    p_from: dateOrNull(input.from),
    p_until: dateOrNull(input.until),
    p_alt: String(input.alt ?? "").slice(0, 300) || null,
    p_add_slot: Boolean(input.addSlot),
  });
  if (error) return { error: error.message };
  return { id: String(data) };
}

/** "Upraviť": title, alt text, download, the PDF's viewer, dates (a changed date may show or hide it). */
export async function updateItem(formData: FormData) {
  const { session, shopId, back } = await start(formData, "content");
  const itemId = String(formData.get("item_id") ?? "");
  if (!UUID.test(itemId)) back({ err: "bad" });
  const { error } = await session.supabase.rpc("owner_save_item", {
    p_shop_id: shopId,
    p_item_id: itemId,
    p_kind: null,
    p_title: String(formData.get("title") ?? "").slice(0, 200),
    p_file_name: null,
    p_allow_download: formData.get("allow_download") === "on",
    p_page_layout: layout(formData.get("page_layout")),
    p_from: dateOrNull(formData.get("from")),
    p_until: dateOrNull(formData.get("until")),
    p_alt: String(formData.get("alt") ?? "").slice(0, 300) || null,
    p_add_slot: false,
  });
  if (error) back({ err: itemError(error.message), item: itemId });
  await syncShop(session.supabase, shopId);
  back({ ok: "section_saved" });
}

/** "Skryť" / "Zobraziť": a hidden file drops out of the slider (its slot stays), the rest keep their order. */
export async function setItemState(formData: FormData) {
  const { session, shopId, back } = await start(formData, "content");
  const itemId = String(formData.get("item_id") ?? "");
  const action = String(formData.get("state") ?? "");
  if (!UUID.test(itemId) || !["hide", "show"].includes(action)) back({ err: "bad" });
  const { error } = await session.supabase.rpc("owner_set_section_state", { p_section_id: itemId, p_action: action });
  if (error) back({ err: itemError(error.message) });
  await syncShop(session.supabase, shopId);
  back({ ok: action === "hide" ? "section_hidden" : "section_shown" });
}

/** "Vymazať": every file (both buckets) first, then the file's row; its slot stays empty (not shown). */
export async function deleteItem(formData: FormData) {
  const { session, back } = await start(formData, "content");
  const itemId = String(formData.get("item_id") ?? "");
  if (!UUID.test(itemId)) back({ err: "bad" });
  const { error } = await session.supabase.functions.invoke("page-sections", { body: { action: "delete", section_id: itemId } });
  if (error) back({ err: `sections_failed:${error.message.slice(0, 120)}` });
  back({ ok: "section_deleted" });
}

const KINDS: SlotKind[] = ["auto_post", "pinned_post", "pdf", "picture"];

/**
 * "Uložiť" of the editor: the section's title, "Zobraziť názov sekcie", "Vždy otvorené" / "Rozbaľovacie" and every
 * slot in order. The database checks the plan's limits, the files and posts (owner_save_content); the pictures follow.
 */
export async function saveContent(input: {
  shopId: string;
  title: string;
  showTitle: boolean;
  display: "open" | "collapsed";
  /** "Tlačidlo ▶ pri videách otvorí" (update 39). */
  videoTarget?: "post" | "facebook";
  slots: Slot[];
}): Promise<{ ok: true } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "login" };
  if (!UUID.test(input.shopId) || !Array.isArray(input.slots) || input.slots.length > MAX_SLIDES) return { error: "bad" };
  const slots = input.slots.map((s) => ({
    kind: KINDS.includes(s.kind) ? s.kind : "auto_post",
    item_id: (s.kind === "pdf" || s.kind === "picture") && s.item_id && UUID.test(s.item_id) ? s.item_id : null,
    post_id: s.kind === "pinned_post" && s.post_id && UUID.test(s.post_id) ? s.post_id : null,
  }));
  const { error } = await session.supabase.rpc("owner_save_content", {
    p_shop_id: input.shopId,
    p_title: String(input.title ?? "").slice(0, 200),
    p_show_title: Boolean(input.showTitle),
    p_display: input.display === "collapsed" ? "collapsed" : "open",
    p_slots: slots,
    // Before update 39 the database has no such setting: it is not sent then.
    ...(input.videoTarget ? { p_video_target: input.videoTarget === "facebook" ? "facebook" : "post" } : {}),
  });
  if (error) return { error: error.message };
  await syncShop(session.supabase, input.shopId);
  return { ok: true };
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
