"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession, requestOrigin } from "@/lib/auth";
import { localToUtc } from "@/lib/format";
import { functionFailure } from "@/lib/functionError";

/**
 * Môj obchod → Novinky / Blog (database update 37). Posts are written through the owner_blog_* functions with the
 * owner's own login (the database checks the shop); photos, deleting, Facebook (login, the Page, import, publishing)
 * go through the shop-blog Edge Function with the same login. The website never sees a Facebook token.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Facebook's own login page: nothing else is followed. */
const FACEBOOK_LOGIN = /^https:\/\/www\.facebook\.com\/v\d+\.\d+\/dialog\/oauth\?/;
/** The database's and the function's reasons → the texts in dict.owner_blog (error_<code>). */
const KNOWN = ["title", "body", "published", "no_facebook", "when", "imported_text", "choice", "draft", "photo_limit"];

type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

async function session(): Promise<Session | null> {
  return await getSession();
}

const code = (message: string | null | undefined) => {
  const m = String(message ?? "");
  return KNOWN.includes(m) ? m : `failed:${m.slice(0, 160)}`;
};

async function blogCall<T>(s: Session, body: Record<string, unknown>): Promise<{ data: T | null; error: string | null }> {
  const { data, error } = await s.supabase.functions.invoke<T>("shop-blog", { body });
  if (!error) return { data: data ?? null, error: null };
  const failure = await functionFailure(error);
  if (failure.platform) console.error(`shop-blog: Supabase refused the call (${failure.detail})`);
  return { data: null, error: failure.error ?? `failed:${failure.detail.slice(0, 160)}` };
}

// ---------------------------------------------------------------- the editor (called from BlogEditor)

/** "Uložiť koncept" / "Uložiť zmeny" (and before publishing): the title and text as written. */
export async function saveBlogPost(input: { shopId: string; postId: string | null; title: string; body: string }): Promise<{
  id?: string;
  slug?: string;
  error?: string;
}> {
  const s = await session();
  if (!s) return { error: "login" };
  if (!UUID.test(input.shopId) || (input.postId !== null && !UUID.test(input.postId))) return { error: "failed:bad request" };
  const { data, error } = await s.supabase.rpc("owner_blog_save", {
    p_shop_id: input.shopId,
    p_post_id: input.postId,
    p_title: String(input.title ?? "").slice(0, 400),
    p_body: String(input.body ?? "").slice(0, 70_001),
  });
  if (error) return { error: code(error.message) };
  // The address the post has now (a draft's follows its title): the Facebook preview's last line.
  const { data: row } = await s.supabase.from("blog_posts").select("slug").eq("id", String(data)).maybeSingle();
  return { id: String(data), slug: (row as { slug?: string } | null)?.slug };
}

/**
 * The publish dialog's answer: live now (at null) or at a time typed in the shop's time zone, "Web + Facebook" or
 * "Len web". The database decides; "facebook_now": the Facebook copy goes right away (postToFacebook).
 */
export async function publishBlogPost(input: { postId: string; at: string | null; timeZone: string; choice: "web" | "web_fb" }): Promise<{
  publishAt?: string;
  scheduled?: boolean;
  facebookNow?: boolean;
  error?: string;
}> {
  const s = await session();
  if (!s) return { error: "login" };
  if (!UUID.test(input.postId)) return { error: "failed:bad request" };
  let at: string | null = null;
  if (input.at) {
    const when = localToUtc(input.at, input.timeZone);
    if (!when) return { error: "when" };
    if (when.getTime() > Date.now() + 60_000) at = when.toISOString();
  }
  const { data, error } = await s.supabase.rpc("owner_blog_publish", { p_post_id: input.postId, p_publish_at: at, p_fb_choice: input.choice });
  if (error) return { error: code(error.message) };
  const r = data as { publish_at: string; scheduled: boolean; facebook_now: boolean };
  return { publishAt: r.publish_at, scheduled: r.scheduled, facebookNow: r.facebook_now };
}

/** The Facebook copy now ("Áno…" for a post live now) or again ("Skúsiť znova na Facebook"). */
export async function postToFacebook(input: { postId: string; retry: boolean }): Promise<{ ok: boolean; permalink?: string | null; error?: string }> {
  const s = await session();
  if (!s) return { ok: false, error: "login" };
  if (!UUID.test(input.postId)) return { ok: false, error: "failed:bad request" };
  const { data, error } = await blogCall<{ ok: boolean; permalink?: string | null; error?: string }>(s, {
    action: "publish_fb",
    post_id: input.postId,
    retry: input.retry,
  });
  if (error) return { ok: false, error };
  return data ?? { ok: false, error: "failed:no answer" };
}

/** A scheduled post's "Web + Facebook" / "Len web" (until its time). */
export async function setBlogChoice(input: { postId: string; choice: "web" | "web_fb" }): Promise<{ error?: string }> {
  const s = await session();
  if (!s) return { error: "login" };
  const { error } = await s.supabase.rpc("owner_blog_set_choice", { p_post_id: input.postId, p_fb_choice: input.choice });
  return error ? { error: code(error.message) } : {};
}

/** The photos' new order. */
export async function setBlogPhotoOrder(input: { postId: string; ids: string[] }): Promise<{ error?: string }> {
  const s = await session();
  if (!s) return { error: "login" };
  const ids = input.ids.filter((id) => UUID.test(id)).slice(0, 100);
  const { error } = await s.supabase.rpc("owner_blog_photo_order", { p_post_id: input.postId, p_ids: ids });
  return error ? { error: code(error.message) } : {};
}

/**
 * "Pripojiť Facebook stránku" (also from the publish dialog): Facebook's login page; afterwards the owner comes back
 * to `returnPath` (Novinky / Blog or the editor) and picks the Page there.
 */
