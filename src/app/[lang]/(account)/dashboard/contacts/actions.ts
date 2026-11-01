"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { contactError, messageError, splitTags } from "@/lib/crm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who is asking (the session) and for which shop; the owner_* functions decide what they may do (RLS, the plan). */
async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const list = (query: Record<string, string>) =>
    `/${lang}/dashboard/contacts?${new URLSearchParams({ ...(slug ? { shop: slug } : {}), ...query })}`;
  const contact = (id: string, query: Record<string, string>) =>
    `/${lang}/dashboard/contacts/${id}?${new URLSearchParams(query)}`;
  return { lang, session, shopId, slug, list, contact };
}

const field = (formData: FormData, name: string, max: number) => String(formData.get(name) ?? "").slice(0, max);

/**
 * Saves a contact (new one without `contact_id`). The database makes the phone E.164 with the shop's country and
 * refuses a number another contact already has; `conversation_id` links that conversation right away.
 */
export async function saveContact(formData: FormData) {
  const { session, shopId, list, contact } = await start(formData);
  const id = String(formData.get("contact_id") ?? "");
  const conversation = String(formData.get("conversation_id") ?? "");
  const back = (query: Record<string, string>) => redirect(UUID.test(id) ? contact(id, query) : list({ ...query, new: "1" }));
  if (!UUID.test(shopId)) back({ err: "err_failed" });
  const { data, error } = await session.supabase.rpc("owner_save_contact", {
    p_shop_id: shopId,
    p_id: UUID.test(id) ? id : null,
    p_name: field(formData, "name", 120),
    p_phone: field(formData, "phone", 40),
    p_email: field(formData, "email", 254),
    p_address: field(formData, "address", 300),
    p_tags: splitTags(field(formData, "tags", 1000)),
    p_note: field(formData, "note", 4000),
    p_conversation_id: UUID.test(conversation) ? conversation : null,
  });
  if (error) back({ err: contactError(error.message) });
  redirect(contact(String(data), { ok: "ok_saved" }));
}

/** Deletes a contact after the confirmation tick (its conversations and the message log stay). */
export async function deleteContact(formData: FormData) {
  const { session, list, contact } = await start(formData);
  const id = String(formData.get("contact_id") ?? "");
  if (!UUID.test(id)) redirect(list({}));
  if (formData.get("confirm") !== "on") redirect(contact(id, { err: "err_confirm" }));
  const { error } = await session.supabase.rpc("owner_delete_contact", { p_id: id });
  if (error) redirect(contact(id, { err: contactError(error.message) }));
  redirect(list({ ok: "ok_deleted" }));
}

/** Saves a template (new one without `template_id`); update 63: for SMS, e-mail or both (an SMS needs no subject). */
export async function saveTemplate(formData: FormData) {
  const { session, shopId, list } = await start(formData);
  const id = String(formData.get("template_id") ?? "");
  const channel = String(formData.get("channel") ?? "email");
  const { error } = await session.supabase.rpc("owner_save_message_template", {
    p_shop_id: shopId,
    p_id: UUID.test(id) ? id : null,
    p_name: field(formData, "name", 80),
    p_channel: ["sms", "email", "both"].includes(channel) ? channel : "email",
    p_subject: field(formData, "subject", 200) || null,
    p_body: field(formData, "body", 10000),
  });
  redirect(list({ view: "templates", ...(error ? { err: contactError(error.message) } : { ok: "ok_template" }) }));
}

export async function deleteTemplate(formData: FormData) {
  const { session, list } = await start(formData);
  const id = String(formData.get("template_id") ?? "");
  const { error } = UUID.test(id)
    ? await session.supabase.rpc("owner_delete_email_template", { p_id: id })
    : { error: { message: "failed" } };
  redirect(list({ view: "templates", ...(error ? { err: "err_failed" } : { ok: "ok_template_deleted" }) }));
}

