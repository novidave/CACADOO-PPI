/**
 * Public Supabase settings. Only the URL and the anon/publishable key belong
 * in the web app. The service role key must NEVER appear here or in Vercel.
 *
 * Accepts the names used by SETUP.md and by the Vercel–Supabase integration.
 * In the browser only NEXT_PUBLIC_* variables exist (copied in at build time).
 */
export function supabaseEnv(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return { url: projectOrigin(url), key: key.trim() };
}

/**
 * Keep only "https://xxxx.supabase.co". A pasted ".../rest/v1/" or a trailing
 * slash makes Supabase answer "Invalid path specified in request URL".
 */
function projectOrigin(url: string): string {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return url.trim(); // let the Supabase client report the invalid URL
  }
}

/** Names of the missing settings, to show on screen while setting up. */
export function missingSupabaseEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL && !process.env.SUPABASE_URL) {
    missing.push("NEXT_PUBLIC_SUPABASE_URL");
  }
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY &&
    !process.env.SUPABASE_ANON_KEY &&
    !process.env.SUPABASE_PUBLISHABLE_KEY
  ) {
    missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  return missing;
}
