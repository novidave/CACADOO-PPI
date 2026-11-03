/**
 * Google OAuth through cacaduu.com (2026-11-02): Google's consent screen may only return to a domain the app owns,
 * so the bookings and hours-sms functions use `<SITE_URL>/api/google/<function>/oauth` as their redirect_uri and
 * that route forwards Google's answer to `<project>.supabase.co/functions/v1/<function>/oauth`.
 * Only these two functions; anything else is refused.
 */
export const GOOGLE_OAUTH_FUNCTIONS = ["bookings", "hours-sms"] as const;

/** The function's own /oauth address with Google's query (code, state, scope, error …) unchanged; null = refuse. */
export function googleOauthTarget(supabaseUrl: string, fn: string, search: string): string | null {
  if (!(GOOGLE_OAUTH_FUNCTIONS as readonly string[]).includes(fn)) return null;
  let origin: string;
  try {
    const u = new URL(supabaseUrl);
    if (u.protocol !== "https:") return null;
    origin = u.origin;
  } catch {
    return null;
  }
  const query = search.startsWith("?") ? search : search ? `?${search}` : "";
  return `${origin}/functions/v1/${fn}/oauth${query.slice(0, 4000)}`;
}
