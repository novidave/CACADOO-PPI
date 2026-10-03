import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { safeNextPath } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const OTP_TYPES: EmailOtpType[] = ["email", "magiclink", "invite", "signup", "recovery", "email_change"];

/**
 * Where login and invite e-mails land.
 *  - ?token_hash=…&type=…  (recommended e-mail templates, see SETUP.md) — works on any device
 *  - ?code=…               (Supabase default login template) — works in the browser that asked for the link
 *  - #access_token=…        (Supabase default invite template) — only the browser can read the part
 *    after "#", so we hand over to /[lang]/login/finish, which keeps it (browsers carry
 *    the "#…" part across redirects)
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const next = safeNextPath(url.searchParams.get("next"));
  const fail = (reason: string) => NextResponse.redirect(new URL(`/login?error=${reason}`, url.origin));

  const supabase = await createClient();
  if (!supabase) return fail("config");

  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const code = url.searchParams.get("code");

  if (tokenHash && type && OTP_TYPES.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) return fail("link");
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return fail("link");
  } else if (url.searchParams.get("error")) {
    return fail("link");
  } else {
    const fromNext = next.split("/")[1];
    const saved = request.cookies.get(LOCALE_COOKIE)?.value;
    const lang = isLocale(fromNext) ? fromNext : isLocale(saved) ? saved : "en";
    return NextResponse.redirect(new URL(`/${lang}/login/finish?next=${encodeURIComponent(next)}`, url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
