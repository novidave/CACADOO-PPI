import { isLocale } from "@/i18n/config";
import { callerHash, rateLimit } from "@/lib/apiHttp";
import { cleanConversation } from "@/lib/assistantArchive";
import { bookingsCall, bookingsEnabled, CONSENT_VERSION } from "@/lib/bookings";

const PRIVATE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: PRIVATE });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The booking form in the shop assistant (database update 57): start {starts_at, name, phone, email?, address?,
 * note?, consent, conversation?} → the SMS code; resend {id, token}; verify {id, token, code} → confirmed. Everything
 * goes to the bookings function, which decides with the database; at most 20 calls a minute per caller.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/shops/[slug]/booking">) {
  const { slug } = await ctx.params;
  if (!bookingsEnabled()) return json({ error: "unavailable" }, 503);
  const limited = await rateLimit(request, "booking", 20);
  if (limited) return limited;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const str = (k: string, max: number) => (typeof body[k] === "string" ? (body[k] as string).trim().slice(0, max) : null);
  const action = body.action;
  let call: Record<string, unknown>;
  if (action === "start") {
    const conversation = cleanConversation(body.conversation);
    call = {
      action,
      slug,
      starts_at: str("starts_at", 40),
      name: str("name", 120),
      phone: str("phone", 40),
      email: str("email", 254),
      address: str("address", 300),
      note: str("note", 500),
      consent: body.consent === true,
      consent_version: CONSENT_VERSION,
      lang: typeof body.lang === "string" && isLocale(body.lang) ? body.lang : null,
      caller: callerHash(request),
      conversation_id: conversation?.id ?? null,
      conversation_token: conversation?.token ?? null,
    };
  } else if ((action === "verify" || action === "resend") && UUID.test(String(body.id ?? ""))) {
    call = { action, id: body.id, token: str("token", 128), ...(action === "verify" ? { code: str("code", 12) } : {}) };
  } else {
    return json({ error: "bad_request" }, 400);
  }
  const result = await bookingsCall<Record<string, unknown>>(call);
  if (result.error) return json({ ...(result.extra ?? {}), error: result.error }, result.status >= 400 && result.status < 600 ? result.status : 502);
  return json(result.data ?? {});
}
