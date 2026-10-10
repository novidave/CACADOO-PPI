import { isLocale } from "@/i18n/config";
import { rateLimit } from "@/lib/apiHttp";
import { viewManifest } from "@/lib/docsAccess";

/**
 * "Otvoriť" a file of a private folder the shopper opened with an access key: its page
 * pictures as signed addresses (10 minutes, this session only) of the watermarked pages.
 * Never the original file. ?again=1 renews the addresses without counting another opening.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, ctx: RouteContext<"/api/shops/[slug]/folder/view/[kind]/[id]">) {
  const { slug, kind, id } = await ctx.params;
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
  if ((kind !== "document" && kind !== "picture") || !UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404, headers });
  const limited = await rateLimit(request, `shop-folder:${slug}`);
  if (limited) return limited;
  const query = new URL(request.url).searchParams;
  const lang = query.get("lang") ?? "";
  const manifest = await viewManifest(slug, kind, id, isLocale(lang) ? lang : "sk", query.get("again") !== "1").catch(() => null);
  if (!manifest) return Response.json({ error: "not_found" }, { status: 404, headers });
  return Response.json(manifest, { headers });
}
