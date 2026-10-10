import "server-only";
import { createPublicClient } from "./supabase/public";

/**
 * The shop assistant's archive (paid plan, database update 22). Every conversation is kept
 * for the shop's owners and made into a PDF when it ends (30 minutes without a message, or
 * the shopper closes the chat). The website writes it only through the assistant-archive
 * Edge Function, proving itself with ASSISTANT_ARCHIVE_SECRET (a server variable, never in
 * the browser). The shopper's files go from the browser straight to that function with
 * the conversation's own token (Vercel would cut request bodies over 4.5 MB).
 */

export interface Conversation {
  id: string;
  token: string;
}

/** An item card as the shopper saw it: kept as it was at that moment. */
export interface ArchiveCard {
  name: string;
  price: string;
  availability: string;
  /** When the shop's stock file was made (the data behind the card). */
  data_time: string | null;
  quantity?: number;
  note?: string;
}

export interface ArchiveMessage {
  body: string;
  /** The same text in Slovak for the owner, when written in another language. */
  body_owner: string | null;
  lang: string | null;
}

export type ArchiveError = "no_plan" | "not_found" | "too_many" | "too_many_files" | "ended" | "unavailable" | "failed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
const KNOWN: ArchiveError[] = ["no_plan", "not_found", "too_many", "too_many_files", "ended"];

function secret(): string | null {
  const value = process.env.ASSISTANT_ARCHIVE_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

/** On when ASSISTANT_ARCHIVE_SECRET (at least 32 characters) is set on the server. */
export function archiveEnabled(): boolean {
  return secret() !== null && supabaseUrl() !== null;
}

function supabaseUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  try {
    return url ? new URL(url.trim()).origin : null;
  } catch {
    return null;
  }
}

/** Where the shopper's browser sends files: the Edge Function itself. */
export function uploadUrl(): string | null {
  const base = supabaseUrl();
  return base ? `${base}/functions/v1/assistant-archive` : null;
}

/** A conversation id and token from the browser, or null. */
export function cleanConversation(value: unknown): Conversation | null {
  const v = value as { id?: unknown; token?: unknown } | null;
  if (!v || typeof v.id !== "string" || typeof v.token !== "string") return null;
  return UUID.test(v.id) && TOKEN.test(v.token) ? { id: v.id, token: v.token } : null;
}

async function call<T>(body: Record<string, unknown>): Promise<{ data: T | null; error: ArchiveError | null }> {
  const key = secret();
  const supabase = createPublicClient();
  if (!key || !supabase) return { data: null, error: "unavailable" };
  const { data, error } = await supabase.functions.invoke<T>("assistant-archive", {
    body,
    headers: { "x-ppi-archive": key },
  });
  if (!error) return { data: data ?? null, error: null };
  // The function answers {error: "..."}; anything else is a failure (logged without content).
  let code: unknown = null;
  try {
    code = (await (error as { context?: Response }).context?.json())?.error;
  } catch {
    // not JSON
  }
  const known = KNOWN.find((k) => k === code);
  if (!known) console.error(`assistant-archive: ${String(body.action)} failed (${typeof code === "string" ? code : error.name})`);
  return { data: null, error: known ?? "failed" };
}

/** A new conversation (paid shops only; at most 30 an hour per shopper and shop). */
export async function openConversation(shopId: string, pageLang: string, caller: string) {
  return call<Conversation>({ action: "start", shop_id: shopId, page_lang: pageLang, caller });
}

/** One exchange: the shopper's message (with its files) and the answer with the cards shown; only into this shop's conversation. */
export async function recordTurn(
  conversation: Conversation,
  shopId: string,
  shopper: ArchiveMessage & { at: string; attachments: string[] },
  assistant: ArchiveMessage & { cards: ArchiveCard[] },
) {
  return call<{ ok: true }>({ action: "record", ...conversation, shop_id: shopId, shopper, assistant });
}

/** The shopper closed the chat ("closed") or started a new one ("new"): the PDF is made now. */
export async function endConversation(conversation: Conversation, reason: "closed" | "new") {
  return call<{ ended: boolean }>({ action: "end", ...conversation, reason });
}

/** "Vymazať moju konverzáciu": the conversation and its files are deleted. */
export async function deleteConversation(conversation: Conversation) {
  return call<{ deleted: boolean }>({ action: "delete", ...conversation });
}

/** A file the shopper took back before sending it: deleted from the archive. */
export async function discardFile(conversation: Conversation, attachment: string) {
  if (!UUID.test(attachment)) return { data: null, error: "not_found" as ArchiveError };
  return call<{ discarded: boolean }>({ action: "discard", ...conversation, attachment });
}