export async function facebookLoginUrl(input: { shopId: string; returnPath: string }): Promise<{ url?: string; error?: string }> {
  const s = await session();
  if (!s) return { error: "login" };
  if (!/^\/[a-z]{2}\/dashboard\/blog(\/[A-Za-z0-9-]+)?(\?[^#\s]*)?$/.test(input.returnPath)) return { error: "failed:bad request" };
  const { data, error } = await blogCall<{ url?: string }>(s, {
    action: "connect",
    shop_id: input.shopId,
    return_url: `${await requestOrigin()}${input.returnPath}`,
  });
  const url = typeof data?.url === "string" && FACEBOOK_LOGIN.test(data.url) ? data.url : null;
  return url ? { url } : { error: error ?? "fb_failed" };
}

/** The Pages the owner may pick after logging in (names and pictures only). */
export async function facebookPages(input: { pendingId: string }): Promise<{ pages?: { id: string; name: string; picture: string | null }[]; error?: string }> {
  const s = await session();
  if (!s) return { error: "login" };
  if (!UUID.test(input.pendingId)) return { error: "fb_pick_expired" };
  const { data, error } = await blogCall<{ pages: { id: string; name: string; picture: string | null }[] }>(s, { action: "pages", pending_id: input.pendingId });
  return error ? { error: error === "expired" ? "fb_pick_expired" : error } : { pages: data?.pages ?? [] };
}

export async function pickFacebookPage(input: { pendingId: string; pageId: string }): Promise<{ pageName?: string; error?: string }> {
  const s = await session();
  if (!s) return { error: "login" };
  const { data, error } = await blogCall<{ page_name: string }>(s, { action: "pick", pending_id: input.pendingId, page_id: input.pageId });
  return error ? { error: error === "expired" ? "fb_pick_expired" : error } : { pageName: data?.page_name };
}

/** How the import goes (the panel asks every few seconds while it runs). */
export async function facebookImportState(input: { shopId: string }): Promise<{ state: string; count: number; error: string | null } | null> {
  const s = await session();
  if (!s) return null;
  const { data } = await s.supabase
    .from("facebook_connections")
    .select("import_state, import_count, import_error")
    .eq("shop_id", input.shopId)
    .maybeSingle();
  const r = data as { import_state: string; import_count: number; import_error: string | null } | null;
  return r ? { state: r.import_state, count: r.import_count, error: r.import_error } : null;
}

// ---------------------------------------------------------------- forms (the list and the Facebook panel)

async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const s = await getSession();
  if (!s) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const at = String(formData.get("at") ?? "posts") === "facebook" ? "facebook" : "posts";
  const back = (query: Record<string, string>): never =>
    redirect(`/${lang}/dashboard/blog?${new URLSearchParams({ shop: slug, at, ...query })}#${at}`);
  return { lang, s: s!, shopId, slug, back };
}

const postId = (formData: FormData) => {
  const id = String(formData.get("post_id") ?? "");
  return UUID.test(id) ? id : null;
};

/** "Skryť" / "Zobraziť" / "Zverejniť" (an imported post waiting for approval). */
export async function setBlogPostHidden(formData: FormData) {
  const { s, back } = await start(formData);
  const id = postId(formData);
  if (!id) back({ err: "blog_failed:bad request" });
  const hidden = formData.get("hidden") === "1";
  const { error } = await s.supabase.rpc("owner_blog_set_hidden", { p_post_id: id, p_hidden: hidden });
  if (error) back({ err: `blog_${code(error.message)}` });
  back({ ok: hidden ? "blog_hidden" : formData.get("approve") === "1" ? "blog_approved" : "blog_shown" });
}

/** "Vymazať": the photos' files first, then the post (on Facebook it stays). */
export async function deleteBlogPost(formData: FormData) {
  const { s, back } = await start(formData);
  const id = postId(formData);
  if (!id) back({ err: "blog_failed:bad request" });
  const { error } = await blogCall(s, { action: "post_delete", post_id: id });
  if (error) back({ err: `blog_${code(error)}` });
  back({ ok: "blog_deleted" });
}

/** "Publikovať importované príspevky automaticky" / "Schvaľovať pred zverejnením". */
export async function saveBlogSettings(formData: FormData) {
  const { s, shopId, back } = await start(formData);
  const { error } = await s.supabase.rpc("owner_blog_settings", { p_shop_id: shopId, p_auto_publish: formData.get("auto_publish") !== "0" });
  if (error) back({ err: `blog_${code(error.message)}` });
  back({ ok: "fb_settings_saved" });
}

export async function connectFacebook(formData: FormData) {
  const { lang, slug, shopId, back } = await start(formData);
  const r = await facebookLoginUrl({ shopId, returnPath: `/${lang}/dashboard/blog?${new URLSearchParams({ shop: slug, at: "facebook" })}` });
  if (!r.url) back({ err: r.error === "not_configured" ? "fb_not_configured" : (r.error ?? "fb_failed") });
  redirect(r.url!);
}

export async function disconnectFacebook(formData: FormData) {
  const { s, shopId, back } = await start(formData);
  const { error } = await blogCall(s, { action: "disconnect", shop_id: shopId });
  if (error) back({ err: `blog_${code(error)}` });
  back({ ok: "fb_disconnected" });
}

export async function importFacebook(formData: FormData) {
  const { s, shopId, back } = await start(formData);
  const { error } = await blogCall(s, { action: "import", shop_id: shopId });
  if (error) back({ err: error === "not_configured" ? "fb_not_configured" : `blog_${code(error)}` });
  back({ ok: "fb_import_started" });
}
