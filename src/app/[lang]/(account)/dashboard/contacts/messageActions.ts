"use server";

import { getSession } from "@/lib/auth";
import { claudeGrammar } from "@/lib/grammar";
import { contactError, splitTags } from "@/lib/crm";
import { fixGrammarWith } from "@/lib/messageTags";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GrammarResponse =
  | { ok: true; text: string; subject: string | null; left: number | null }
  | { ok: false; error: string };

/**
 * "Opraviť gramatiku": the shop's daily limit first (owner_grammar_hit: a member with the plan), then Claude; the
 * tokens are added to the AI spend (owner_ai_spend). Nothing is sent or saved — the owner chooses "Použiť".
 */
export async function fixGrammar(input: { shopId: string; text: string; subject?: string | null; channel: "sms" | "email" }): Promise<GrammarResponse> {
  const session = await getSession();
  if (!session) return { ok: false, error: "err_forbidden" };
  if (!UUID.test(input.shopId)) return { ok: false, error: "err_forbidden" };
  const text = String(input.text ?? "").slice(0, 10_000);
  if (!text.trim()) return { ok: false, error: "err_grammar_empty" };
  const ai = claudeGrammar();
  if (!ai) return { ok: false, error: "err_grammar_off" };
  const hit = await session.supabase.rpc("owner_grammar_hit", { p_shop_id: input.shopId });
  if (hit.error) {
    const reason = hit.error.message;
    return { ok: false, error: reason === "grammar_limit" ? "err_grammar_limit" : reason === "grammar_off" ? "err_grammar_off" : reason === "no_plan" ? "err_no_plan" : "err_forbidden" };
  }
  try {
    const result = await fixGrammarWith(ai, { text, subject: input.subject ?? null, channel: input.channel === "email" ? "email" : "sms" });
    if (!result.ok) return { ok: false, error: result.reason === "empty" ? "err_grammar_empty" : "err_grammar_structure" };
    await session.supabase.rpc("owner_ai_spend", { p_shop_id: input.shopId, p_kind: "grammar", p_input: result.usage.input, p_output: result.usage.output });
    return { ok: true, text: result.text, subject: result.subject, left: typeof hit.data === "number" ? hit.data : null };
  } catch (e) {
    console.error("grammar: failed", (e instanceof Error ? e.message : String(e)).slice(0, 120));
    return { ok: false, error: "err_grammar_failed" };
  }
}

export interface PickedContact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

/** "+ Nový kontakt" in CRM → Správy: saves the contact (owner_save_contact) and gives it back to be the recipient. */
export async function createContactInline(formData: FormData): Promise<{ ok: true; contact: PickedContact } | { ok: false; error: string }> {
  const session = await getSession();
  if (!session) return { ok: false, error: "err_forbidden" };
  const shopId = String(formData.get("shop_id") ?? "");
  if (!UUID.test(shopId)) return { ok: false, error: "err_failed" };
  const field = (name: string, max: number) => String(formData.get(name) ?? "").slice(0, max);
  const { data, error } = await session.supabase.rpc("owner_save_contact", {
    p_shop_id: shopId,
    p_id: null,
    p_name: field("name", 120),
    p_phone: field("phone", 40),
    p_email: field("email", 254),
    p_address: field("address", 300),
    p_tags: splitTags(field("tags", 1000)),
    p_note: field("note", 4000),
    p_conversation_id: null,
  });
  if (error) return { ok: false, error: contactError(error.message) };
  const id = String(data);
  const row = await session.supabase.from("shop_contacts").select("id, name, phone, email").eq("id", id).maybeSingle();
  const c = (row.data ?? { id, name: field("name", 120) || null, phone: null, email: field("email", 254) || null }) as PickedContact;
  return { ok: true, contact: c };
}
