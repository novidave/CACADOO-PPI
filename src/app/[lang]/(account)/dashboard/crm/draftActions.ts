"use server";

import { getSession } from "@/lib/auth";

/**
 * The reply's draft (database update 90): one per conversation and owner, on the server so it follows the owner to
 * another device. owner_draft_save / _get / _clear decide (members of the conversation's shop; an empty text clears;
 * no activity log). Never sent to the customer, never in exports, PDFs or the archive.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DraftAnswer = { ok: true; at: string | null } | { ok: false };

export async function saveDraft(input: { conversationId: string; channel: "sms" | "email"; subject: string; body: string }): Promise<DraftAnswer> {
  const session = await getSession();
  if (!session || !UUID.test(input.conversationId)) return { ok: false };
  const { data, error } = await session.supabase.rpc("owner_draft_save", {
    p_conversation_id: input.conversationId,
    p_channel: input.channel === "email" ? "email" : "sms",
    p_subject: String(input.subject ?? "").slice(0, 200),
    p_body: String(input.body ?? "").slice(0, 5000),
  });
  if (error) return { ok: false };
  return { ok: true, at: (data as string | null) ?? null };
}

export async function clearDraft(conversationId: string): Promise<{ ok: boolean }> {
  const session = await getSession();
  if (!session || !UUID.test(conversationId)) return { ok: false };
  const { error } = await session.supabase.rpc("owner_draft_clear", { p_conversation_id: conversationId });
  return { ok: !error };
}
