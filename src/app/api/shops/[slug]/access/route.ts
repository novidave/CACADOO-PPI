import { docsKeysEnabled, lock, sessionStatus, unlock } from "@/lib/docsAccess";

/**
 * "I have an access key" in the shop's assistant (never part of the chat):
 *   GET    → {enabled, open: {folders, expires_at} | null}
 *   POST   {key} → {status: ok | wrong | too_many | unavailable, folders?, expires_at?}
 *   DELETE → "Lock again"
 * The key goes only to the database; the session token stays in an HttpOnly cookie.
 * No CORS headers: only the PPI website itself calls this.
 */
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(_request: Request, ctx: RouteContext<"/api/shops/[slug]/access">) {
  const { slug } = await ctx.params;
  if (!docsKeysEnabled()) return reply({ enabled: false, open: null });
  return reply({ enabled: true, open: await sessionStatus(slug).catch(() => null) });
}

export async function POST(request: Request, ctx: RouteContext<"/api/shops/[slug]/access">) {
  const { slug } = await ctx.params;
  let key = "";
  try {
    const body = await request.json();
    key = typeof body?.key === "string" ? body.key.trim() : "";
  } catch {
    return reply({ status: "wrong" }, 400);
  }
  if (!key) return reply({ status: "wrong" }, 400);
  try {
    const result = await unlock(request, slug, key);
    return reply(result, result.status === "ok" ? 200 : result.status === "too_many" ? 429 : result.status === "wrong" ? 403 : 503);
  } catch (e) {
    console.error("folder-key:", e instanceof Error ? e.message : e);
    return reply({ status: "unavailable" }, 503);
  }
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/shops/[slug]/access">) {
  const { slug } = await ctx.params;
  await lock(slug).catch((e) => console.error("folder-key lock:", e instanceof Error ? e.message : e));
  return reply({ ok: true });
}
