import { supabaseEnv } from "@/lib/supabase/env";
import { googleOauthTarget } from "@/lib/googleOauth";

/**
 * GET /api/google/<bookings|hours-sms>/oauth — Google's answer after "Pripojiť Google" (Calendar for Rezervácie,
 * Business Profile for Hodiny cez SMS). Google only returns to an address on a domain we own (cacaduu.com), so the
 * functions name this address as their redirect_uri and it forwards the answer, query as it is, to the function's
 * own /oauth. Nothing is read, kept or logged here: the function checks the state (single use, 10 minutes, hash
 * only) and exchanges the code with the same redirect_uri.
 */
export async function GET(request: Request, ctx: { params: Promise<{ fn: string }> }) {
  const { fn } = await ctx.params;
  const env = supabaseEnv();
  const target = env ? googleOauthTarget(env.url, fn, new URL(request.url).search) : null;
  if (!target) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(null, {
    status: 302,
    headers: { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
