"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";

/** Sets a new password for the logged-in user (also the last step of "forgot password"). */
export async function changePassword(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const back = (query: Record<string, string>) => redirect(`/${lang}/password?${new URLSearchParams(query)}`);
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);

  const password = String(formData.get("password") ?? "");
  if (password.length < 8 || password.length > 72) back({ error: "password" });
  if (password !== String(formData.get("password_repeat") ?? "")) back({ error: "mismatch" });

  const { error } = await session.supabase.auth.updateUser({ password });
  if (error) {
    if (error.code === "weak_password") back({ error: "password" });
    back({ error: "failed", message: error.message.slice(0, 200) });
  }
  back({ ok: "1" });
}
