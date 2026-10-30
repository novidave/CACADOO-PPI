import { callerHash, rateLimit } from "@/lib/apiHttp";
import { cleanConversation } from "@/lib/assistantArchive";
import { createPublicClient } from "@/lib/supabase/public";

const PRIVATE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: PRIVATE });

/** The consent text's version kept with the request (change it whenever chat.callback_consent changes). */
const CALLBACK_CONSENT = "callback-2026-10-30";
const REASONS = ["not_available", "consent", "empty", "phone", "email", "name", "too_many"];

/**
 * "Nechajte nám kontakt" in the shop assistant (database update 59): {phone?, email?, name?, consent, conversation}.
 * Only the database decides (shopper_leave_contact: the conversation's own token, the shop's plan, the limits); the
 * shopper only ever hears "ok" or why not. At most 10 a minute per caller.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/shops/[slug]/callback">) {
  const { slug } = await ctx.params;
  const limited = await rateLimit(request, "callback", 10);
  if (limited) return limited;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const conversation = cleanConversation(body.conversation);
  if (!conversation) return json({ error: "not_available" }, 400);
  const str = (k: string, max: number) => (typeof body[k] === "string" ? (body[k] as string).trim().slice(0, max) || null : null);
  const client = createPublicClient();
  if (!client) return json({ error: "unavailable" }, 503);
  const { error } = await client.rpc("shopper_leave_contact", {
    p_slug: slug,
    p_conversation_id: conversation.id,
    p_token: conversation.token,
    p_name: str("name", 120),
    p_phone: str("phone", 40),
    p_email: str("email", 254),
    p_consent: body.consent === true,
    p_consent_version: CALLBACK_CONSENT,
    p_caller_hash: callerHash(request),
  });
  if (error) {
    const reason = REASONS.includes(error.message) ? error.message : "failed";
    if (reason === "failed") console.error("callback: refused", error.code ?? "");
    return json({ error: reason }, reason === "too_many" ? 429 : 400);
  }
  return json({ ok: true });
}
