"use server";

import { redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { requestOrigin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sends a magic link. Never creates accounts: shops are invited by the admin. */
export async function sendLoginLink(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang = isLocale(langValue) ? langValue : "en";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) redirect(`/${lang}/login?error=email`);

  const supabase = await createClient();
  if (!supabase) redirect(`/${lang}/login?error=config`);

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${await requestOrigin()}/auth/confirm?next=/${lang}/dashboard`,
    },
  });
  // Unknown e-mails get the same answer as known ones, so the form cannot be
  // used to find out who has an account. Only rate limits are reported.
  if (error && (error.status === 429 || /rate limit/i.test(error.message))) redirect(`/${lang}/login?error=rate`);
  redirect(`/${lang}/login?sent=1`);
}
