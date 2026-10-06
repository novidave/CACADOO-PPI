"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { requestOrigin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72; // Supabase (bcrypt) limit

function read(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  return { lang, email, password };
}

const isRateLimit = (error: { status?: number; message: string }) => error.status === 429 || /rate limit/i.test(error.message);

/** E-mail + password login. */
export async function signIn(formData: FormData) {
  const { lang, email, password } = read(formData);
  const back = (error: string) => redirect(`/${lang}/login?error=${error}`);
  if (!EMAIL.test(email) || email.length > 254) back("email");
  const supabase = await createClient();
  if (!supabase) back("config");

  const { error } = await supabase!.auth.signInWithPassword({ email, password });
  if (error) {
    if (isRateLimit(error)) back("rate");
    if (error.code === "email_not_confirmed" || /not confirmed/i.test(error.message)) back("unconfirmed");
    back("credentials");
  }
  redirect(`/${lang}/dashboard`);
}

/** Self-service sign-up: anyone may create a shop account. Supabase e-mails a confirmation link. */
export async function signUp(formData: FormData) {
  const { lang, email, password } = read(formData);
  const back = (query: Record<string, string>) => redirect(`/${lang}/signup?${new URLSearchParams(query)}`);
  if (!EMAIL.test(email) || email.length > 254) back({ error: "email" });
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) back({ error: "password" });
  if (password !== String(formData.get("password_repeat") ?? "")) back({ error: "mismatch" });
  const supabase = await createClient();
  if (!supabase) back({ error: "config" });

  const { data, error } = await supabase!.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${await requestOrigin()}/auth/confirm?next=/${lang}/dashboard` },
  });
  if (error) {
    if (isRateLimit(error)) back({ error: "rate" });
    if (error.code === "weak_password") back({ error: "password" });
    back({ error: "failed", message: error.message.slice(0, 200) });
  }
  // E-mail confirmation switched off in Supabase: logged in straight away.
  if (data.session) redirect(`/${lang}/dashboard`);
  back({ sent: "1" });
}

/** "Forgot password": e-mails a link that logs in and opens the change-password page. */
export async function sendPasswordReset(formData: FormData) {
  const { lang, email } = read(formData);
  const back = (query: string) => redirect(`/${lang}/forgot?${query}`);
  if (!EMAIL.test(email) || email.length > 254) back("error=email");
  const supabase = await createClient();
  if (!supabase) back("error=config");

  const { error } = await supabase!.auth.resetPasswordForEmail(email, {
    redirectTo: `${await requestOrigin()}/auth/confirm?next=/${lang}/password`,
  });
  // Unknown e-mails get the same answer as known ones (nobody can probe for accounts).
  if (error && isRateLimit(error)) back("error=rate");
  back("sent=1");
}
