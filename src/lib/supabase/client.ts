"use client";

import { createBrowserClient } from "@supabase/ssr";
import { supabaseEnv } from "./env";

/** Supabase client for the browser (login and dashboard only, never public data). */
export function createClient() {
  const env = supabaseEnv();
  if (!env) throw new Error("Supabase environment variables are not set (see SETUP.md)");
  return createBrowserClient(env.url, env.key);
}
