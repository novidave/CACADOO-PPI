"use server";

import { redirect } from "next/navigation";
import { sectionUrl } from "@/lib/dashboardPages";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAYS = [30, 90, 365];
/** The list's own address parameters (filters and page) a form may carry back. */
const LIST_KEYS = ["cq", "cfrom", "cto", "cstatus", "cstar", "cna", "cfiles", "clang", "cpage"];
const MARKS = ["read", "new", "archive", "unarchive", "star", "unstar"];
/** At most this many conversations are deleted in one go (each through the archive function). */
const MAX_DELETE = 100;

/** Who is asking (the session), for which shop; RLS and the database functions decide what they may do. */
async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  // The list as the owner left it (only its own parameters).
  const kept = new URLSearchParams(String(formData.get("back") ?? ""));
  const list = Object.fromEntries(LIST_KEYS.flatMap((k) => (kept.get(k) ? [[k, kept.get(k)!.slice(0, 100)]] : [])));
  const back = (query: Record<string, string>) =>
    redirect(sectionUrl(lang, "conversations", { shop: slug, ...list, ...query }));
  return { lang, session, shopId, back };
}

/** Deletes one conversation with its files and PDF (the assistant-archive function checks the owner's login). */
async function removeOne(session: NonNullable<Awaited<ReturnType<typeof getSession>>>, id: string): Promise<boolean> {
  const { error } = await session.supabase.functions.invoke("assistant-archive", {
    body: { action: "owner_delete", conversation_id: id },
  });
  return !error;
}

/** Writes a deletion in the shop's activity log (database update 55; skipped quietly before it). */
async function logDeleted(session: NonNullable<Awaited<ReturnType<typeof getSession>>>, shopId: string, count: number, failed: number) {
  if (!UUID.test(shopId) || count === 0) return;
  const { error } = await session.supabase.rpc("owner_conversations_log", {
    p_shop_id: shopId,
    p_action: "conversations_deleted",
    p_details: { count, failed },
  });
  if (error && error.code !== "PGRST202" && error.code !== "42883") console.error(`conversations: deletion not logged (${error.code})`);
}

/**
 * How long the shop keeps its assistant's conversations: "Neobmedzene" (empty = kept until the owner deletes them,
 * database update 55) or 30, 90 or 365 days (owners only).
 */
export async function saveAssistantRetention(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const value = String(formData.get("retention_days") ?? "");
  const days = value === "" ? null : Number(value);
  if (!UUID.test(shopId) || (days !== null && !DAYS.includes(days))) back({ err: "invalid" });
  const { error } = await session.supabase.rpc("owner_set_assistant_retention", { p_shop_id: shopId, p_days: days });
  back(error ? { err: error.message } : { ok: days === null ? "retention_unlimited" : "retention", n: String(days ?? "") });
}

/**
 * Deletes one conversation with its files and PDF. The assistant-archive function checks
 * with the owner's own login (RLS) that it belongs to one of their shops.
 */
export async function deleteConversation(formData: FormData) {
  const { lang, session, shopId, back } = await start(formData);
  const id = String(formData.get("conversation_id") ?? "");
  if (!UUID.test(id) || formData.get("confirm") !== "on") redirect(`/${lang}/dashboard/conversations/${id}?err=confirm`);
  if (!(await removeOne(session, id))) redirect(`/${lang}/dashboard/conversations/${id}?err=delete`);
  await logDeleted(session, shopId, 1, 0);
  back({ ok: "conversation_deleted" });
}

/**
 * The list's bulk actions on the ticked conversations: prečítané / nové / archivovať / späť z archívu / hviezdička
 * (owner_conversations_mark: only the shop's own conversations change, logged), or vymazať (with the confirmation tick;
 * each one through the archive function, then one line in the log).
 */
export async function bulkConversations(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const op = String(formData.get("op") ?? "");
  const ids = [...new Set(formData.getAll("ids").map(String).filter((id) => UUID.test(id)))];
  if (!UUID.test(shopId) || (op !== "delete" && !MARKS.includes(op))) back({ err: "invalid" });
  if (ids.length === 0) back({ err: "conversations_none" });
  if (op === "delete") {
    if (formData.get("confirm") !== "on") back({ err: "conversations_confirm" });
    let done = 0;
    let failed = 0;
    // A few at a time: the function deletes the files in storage for each.
    const batch = ids.slice(0, MAX_DELETE);
    for (let i = 0; i < batch.length; i += 5) {
      const results = await Promise.all(batch.slice(i, i + 5).map((id) => removeOne(session, id)));
      done += results.filter(Boolean).length;
      failed += results.filter((r) => !r).length;
    }
    await logDeleted(session, shopId, done, failed);
    back(failed ? { err: "conversations_delete_some", n: String(done), failed: String(failed) } : { ok: "conversations_deleted", n: String(done) });
  }
  const { data, error } = await session.supabase.rpc("owner_conversations_mark", { p_shop_id: shopId, p_ids: ids, p_action: op });
  back(error ? { err: error.message } : { ok: "conversations_marked", n: String(data ?? 0) });
}

/** The star of one conversation (the ☆ / ★ button in the list). */
export async function starConversation(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const id = String(formData.get("conversation_id") ?? "");
  const op = String(formData.get("op") ?? "");
  if (!UUID.test(shopId) || !UUID.test(id) || (op !== "star" && op !== "unstar")) back({ err: "invalid" });
  const { error } = await session.supabase.rpc("owner_conversations_mark", { p_shop_id: shopId, p_ids: [id], p_action: op });
  back(error ? { err: error.message } : {});
}

/** The owner's private note on a conversation (never shown to the shopper; empty clears it). */
export async function saveConversationNote(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const id = String(formData.get("conversation_id") ?? "");
  if (!UUID.test(id)) redirect(`/${lang}/dashboard`);
  const note = String(formData.get("note") ?? "").slice(0, 2000);
  const { error } = await session.supabase.rpc("owner_conversation_note", { p_id: id, p_note: note });
  redirect(`/${lang}/dashboard/conversations/${id}?${error ? "err=note" : "ok=note"}#note`);
}

/** "Označiť ako nové" / archive from the conversation's own page. */
export async function markConversation(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const id = String(formData.get("conversation_id") ?? "");
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const op = String(formData.get("op") ?? "");
  if (!UUID.test(id) || !UUID.test(shopId) || !MARKS.includes(op)) redirect(`/${lang}/dashboard`);
  const { error } = await session.supabase.rpc("owner_conversations_mark", { p_shop_id: shopId, p_ids: [id], p_action: op });
  // "Označiť ako nové" goes back to the list (opening it again would mark it read).
  if (!error && op === "new") redirect(sectionUrl(lang, "conversations", { shop: slug, ok: "conversations_marked", n: "1" }));
  redirect(`/${lang}/dashboard/conversations/${id}${error ? "?err=mark" : ""}`);
}

/** "Zákazníci si môžu stiahnuť svoju konverzáciu (PDF)": on or off (database update 24). */
export async function saveShopperPdf(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  if (!UUID.test(shopId)) back({ err: "invalid" });
  const { error } = await session.supabase.rpc("owner_set_shopper_pdf", { p_shop_id: shopId, p_on: formData.get("shopper_pdf") === "on" });
  back(error ? { err: error.message } : { ok: "shopper_pdf" });
}
