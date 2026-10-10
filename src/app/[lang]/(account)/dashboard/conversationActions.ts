"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAYS = [30, 90, 365];

/** Who is asking (the session), for which shop; RLS and the database functions decide what they may do. */
async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const back = (query: Record<string, string>) =>
    redirect(`/${lang}/dashboard?${new URLSearchParams({ shop: slug, ...query, at: "conversations" })}#conversations`);
  return { lang, session, shopId, back };
}

/** How long the shop keeps its assistant's conversations: 30, 90 or 365 days (owners only). */
export async function saveAssistantRetention(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const days = Number(formData.get("retention_days"));
  if (!UUID.test(shopId) || !DAYS.includes(days)) back({ err: "invalid" });
  const { error } = await session.supabase.rpc("owner_set_assistant_retention", { p_shop_id: shopId, p_days: days });
  back(error ? { err: error.message } : { ok: "retention" });
}

/**
 * Deletes one conversation with its files and PDF. The assistant-archive function checks
 * with the owner's own login (RLS) that it belongs to one of their shops.
 */
export async function deleteConversation(formData: FormData) {
  const { lang, session, back } = await start(formData);
  const id = String(formData.get("conversation_id") ?? "");
  if (!UUID.test(id) || formData.get("confirm") !== "on") redirect(`/${lang}/dashboard/conversations/${id}?err=confirm`);
  const { error } = await session.supabase.functions.invoke("assistant-archive", {
    body: { action: "owner_delete", conversation_id: id },
  });
  if (error) redirect(`/${lang}/dashboard/conversations/${id}?err=delete`);
  back({ ok: "conversation_deleted" });
}
