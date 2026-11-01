import { rateLimit } from "@/lib/apiHttp";
import { icsCalendar, type FeedRow } from "@/lib/icsFeed";
import { createPublicClient } from "@/lib/supabase/public";

/**
 * GET /api/calendar/<token> (update 63): the shop's bookings for the calendar on the owner's phone, read only. The token
 * is the secret ("Odkaz pre kalendár v telefóne", only its hash is stored); calendar_feed() decides everything (the
 * token, the plan, confirmed bookings, first names only). A wrong or switched-off token gets an empty calendar, so a
 * subscribed phone simply shows nothing; the token is never logged.
 */
export async function GET(request: Request, { params }: RouteContext<"/api/calendar/[token]">) {
  const limited = await rateLimit(request, "/api/calendar", 30);
  if (limited) return limited;
  const { token } = await params;
  const clean = /^cal_[0-9a-f]{40,96}$/.test(token) ? token : null;
  const client = createPublicClient();
  if (!client) return new Response("unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  const { data, error } = clean ? await client.rpc("calendar_feed", { p_token: clean }) : { data: [], error: null };
  if (error) return new Response("unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  return new Response(icsCalendar((data ?? []) as FeedRow[], "Cacaduu"), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="rezervacie.ics"',
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}
