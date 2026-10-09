"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { endOfLocalDay } from "@/lib/format";

// "Documents for the assistant" on the dashboard. The database functions (owner_*) check
// that the shop is the owner's; deleting goes through the doc-ingest function, which
// removes the files with the service role (never on the website).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (formData: FormData, key: string, max: number) => String(formData.get(key) ?? "").trim().slice(0, max);
const id = (formData: FormData, key: string) => {
  const value = String(formData.get(key) ?? "");
  return UUID.test(value) ? value : null;
};

/** Sections with document lists: "Documents for the assistant", and the private ones under "Export folder". */
const SECTIONS = ["docs", "private"];

/** Who is asking, and the way back to the section with a message. */
async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const slug = String(formData.get("shop_slug") ?? "");
  const atValue = String(formData.get("at") ?? "");
  const at = SECTIONS.includes(atValue) ? atValue : "docs";
  const back = (query: Record<string, string>): never =>
    redirect(`/${lang}/dashboard?${new URLSearchParams({ shop: slug, ...query, at })}#${at}`);
  return { session, shopId: id(formData, "shop_id"), back };
}

/** Database refusals the owner can act on; anything else is shown as it is. */
function reason(error: { code?: string; message: string }, codes: Record<string, string>): string {
  return codes[error.code ?? ""] ? `docs_${codes[error.code ?? ""]}` : error.message;
}

export async function acceptDocsTerms(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  if (!shopId || formData.get("agree") !== "on") back({ err: "docs_agree" });
  const { error } = await session.supabase.rpc("owner_accept_docs_terms", { p_shop_id: shopId });
  back(error ? { err: error.message } : { ok: "docs_terms" });
}

/** A new private folder, or a new name for one. */
export async function saveFolder(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const { error } = await session.supabase.rpc("owner_save_folder", {
    p_shop_id: shopId,
    p_folder_id: id(formData, "folder_id"),
    p_name: text(formData, "name", 60),
  });
  back(error ? { err: reason(error, { "23505": "folder_exists", "54000": "folder_limit", "22023": "folder_name" }) } : { ok: "docs_saved" });
}

export async function deleteFolder(formData: FormData) {
  const { session, back } = await start(formData);
  const { error } = await session.supabase.rpc("owner_delete_folder", { p_folder_id: id(formData, "folder_id") });
  back(error ? { err: reason(error, { "55006": "folder_not_empty" }) } : { ok: "docs_deleted" });
}

/** Name, short description, folder, "Assistant may use it", "Shoppers may download it". */
export async function saveDocument(formData: FormData) {
  const { session, back } = await start(formData);
  const { error } = await session.supabase.rpc("owner_update_document", {
    p_document_id: id(formData, "document_id"),
    p_name: text(formData, "name", 200),
    p_description: text(formData, "description", 500),
    p_folder_id: id(formData, "folder"),
    p_assistant_enabled: formData.get("assistant") === "on",
    p_downloadable: formData.get("download") === "on",
  });
  back(error ? { err: reason(error, { "22023": "name" }) } : { ok: "docs_saved" });
}

/** Title, caption, the (corrected) description, folder and "Assistant may show it". */
export async function savePicture(formData: FormData) {
  const { session, back } = await start(formData);
  const { error } = await session.supabase.rpc("owner_update_picture", {
    p_picture_id: id(formData, "picture_id"),
    p_title: text(formData, "title", 200),
    p_caption: text(formData, "caption", 500),
    p_description: text(formData, "description", 2000),
    p_folder_id: id(formData, "folder"),
    p_show: formData.get("show") === "on",
  });
  back(error ? { err: reason(error, { "22023": "name" }) } : { ok: "docs_saved" });
}

/** Deletes a PDF (with its pictures and text) or one picture: doc-ingest removes the files first. */
export async function deleteDocOrPicture(formData: FormData) {
  const { session, back } = await start(formData);
  const kind = formData.get("kind") === "picture" ? "picture" : "document";
  const { error } = await session.supabase.functions.invoke("doc-ingest", {
    body: { action: "delete", kind, id: id(formData, "id") },
  });
  if (error) {
    const context = (error as { context?: unknown }).context;
    const reply = context instanceof Response ? await context.json().catch(() => null) : null;
    back({ err: `docs:${String(reply?.message ?? error.message).slice(0, 300)}` });
  }
  back({ ok: "docs_deleted" });
}

export interface KeyState {
  key?: string;
  label?: string;
  error?: string;
}

/**
 * A new access key for one or more private folders. The key is returned here once, to be
 * shown with "Copy"; only its hash is stored, and it never appears in an address.
 */
export async function createFolderKey(_previous: KeyState, formData: FormData): Promise<KeyState> {
  const session = await getSession();
  if (!session) return { error: "login" };
  const folders = formData.getAll("folders").map(String).filter((v) => UUID.test(v));
  if (folders.length === 0) return { error: "key_folders" };
  const label = text(formData, "label", 80);
  if (!label) return { error: "key_label" };
  const day = text(formData, "expires", 10);
  const expires = day ? endOfLocalDay(day, text(formData, "timezone", 64)) : null;
  if (day && (!expires || expires.getTime() <= Date.now())) return { error: "key_expiry" };
  const { data, error } = await session.supabase.rpc("owner_create_folder_key", {
    p_shop_id: id(formData, "shop_id"),
    p_label: label,
    p_folder_ids: folders,
    p_expires_at: expires?.toISOString() ?? null,
  });
  if (error) return { error: error.code === "54000" ? "key_limit" : error.message };
  refresh(); // the list of keys below shows the new one
  return { key: String(data), label };
}

export async function revokeFolderKey(formData: FormData) {
  const { session, back } = await start(formData);
  const { error } = await session.supabase.rpc("owner_revoke_folder_key", { p_key_id: id(formData, "key_id") });
  back(error ? { err: error.message } : { ok: "docs_revoked" });
}
