import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseEnv } from "./env";

/**
 * Supabase client for server components, route handlers and server actions.
 * Public pages load their data here so the first HTML already contains it.
 * Returns null when the Supabase environment variables are not set yet.
 */
export async function createClient() {
  // Read cookies first: this marks every page that uses Supabase as rendered
  // per request, even when the settings are missing at build time. Private
  // pages must never be pre-built (they would freeze as "redirect to login").
  const cookieStore = await cookies();
  const env = supabaseEnv();
  if (!env) return null;

  return createServerClient(env.url, env.key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a server component: cookies are refreshed in src/proxy.ts instead.
        }
      },
    },
  });
}
