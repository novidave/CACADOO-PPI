import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseEnv } from "./env";

/**
 * Read-only Supabase client for the public API, MCP server, sitemap and
 * llms.txt: anon key, no login, no cookies. Visitors' rules (RLS) apply.
 */
export function createPublicClient() {
  const env = supabaseEnv();
  if (!env) return null;
  return createClient(env.url, env.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
