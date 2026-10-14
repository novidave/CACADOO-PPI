import { siteRobotsTxt } from "@/lib/siteFiles";
import { createPublicClient } from "@/lib/supabase/public";

/**
 * robots.txt of a shop's own domain (src/proxy.ts sends "/robots.txt" of that domain here):
 * search engines and AI crawlers may read the shop's public pages; never the owner's pages,
 * private folders, access keys or the assistant (paid per question). Update 33.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/site/[slug]/robots">) {
  const { slug } = await ctx.params;
  const supabase = createPublicClient();
  const { data: host } = supabase ? await supabase.rpc("shop_site", { p_slug: slug }) : { data: null };
  if (typeof host !== "string" || !host) return new Response("Not found", { status: 404 });
  return new Response(siteRobotsTxt(host), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
