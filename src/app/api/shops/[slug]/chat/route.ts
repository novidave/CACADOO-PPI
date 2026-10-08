import { isLocale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { chatAllowed, chatShop, cleanHistory, cleanPhoto, MAX_TEXT, runShopChat, shopChatEnabled } from "@/lib/shopChat";

/**
 * POST {lang, history: [{role, text}], message, photo?} from the AI assistant on a shop
 * page. Answers {answer, cards, list, photo} or {error}: unavailable, not_found, no_plan,
 * caller_limit, shop_limit, bad_request, bad_photo, failed. The shop comes from the
 * address; the assistant's tools only ever see that shop. A logged-in owner also gets
 * the reason of a failure (for testing); every failure is logged as "shop-chat: …".
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

  let body: { lang?: unknown; history?: unknown; message?: unknown; photo?: unknown };
  try {
    body = await request.json();
  } catch {
    return failed("bad_request", 400);
  }
  const lang = typeof body?.lang === "string" && isLocale(body.lang) ? body.lang : "en";
  const photo = cleanPhoto(body?.photo);
  if (photo === "bad") return failed("bad_photo", 400);
  const message = (typeof body?.message === "string" ? body.message.trim() : "").slice(0, MAX_TEXT);
  if (!message && !photo) return failed("bad_request", 400);

  try {
    const shop = await chatShop(slug);
    if (!shop) return failed("not_found", 404);
    const verdict = await chatAllowed(request, shop.id);
    if (verdict === "no_plan") return failed("no_plan", 403);
    if (verdict !== "ok") return failed(verdict, 429);
    // Text sent with a photo but without words: the photo is the question.
    const question = message || "What is on this photo, and does this shop have it?";
    return reply(await runShopChat(shop, lang, cleanHistory(body?.history), question, photo));
  } catch (e) {
    return failed("failed", 502, (e instanceof Error ? e.message : String(e)).slice(0, 500));
  }
}
