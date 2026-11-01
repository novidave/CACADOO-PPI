import { isLocale } from "@/i18n/config";
import { callerHash, rateLimit } from "@/lib/apiHttp";
import { cleanConversation, forgetAllForShopper } from "@/lib/assistantArchive";
import { bookingsCall, bookingsEnabled } from "@/lib/bookings";

const PRIVATE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: PRIVATE });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The texts the shopper agrees to in the contact form (kept with the conversation; update 63). */
export const CONTACT_CONSENT = "chat-contact-2026-10-31";

/**
 * The shop assistant's own forms (update 63), never the AI:
 *   start  {purpose: contact | delete_all, phone, name?, consent?, conversation?, lang?} → an SMS code to the number
 *   verify {id, code, conversation?} → contact: the number is checked and the conversation may book for it
 *   forget {id} → delete_all, after its code was verified: everything about that number in this shop is deleted
 * The bookings function and the database decide everything (limits, expiry, tries); at most 20 calls a minute per caller.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/shops/[slug]/contact">) {
  const { slug } = await ctx.params;
  if (!bookingsEnabled()) return json({ error: "unavailable" }, 503);
  const limited = await rateLimit(request, "contact", 20);
  if (limited) return limited;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const str = (k: string, max: number) => (typeof body[k] === "string" ? (body[k] as string).trim().slice(0, max) : null);
  const conversation = cleanConversation(body.conversation);
  const purpose = body.purpose === "delete_all" ? "delete_all" : "contact";
  if (body.action === "start") {
    if (purpose === "contact" && (body.consent !== true || !conversation)) return json({ error: "consent" }, 400);
    const result = await bookingsCall<Record<string, unknown>>({
      action: "code_start",
      slug,
      purpose,
      phone: str("phone", 40),
      name: purpose === "contact" ? str("name", 80) : null,
      consent_version: purpose === "contact" ? CONTACT_CONSENT : null,
      caller: callerHash(request),
      conversation_id: conversation?.id ?? null,
      conversation_token: conversation?.token ?? null,
      lang: typeof body.lang === "string" && isLocale(body.lang) ? body.lang : null,
    });
    if (result.error) return json({ error: result.error }, result.status >= 400 && result.status < 600 ? result.status : 502);
    return json(result.data ?? {});
  }
  if (body.action === "verify" && UUID.test(String(body.id ?? ""))) {
    const result = await bookingsCall<Record<string, unknown>>({
      action: "code_verify",
      id: body.id,
      code: str("code", 12),
      conversation_id: conversation?.id ?? null,
      conversation_token: conversation?.token ?? null,
    });
    if (result.error) return json({ ...(result.extra ?? {}), error: result.error }, result.status >= 400 && result.status < 600 ? result.status : 502);
    return json(result.data ?? {});
  }
  if (body.action === "forget" && UUID.test(String(body.id ?? ""))) {
    const { data, error } = await forgetAllForShopper(String(body.id));
    if (error) return json({ error }, error === "not_verified" ? 403 : 502);
    return json(data ?? { deleted: true });
  }
  return json({ error: "bad_request" }, 400);
}
