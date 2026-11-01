import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { conversationTxt, exportName, localStamp, type TxtMessage } from "@/lib/conversationExport";
import { PRIVATE, UUID } from "@/lib/conversationPdfs";
import { getSession } from "@/lib/auth";
import type { MyShop } from "@/lib/myShops";

interface Row {
  id: string;
  shop_id: string;
  started_at: string;
  ended_at: string | null;
  shopper_lang: string | null;
  page_lang: string;
}

/**
 * "Stiahnuť TXT" of one conversation (database update 55): every message with its time in the shop's time zone, the
 * Slovak version, the shopper's file names and the product cards, plus the owner's private note. Read with the owner's
 * own login (RLS: members of the shop only); the download is written in the shop's activity log.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/owner/conversations/[id]/txt">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404, headers: PRIVATE });
  const session = await getSession();
  if (!session) return new Response("Please log in", { status: 401, headers: PRIVATE });
  const { supabase } = session;
  const langParam = new URL(request.url).searchParams.get("lang") ?? "";
  const lang: Locale = isLocale(langParam) ? langParam : "sk";

  const { data: conv } = await supabase
    .from("assistant_conversations")
    .select("id, shop_id, started_at, ended_at, shopper_lang, page_lang")
    .eq("id", id)
    .maybeSingle<Row>();
  if (!conv) return new Response("Not found", { status: 404, headers: PRIVATE });
  const [dict, shopsRes, messagesRes, filesRes, marksRes] = await Promise.all([
    getDictionary(lang),
    supabase.rpc("my_shops"),
    supabase.from("assistant_messages").select("*").eq("conversation_id", id).order("created_at").order("id"),
    supabase.from("assistant_attachments").select("id, name").eq("conversation_id", id),
    supabase.from("assistant_conversations").select("status, unanswered, access_key_used, starred, owner_note").eq("id", id).maybeSingle(),
  ]);
  const shop = ((shopsRes.data ?? []) as MyShop[]).find((s) => s.id === conv.shop_id);
  if (!shop || messagesRes.error) return new Response("Not found", { status: 404, headers: PRIVATE });
  const c = dict.conversations;
  const names = new Map(((filesRes.data ?? []) as { id: string; name: string }[]).map((f) => [f.id, f.name]));
  const marks = marksRes.error
    ? null
    : (marksRes.data as { status: string; unanswered: boolean | null; access_key_used: boolean | null; starred: boolean; owner_note: string | null } | null);
  const tz = shop.timezone;
  const language = (code: string | null) => {
    if (!code) return c.unknown;
    try {
      return new Intl.DisplayNames([lang], { type: "language" }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  const status = marks ? ({ new: c.status_new, read: c.status_read, archived: c.status_archived } as Record<string, string>)[marks.status] ?? "" : "";
  const flags = marks
    ? [marks.unanswered ? c.flag_unanswered : "", marks.access_key_used ? c.flag_access_key : "", marks.starred ? c.flag_starred : ""]
        .filter(Boolean)
        .join(" · ")
    : "";
  const messages = ((messagesRes.data ?? []) as Record<string, unknown>[]).map(
    (m): TxtMessage => ({
      role: m.role === "shopper" ? "shopper" : "assistant",
      body: String(m.body ?? ""),
      body_owner: m.body_owner ? String(m.body_owner) : null,
      created_at: String(m.created_at),
      unanswered: m.unanswered === true,
      files: ((m.attachment_ids as string[] | null) ?? []).flatMap((a) => (names.has(a) ? [names.get(a)!] : [])),
      cards: Array.isArray(m.cards) ? (m.cards as TxtMessage["cards"]) : [],
    }),
  );
  const text = conversationTxt(messages, tz, {
    title: t(c.txt_title, { shop: shop.name }),
    facts: [
      [c.started, localStamp(conv.started_at, tz)],
      [c.ended, conv.ended_at ? localStamp(conv.ended_at, tz) : c.running],
      [c.language, language(conv.shopper_lang)],
      [c.page_language, language(conv.page_lang)],
      [c.status_label, status],
      [c.flags, flags],
      [c.note_title, marks?.owner_note ?? ""],
    ],
    shopper: c.shopper,
    assistant: c.assistant,
    owner: dict.asst.role_owner,
    inOwnerLang: c.in_slovak,
    files: c.csv_files,
    unanswered: c.unanswered_message,
  });
  const { error: logError } = await supabase.rpc("owner_conversations_log", {
    p_shop_id: shop.id,
    p_action: "conversations_exported",
    p_details: { format: "txt", conversation_id: id },
  });
  if (logError && logError.code !== "PGRST202" && logError.code !== "42883") console.error(`conversations: TXT export not logged (${logError.code})`);
  return new Response(text, {
    headers: {
      ...PRIVATE,
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportName(conv.started_at, id, tz, "txt")}"`,
    },
  });
}
