import { indexNowKey, keyFileResponse } from "@/lib/indexnow";
import { createPublicClient } from "@/lib/supabase/public";

/**
 * The IndexNow key file of a shop's own domain ("https://<domain>/<key>.txt", src/proxy.ts sends
 * it here): the one key of every host (INDEXNOW_KEY, update 36), only while the domain is live.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/site/[slug]/indexnow/[key]">) {
  const { slug, key } = await ctx.params;
  const supabase = createPublicClient();
  if (!supabase) return keyFileResponse(key, null);
  const { data: host } = await supabase.rpc("shop_site", { p_slug: slug });
  return keyFileResponse(key, typeof host === "string" && host ? indexNowKey() : null);
}
