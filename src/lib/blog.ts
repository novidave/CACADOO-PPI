import "server-only";
import { cache } from "react";
import { BLOG_PER_PAGE, blogPhotoUrl, type BlogPage, type BlogPost } from "./blogFormat";
import { supabaseEnv } from "./supabase/env";
import { createClient } from "./supabase/server";

/**
 * The shop's blog for its pages (database update 37): only what the database shows (blog_visible_posts: published,
 * its time has come, within the plan's number). Before update 37 every shop simply has no posts.
 */

export const getBlogPage = cache(async (slug: string, page: number): Promise<BlogPage | null> => {
  const supabase = await createClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("shop_blog", { p_slug: slug, p_page: page, p_per_page: BLOG_PER_PAGE });
  return error || !data ? null : (data as BlogPage);
});

export const getBlogPost = cache(async (slug: string, postSlug: string): Promise<BlogPost | null> => {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(postSlug) || postSlug.length > 80) return null;
  const supabase = await createClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("shop_blog_post", { p_slug: slug, p_post_slug: postSlug });
  return error || !data ? null : (data as BlogPost);
});

/** How many posts the shop shows ("Novinky" only with one or more); 0 before update 37 or on any error. */
export async function blogCount(slug: string): Promise<number> {
  const supabase = await createClient();
  if (!supabase) return 0;
  const { data, error } = await supabase.rpc("shop_blog_count", { p_slug: slug });
  return error ? 0 : Number(data ?? 0);
}

/** A photo's public address (bucket "blog-photos"). */
export function photoSrc(path: string): string {
  return blogPhotoUrl(supabaseEnv()?.url ?? "", path);
}

let facebook: { at: number; on: boolean } | null = null;

/**
 * Whether Facebook is set up (the shop-blog function has FACEBOOK_APP_ID, FACEBOOK_APP_SECRET and
 * FB_TOKEN_ENCRYPTION_KEY): without it Môj obchod shows no Facebook button at all. Asked once a minute; any problem
 * (function not deployed yet, network) → false.
 */
export async function facebookEnabled(): Promise<boolean> {
  if (facebook && Date.now() - facebook.at < 60_000) return facebook.on;
  const env = supabaseEnv();
  let on = false;
  if (env) {
    const res = await fetch(`${env.url}/functions/v1/shop-blog`, {
      method: "POST",
      headers: { apikey: env.key, Authorization: `Bearer ${env.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "config" }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    const data = res?.ok ? ((await res.json().catch(() => null)) as { facebook?: boolean } | null) : null;
    on = data?.facebook === true;
  }
  facebook = { at: Date.now(), on };
  return on;
}
