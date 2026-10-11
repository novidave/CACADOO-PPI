import { createPublicClient } from "@/lib/supabase/public";

/**
 * robots.txt of a shop's own domain (src/proxy.ts sends "/robots.txt" of that domain here):
 * everyone may read the shop's pages; the assistant (paid per question) is kept out.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/site/[slug]/robots">) {
  const { slug } = await ctx.params;
  const supabase = createPublicClient();
  const { data: host } = supabase ? await supabase.rpc("shop_site", { p_slug: slug }) : { data: null };
  if (typeof host !== "string" || !host) return new Response("Not found", { status: 404 });
  const body = ["User-agent: *", "Allow: /", "Disallow: /api/", "", `Sitemap: https://${host}/sitemap.xml`, ""].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
