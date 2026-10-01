import { createServerClient } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";
import { supabaseEnv } from "./env";

/** Refreshes the login session cookie on each request (called from src/proxy.ts). */
export async function refreshSession(request: NextRequest, response: NextResponse) {
  const env = supabaseEnv();
  if (!env) return response;

  try {
    const supabase = createServerClient(env.url, env.key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });

    // Do not remove: this validates and refreshes the session token.
    await supabase.auth.getClaims();
  } catch (e) {
    // A broken Supabase setting must not take the whole site down; the page shows the error.
    console.error("Supabase session refresh failed:", e);
  }
  return response;
}
