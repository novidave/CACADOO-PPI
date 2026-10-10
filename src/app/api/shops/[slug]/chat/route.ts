import { isLocale, type Locale } from "@/i18n/config";
import { callerHash } from "@/lib/apiHttp";
import { archiveEnabled, cleanConversation, type Conversation, openConversation, recordTurn } from "@/lib/assistantArchive";
import { getSession } from "@/lib/auth";
import { docsToken } from "@/lib/docsAccess";
import {
  type ChatAttachment,
  chatAllowed,
  type ChatResult,
  chatShop,
  cleanAttachments,
  cleanHistory,
  hideAccessKeys,
  MAX_TEXT,
  runShopChat,
  shopChatEnabled,
} from "@/lib/shopChat";

/**
 * POST {lang, history: [{role, text}], message, attachments?: [{id, name, kind, image?, text?}],
 * conversation?: {id, token}} from the AI assistant on a shop page. Answers {answer, cards,
 * list, photo, sources, pictures, docPrices, callShop, conversation} or {error}: unavailable,
 * not_found, no_plan, caller_limit, shop_limit, bad_request, bad_photo, failed. The shop
 * comes from the address; the assistant's tools only ever see that shop. With the archive
 * on, every exchange is kept in the shop's conversation archive (a new conversation when
 * none is given or it has ended); `conversation` says which one. A logged-in owner also
 * gets the reason of a failure (for testing); every failure is logged as "shop-chat: …".
 * No CORS headers: only the PPI website itself calls this.
 */
export const maxDuration = 60;

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function failed(error: string, status: number, reason?: string) {
  if (reason) console.error(`shop-chat: ${reason}`);
  const owner = reason ? await getSession().catch(() => null) : null;
  return reply(owner ? { error, reason } : { error }, status);
}

export async function POST(request: Request, ctx: RouteContext<"/api/shops/[slug]/chat">) {
  const { slug } = await ctx.params;
  if (!shopChatEnabled()) return failed("unavailable", 503);

  let body: { lang?: unknown; history?: unknown; message?: unknown; attachments?: unknown; conversation?: unknown };
  try {
    body = await request.json();
  } catch {
    return failed("bad_request", 400);
  }
  const receivedAt = new Date().toISOString();
  const lang = typeof body?.lang === "string" && isLocale(body.lang) ? body.lang : "en";
  const attachments = cleanAttachments(body?.attachments);
  if (attachments === null) return failed("bad_photo", 400);
  const message = hideAccessKeys((typeof body?.message === "string" ? body.message.trim() : "").slice(0, MAX_TEXT));
  if (!message && attachments.length === 0) return failed("bad_request", 400);

  try {
    const shop = await chatShop(slug);
    if (!shop) return failed("not_found", 404);
    const verdict = await chatAllowed(request, shop.id);
    if (verdict === "no_plan") return failed("no_plan", 403);
    if (verdict !== "ok") return failed(verdict, 429);
    // Files sent without words: the files are the question.
    const question =
      message ||
      (attachments.some((a) => a.kind !== "pdf")
        ? "What is on this photo, and does this shop have it?"
        : "Please look at the attached file: which of these things does this shop have?");
    // The access-key session (cookie) goes only to the database, never to the AI.
    const token = await docsToken(shop.slug);
    const given = archiveEnabled() ? cleanConversation(body?.conversation) : null;
    const [result, opened] = await Promise.all([
      runShopChat(shop, lang, cleanHistory(body?.history), question, attachments, token),
      archiveEnabled() && !given ? openConversation(shop.id, lang, callerHash(request)) : null,
    ]);
    const conversation = given ?? opened?.data ?? null;
    const kept = conversation
      ? await archive(request, shop.id, lang, conversation, result, { message, receivedAt, attachments })
      : null;
    return reply({ ...result.reply, conversation: kept });
  } catch (e) {
    return failed("failed", 502, (e instanceof Error ? e.message : String(e)).slice(0, 500));
  }
}

/**
 * Keeps one exchange in the shop's archive. A conversation that has ended meanwhile (30
 * minutes without a message, or closed in another tab) is followed by a new one. An
 * archive failure never costs the shopper the answer; it is logged without any content.
 */
async function archive(
  request: Request,
  shopId: string,
  lang: Locale,
  conversation: Conversation,
  result: ChatResult,
  sent: { message: string; receivedAt: string; attachments: ChatAttachment[] },
): Promise<Conversation | null> {
  const shopper = {
    body: sent.message,
    body_owner: result.archive.messageOwner,
    lang: result.archive.language,
    at: sent.receivedAt,
    attachments: sent.attachments.flatMap((a) => (a.id ? [a.id] : [])),
  };
  const assistant = {
    body: result.reply.answer || "–",
    body_owner: result.archive.answerOwner,
    lang: result.archive.language,
    cards: result.archive.cards,
  };
  const saved = await recordTurn(conversation, shopId, shopper, assistant);
  if (saved.error !== "ended" && saved.error !== "not_found") return conversation;
  const fresh = await openConversation(shopId, lang, callerHash(request));
  if (!fresh.data) return null;
  // The files belong to the ended conversation and stay there.
  await recordTurn(fresh.data, shopId, { ...shopper, attachments: [] }, assistant);
  return fresh.data;
}
