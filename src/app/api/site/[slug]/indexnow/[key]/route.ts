import { createPublicClient } from "@/lib/supabase/public";

/**
 * The IndexNow key file of a shop's own domain ("https://<domain>/<key>.txt", src/proxy.ts sends
 * it here): the key itself, which proves to the search engines that our pings for the domain are
 * real. Only the one key (indexnow_key()) and only while the domain is live. Update 33.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/site/[slug]/indexnow/[key]">) {
  const { slug, key } = await ctx.params;
  const supabase = createPublicClient();
  if (!supabase) return new Response("Not found", { status: 404 });
  const [{ data: host }, { data: real }] = await Promise.all([supabase.rpc("shop_site", { p_slug: slug }), supabase.rpc("indexnow_key")]);
  if (typeof host !== "string" || !host || typeof real !== "string" || !real || key !== real) return new Response("Not found", { status: 404 });
  return new Response(real, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
}
