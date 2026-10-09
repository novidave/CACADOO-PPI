import { rateLimit } from "@/lib/apiHttp";
import { fileUrl } from "@/lib/docsAccess";

/**
 * A picture or PDF of the shop, shown or linked by the shop's assistant: redirects to a
 * 10-minute signed address from the shop-files function, which asks the database
 * whether this shopper may open it (Public folder, or a private folder the shopper's
 * access-key session opens; "Assistant may show it" / "Shoppers may download it").
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, ctx: RouteContext<"/api/shops/[slug]/files/[kind]/[id]">) {
  const { slug, kind, id } = await ctx.params;
  if ((kind !== "picture" && kind !== "document") || !UUID.test(id)) return new Response("Not found", { status: 404 });
  const limited = await rateLimit(request, `shop-files:${slug}`);
  if (limited) return limited;
  const url = await fileUrl(slug, kind, id).catch(() => null);
  if (!url) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "private, max-age=300",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}