/** A conversation's contact, from the conversation's page (empty = remove the assignment). */
export async function linkConversation(formData: FormData) {
  const { lang, session } = await start(formData);
  const conversation = String(formData.get("conversation_id") ?? "");
  const contactId = String(formData.get("contact_id") ?? "");
  if (!UUID.test(conversation)) redirect(`/${lang}/dashboard`);
  const { error } = await session.supabase.rpc("owner_link_conversation", {
    p_conversation_id: conversation,
    p_contact_id: UUID.test(contactId) ? contactId : null,
  });
  redirect(`/${lang}/dashboard/conversations/${conversation}?${error ? `err=${contactError(error.message)}` : "ok=linked"}#contact`);
}

/** What the message composer shows after "Náhľad" / "Odoslať". */
export interface ComposeState {
  step: "edit" | "preview" | "done";
  /** A `contacts.*` key: the error, or after sending the outcome (sent / sent_test / sent_failed). */
  message?: string;
  preview?: { recipient: string; subject: string | null; body: string };
}

function composeInput(formData: FormData) {
  const template = String(formData.get("template_id") ?? "");
  return {
    p_contact_id: String(formData.get("contact_id") ?? ""),
    p_channel: String(formData.get("channel") ?? ""),
    p_template_id: UUID.test(template) ? template : null,
    p_subject: field(formData, "subject", 400) || null,
    p_body: field(formData, "body", 12000) || null,
  };
}

/** "Náhľad": the message as the database would send it (variables filled in), nothing written. */
export async function previewMessage(_state: ComposeState, formData: FormData): Promise<ComposeState> {
  const session = await getSession();
  if (!session) return { step: "edit", message: "err_forbidden" };
  const input = composeInput(formData);
  if (!UUID.test(input.p_contact_id)) return { step: "edit", message: "err_forbidden" };
  const { data, error } = await session.supabase.rpc("owner_message_preview", input);
  if (error) return { step: "edit", message: messageError(error.code === "42501" ? "forbidden" : error.message) };
  const preview = data as { recipient: string; subject: string | null; body: string };
  return { step: "preview", preview };
}

/** "Odoslať" after the preview: crm-messages writes it down (owner_message_queue) and sends it. */
export async function sendMessage(_state: ComposeState, formData: FormData): Promise<ComposeState> {
  const session = await getSession();
  if (!session) return { step: "edit", message: "err_forbidden" };
  const input = composeInput(formData);
  if (!UUID.test(input.p_contact_id)) return { step: "edit", message: "err_forbidden" };
  // update 63: from a conversation the answer is part of it (owner_reply: the conversation's own contact)
  const conversation = String(formData.get("conversation_id") ?? "");
  const inConversation = UUID.test(conversation);
  const { data, error } = await session.supabase.functions.invoke<{ id?: string; status?: string; error?: string }>("crm-messages", {
    body: {
      ...(inConversation ? { action: "reply", conversation_id: conversation } : { action: "send", contact_id: input.p_contact_id }),
      channel: input.p_channel,
      template_id: input.p_template_id,
      subject: input.p_subject,
      body: input.p_body,
    },
  });
  if (error || !data?.status) {
    // The function's refusal (400/403) comes back as an error with the body in its context.
    let reason: string | undefined;
    try {
      const context = (error as { context?: Response } | null)?.context;
      reason = context ? ((await context.json()) as { error?: string }).error : data?.error;
    } catch {
      reason = undefined;
    }
    return { step: "edit", message: messageError(reason) };
  }
  revalidatePath(`/${String(formData.get("lang") ?? "sk")}/dashboard/contacts/${input.p_contact_id}`);
  if (inConversation) revalidatePath(`/${String(formData.get("lang") ?? "sk")}/dashboard/conversations/${conversation}`);
  return { step: "done", message: data.status === "sent" ? "sent" : data.status === "test" ? "sent_test" : "sent_failed" };
}
