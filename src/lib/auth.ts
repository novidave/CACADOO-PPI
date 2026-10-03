import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Locale } from "@/i18n/config";
import { createClient } from "./supabase/server";
import { siteUrl } from "./site";

/**
 * The logged-in user, checked with Supabase Auth on every call (getUser), plus
 * whether they are the admin. Pages and server actions both call this: hiding a
 * button is never the security boundary — RLS and these checks are.
 */
export async function getSession() {
  const supabase = await createClient();
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin, language")
    .eq("user_id", user.id)
    .maybeSingle();
  return { supabase, user, isAdmin: Boolean(profile?.is_admin) };
}

export async function requireUser(lang: Locale) {
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  return session;
}

export async function requireAdmin(lang: Locale) {
  const session = await requireUser(lang);
  if (!session.isAdmin) redirect(`/${lang}/dashboard`);
  return session;
}

/** This deployment's own address (preview links included), for e-mail links. */
export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return siteUrl();
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Only same-site paths like "/sk/dashboard" — never "//evil.com" or "https://…". */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : fallback;
}
