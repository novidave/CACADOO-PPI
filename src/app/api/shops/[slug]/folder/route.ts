import { rateLimit } from "@/lib/apiHttp";
import { docsKeysEnabled, downloadUrl, zipUrl } from "@/lib/docsAccess";

/**
 * Downloads from a private folder the shopper opened with an access key (database update 24):
 *   POST {action: "download", kind, id} → {url}  a 10-minute address of the original
 *   POST {action: "zip", folder_id}     → {url}  a single-use ZIP of the downloadable files
 * Errors: {error: "limit"} (20 per unlocked session), "not_found" (not downloadable or no
 * key), "empty", "too_big" (ZIP over 100 MB). The database decides and counts every one.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request, ctx: RouteContext<"/api/shops/[slug]/folder">) {
  const { slug } = await ctx.params;
  if (!docsKeysEnabled()) return reply({ error: "unavailable" }, 503);
  const limited = await rateLimit(request, `shop-folder:${slug}`);
  if (limited) return limited;
  let body: { action?: unknown; kind?: unknown; id?: unknown; folder_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  const result =
    body?.action === "download" && (body.kind === "document" || body.kind === "picture") && UUID.test(String(body.id))
      ? await downloadUrl(slug, body.kind, String(body.id))
      : body?.action === "zip" && UUID.test(String(body.folder_id))
        ? await zipUrl(slug, String(body.folder_id))
        : null;
  if (!result) return reply({ error: "bad_request" }, 400);
  if ("url" in result) return reply(result);
  const status = { limit: 429, too_big: 413, unavailable: 503, not_found: 404, empty: 404 }[result.error];
  return reply(result, status);
}
