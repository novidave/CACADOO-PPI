import { indexNowKey, keyFileResponse } from "@/lib/indexnow";

/**
 * The IndexNow key file of the main Cacadoo domain ("https://<domain>/<key>.txt"; src/proxy.ts
 * sends it here): proves to the search engines that stock-pull's pings for this host are real.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/indexnow/[key]">) {
  const { key } = await ctx.params;
  return keyFileResponse(key, indexNowKey());
}
