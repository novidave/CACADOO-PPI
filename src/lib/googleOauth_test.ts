// Unit tests (Deno) of Google OAuth through cacaduu.com (2026-11-02): only the two functions, Google's query kept.
// Run: npm run test:site
import { googleOauthTarget } from "./googleOauth.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

Deno.test("Google's answer is forwarded only to bookings and hours-sms, query unchanged", () => {
  const supa = "https://szhot.supabase.co";
  assertEquals(googleOauthTarget(supa, "hours-sms", "?state=s1&code=c1&scope=x"), "https://szhot.supabase.co/functions/v1/hours-sms/oauth?state=s1&code=c1&scope=x");
  assertEquals(googleOauthTarget(`${supa}/rest/v1/`, "bookings", "?error=access_denied&state=s"), "https://szhot.supabase.co/functions/v1/bookings/oauth?error=access_denied&state=s");
  assertEquals(googleOauthTarget(supa, "bookings", ""), "https://szhot.supabase.co/functions/v1/bookings/oauth");
  assertEquals(googleOauthTarget(supa, "telegram", "?code=c"), null);
  assertEquals(googleOauthTarget(supa, "../hours-sms", "?code=c"), null);
  assertEquals(googleOauthTarget("http://szhot.supabase.co", "bookings", ""), null);
  assertEquals(googleOauthTarget("not a url", "bookings", ""), null);
});
