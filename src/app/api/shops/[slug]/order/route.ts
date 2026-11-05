import { isLocale } from "@/i18n/config";
import { callerHash, rateLimit } from "@/lib/apiHttp";
import { cleanConversation } from "@/lib/assistantArchive";
import { bookingsCall, bookingsEnabled } from "@/lib/bookings";
import { quoteWithPlace } from "@/lib/food";
import { cleanCart } from "@/lib/foodRules";

const PRIVATE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: PRIVATE });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The text of the consent the customer ticks in the order form (kept with the conversation). */
export const ORDER_CONSENT = "food-order-2026-11-03";

/**
 * The order form in the shop assistant (database update 73), never the AI:
 *   quote {lines, kind, address?} → the price rule (Sklad prices, the zone, its fee and minimum, the total)
 *   code  {name, phone, consent, conversation, lang} → an SMS code (the shop's order quota)
 *   place {code_id, code, order_id, lines, kind, pay_method, address?, note?, conversation, lang} → the order
 * Prices, zones, times and the code are decided in SQL; at most 20 calls a minute per caller.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/shops/[slug]/order">) {
  const { slug } = await ctx.params;
  const limited = await rateLimit(request, "food_order", 20);
  if (limited) return limited;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const str = (k: string, max: number) => (typeof body[k] === "string" ? (body[k] as string).trim().slice(0, max) : null);
  const kind = body.kind === "delivery" ? "delivery" : "pickup";
  const lang = typeof body.lang === "string" && isLocale(body.lang) ? body.lang : null;

  if (body.action === "quote" || body.action === "place") {
    const lines = cleanCart(body.lines);
    if (!lines) return json({ error: "lines" }, 400);
    const address = kind === "delivery" ? str("address", 300) : null;
    const { quote, error, place } = await quoteWithPlace(slug, lines, kind, address);
    if (error || !quote) return json({ error: error === "not_available" ? "not_available" : "failed" }, error === "not_available" ? 404 : 502);
    if (body.action === "quote") return json({ quote });
    if (!quote.orderable) return json({ error: quote.problem ?? "failed", quote }, 400);
    if (!bookingsEnabled()) return json({ error: "unavailable" }, 503);
    const conversation = cleanConversation(body.conversation);
    if (!conversation || !UUID.test(String(body.code_id ?? "")) || !UUID.test(String(body.order_id ?? ""))) {
      return json({ error: "bad_request" }, 400);
    }
    const result = await bookingsCall<Record<string, unknown>>({
      action: "order_place",
      code_id: body.code_id,
      code: str("code", 12),
      order_id: body.order_id,
      lines,
      kind,
      // update 85: the customer never chooses how to pay (marked by the owner or the courier at the handover)
      pay_method: null,
      address,
      note: str("note", 300),
      lat: place?.lat ?? null,
      lng: place?.lng ?? null,
      conversation_id: conversation.id,
      conversation_token: conversation.token,
      lang,
    });
    if (result.error) {
      return json({ ...(result.extra ?? {}), error: result.error }, result.status >= 400 && result.status < 600 ? result.status : 502);
    }
    return json(result.data ?? {});
  }

  if (body.action === "code") {
    if (!bookingsEnabled()) return json({ error: "unavailable" }, 503);
    const conversation = cleanConversation(body.conversation);
    if (body.consent !== true || !conversation) return json({ error: "consent" }, 400);
    const result = await bookingsCall<Record<string, unknown>>({
      action: "code_start",
      slug,
      purpose: "order",
      phone: str("phone", 40),
      name: str("name", 80),
      consent_version: ORDER_CONSENT,
      caller: callerHash(request),
      conversation_id: conversation.id,
      conversation_token: conversation.token,
      lang,
    });
    if (result.error) return json({ error: result.error }, result.status >= 400 && result.status < 600 ? result.status : 502);
    return json(result.data ?? {});
  }
  return json({ error: "bad_request" }, 400);
}
