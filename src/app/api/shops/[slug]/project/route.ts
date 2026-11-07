import { isLocale } from "@/i18n/config";
import { callerHash, rateLimit } from "@/lib/apiHttp";
import { cleanConversation } from "@/lib/assistantArchive";
import { bookingsCall, bookingsEnabled } from "@/lib/bookings";
import { lockProject, projectsEnabled, unlockProject } from "@/lib/projectAccess";

const PRIVATE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: PRIVATE });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The shop assistant's project form (update 95), never the AI:
 *   code   {phone, conversation, lang?} → an SMS code — only a contact with a checked number and an enabled project
 *          gets one; every number gets the same answer
 *   unlock {id, code, conversation} → a session for THIS conversation (signed HttpOnly cookie)
 *   lock   {} → the session ends ("Nová konverzácia", the chat closes, the page is left)
 * The bookings function and the database decide everything; at most 20 calls a minute per caller.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/shops/[slug]/project">) {
  const { slug } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // sendBeacon on the way out sends {action: "lock"} as a blob; anything unreadable is a lock too
    body = { action: "lock" };
  }
  if (body.action === "lock") {
    await lockProject(slug).catch(() => {});
    return json({ ok: true });
  }
  if (!bookingsEnabled() || !projectsEnabled()) return json({ error: "unavailable" }, 503);
  const limited = await rateLimit(request, "project", 20);
  if (limited) return limited;
  const conversation = cleanConversation(body.conversation);
  if (!conversation) return json({ error: "conversation" }, 400);
  if (body.action === "code") {
    const result = await bookingsCall<Record<string, unknown>>({
      action: "project_code",
      slug,
      phone: typeof body.phone === "string" ? body.phone.trim().slice(0, 40) : null,
      caller: callerHash(request),
      conversation_id: conversation.id,
      conversation_token: conversation.token,
      lang: typeof body.lang === "string" && isLocale(body.lang) ? body.lang : null,
    });
    if (result.error) return json({ error: result.error }, result.status >= 400 && result.status < 600 ? result.status : 502);
    return json(result.data ?? {});
  }
  if (body.action === "unlock" && UUID.test(String(body.id ?? ""))) {
    const result = await unlockProject(slug, String(body.id), typeof body.code === "string" ? body.code : "", conversation).catch(() => null);
    if (!result) return json({ error: "failed" }, 502);
    if (result.status === "ok") return json({ ok: true, expires_at: result.expires_at });
    return json({ error: result.status, ...(result.status === "wrong" ? { attempts_left: result.attempts_left } : {}) }, 400);
  }
  return json({ error: "bad_request" }, 400);
}
