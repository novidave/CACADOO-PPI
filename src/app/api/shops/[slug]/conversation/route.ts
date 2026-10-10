import { isLocale } from "@/i18n/config";
import { callerHash, rateLimit } from "@/lib/apiHttp";
import {
  archiveEnabled,
  cleanConversation,
  deleteConversation,
  discardFile,
  endConversation,
  openConversation,
  uploadUrl,
} from "@/lib/assistantArchive";
import { chatShop, shopChatEnabled } from "@/lib/shopChat";

/**
 * The archive of the shop's assistant (paid plan), for the chat box on the shop page:
 *   POST {action: "start", lang}            → {id, token, upload}  a new conversation
 *   POST {action: "end", id, token, reason} → {ended}              the shopper closed the chat
 *   POST {action: "delete", id, token}      → {deleted}            "Vymazať moju konverzáciu"
 *   POST {action: "discard", id, token, attachment} → {discarded}  a file taken back before sending
 * The token is the conversation's own secret, kept only in the shopper's browser (the
 * database keeps its hash). At most 60 calls a minute per caller (rateLimit); new
 * conversations: 30 an hour per caller and shop (the database). No CORS headers: only the
 * PPI website itself calls this.
 */
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request, ctx: RouteContext<"/api/shops/[slug]/conversation">) {
  const { slug } = await ctx.params;
  if (!shopChatEnabled() || !archiveEnabled()) return reply({ error: "unavailable" }, 503);
  const limited = await rateLimit(request, "assistant-conversation");
  if (limited) return limited;

  let body: { action?: unknown; lang?: unknown; reason?: unknown; attachment?: unknown };
  try {
    body = await request.json();
  } catch {
    return reply({ error: "bad_request" }, 400);
  }

  if (body?.action === "start") {
    const shop = await chatShop(slug).catch(() => null);
    if (!shop) return reply({ error: "not_found" }, 404);
    const lang = typeof body.lang === "string" && isLocale(body.lang) ? body.lang : "en";
    const { data, error } = await openConversation(shop.id, lang, callerHash(request));
    if (error || !data) {
      const status = error === "no_plan" ? 403 : error === "too_many" ? 429 : error === "not_found" ? 404 : 503;
      return reply({ error: error ?? "failed" }, status);
    }
    return reply({ id: data.id, token: data.token, upload: uploadUrl() });
  }

  const conversation = cleanConversation(body);
  if (!conversation) return reply({ error: "bad_request" }, 400);
  if (body?.action === "end") {
    const { data, error } = await endConversation(conversation, body.reason === "new" ? "new" : "closed");
    return error ? reply({ error }, error === "not_found" ? 404 : 503) : reply({ ended: Boolean(data?.ended) });
  }
  if (body?.action === "discard") {
    const { error } = await discardFile(conversation, String(body.attachment ?? ""));
    return error ? reply({ error }, error === "not_found" ? 404 : 503) : reply({ discarded: true });
  }
  if (body?.action === "delete") {
    const { error } = await deleteConversation(conversation);
    return error ? reply({ error }, error === "not_found" ? 404 : 503) : reply({ deleted: true });
  }
  return reply({ error: "bad_request" }, 400);
}
