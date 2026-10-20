import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { facebookEnabled, photoSrc } from "@/lib/blog";
import { blogPath } from "@/lib/blogFormat";
import { formatDateTime } from "@/lib/format";
import { requestTime } from "@/lib/requestTime";
import type { MyShop } from "@/lib/myShops";
import { ConfirmButton } from "@/components/ConfirmButton";
import { DashboardSection } from "@/components/DashboardSection";
import { DbError } from "@/components/DbError";
import { FacebookImportProgress } from "@/components/FacebookImportProgress";
import { FacebookPagePicker } from "@/components/FacebookPagePicker";
import { hiddenFields, ShopSwitcher, SubmitButton } from "../shared";
import { connectFacebook, deleteBlogPost, disconnectFacebook, importFacebook, saveBlogSettings, setBlogPostHidden } from "./actions";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/blog">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).owner_blog.title };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface ListPost {
  id: string;
  slug: string;
  title: string;
  source: "cacaduu" | "facebook";
  status: "draft" | "published" | "hidden" | "pending";
  publish_at: string | null;
  created_at: string;
  fb_choice: "web" | "web_fb" | null;
  fb_status: "waiting" | "posting" | "posted" | "failed" | null;
  fb_error: string | null;
  fb_permalink: string | null;
  fb_deleted_at: string | null;
  visible: boolean;
  photos: number;
  photos_waiting: number;
  photo: string | null;
}

export interface FacebookRow {
  page_id: string;
  page_name: string;
  page_picture: string | null;
  status: "ok" | "expired";
  last_error: string | null;
  connected_at: string;
  import_state: "idle" | "running" | "done" | "failed";
  import_count: number;
  import_error: string | null;
  last_sync_at: string | null;
  next_sync_at: string | null;
}

/** The message after a form (?ok= / ?err=), in its section. */
function notice(dict: Dictionary, sp: Record<string, string | string[] | undefined>, section: string) {
  const b = dict.owner_blog;
  const ok = first(sp.ok);
  const err = first(sp.err);
  if ((first(sp.at) ?? "posts") !== section || (!ok && !err)) return null;
  const okTexts: Record<string, string> = {
    blog_hidden: b.saved,
    blog_shown: b.saved,
    blog_approved: b.done_web,
    blog_deleted: b.saved,
    fb_settings_saved: b.fb_settings_saved,
    fb_disconnected: b.fb_disconnected,
    fb_import_started: b.fb_import_started,
    fb_connected: b.fb_connected_ok,
  };
  let text = ok ? (okTexts[ok] ?? b.saved) : "";
  if (err) {
    const code = err.replace(/^blog_/, "");
    text = code.startsWith("failed:")
      ? t(b.error_failed, { message: code.slice(7) })
      : ((b as Record<string, string>)[`error_${code}`] ?? t(b.error_failed, { message: code }));
  }
  return (
    <p role="status" className={ok ? "border border-foreground p-3 font-medium" : "border border-line p-3"}>
      {text}
    </p>
  );
}

/**
 * Môj obchod → "Novinky / Blog" (database update 37): the shop's articles (written here or imported from its Facebook
 * Page) with their state, and the Facebook Page (connect, pick the Page, download all posts, approve imports or not,
 * disconnect). Without Facebook set up on Cacaduu there is no Facebook part at all.
 */
export default async function BlogDashboardPage({ params, searchParams }: PageProps<"/[lang]/dashboard/blog">) {
  const { lang: langValue } = await params;
  if (!isLocale(langValue)) notFound();
  const lang: Locale = langValue;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const sp = await searchParams;
  const b = dict.owner_blog;

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];

  const [list, connection, settings, fbOn, host] = await Promise.all([
    supabase.rpc("owner_blog_posts", { p_shop_id: shop.id }),
    supabase
      .from("facebook_connections")
      .select("page_id, page_name, page_picture, status, last_error, connected_at, import_state, import_count, import_error, last_sync_at, next_sync_at")
      .eq("shop_id", shop.id)
      .maybeSingle(),
    supabase.from("shop_blog_settings").select("auto_publish").eq("shop_id", shop.id).maybeSingle(),
    facebookEnabled(),
    supabase.rpc("shop_site", { p_slug: shop.slug }),
  ]);
  const hidden = hiddenFields(lang, shop);
  const header = (
    <header className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{b.title}</h1>
      <ShopSwitcher shops={shops} current={shop} label={dict.dashboard.shop} href={(slug) => `/${lang}/dashboard/blog?${new URLSearchParams({ shop: slug })}`} />
      <p className="text-muted">{shop.name}</p>
      <p className="text-sm">{b.intro}</p>
    </header>
  );
  if (list.error) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        {header}
        <p className="border border-line p-3 text-sm">{b.unavailable}</p>
      </div>
    );
  }
  const data = list.data as { limit: number | null; posts: ListPost[] };
  const fb = (connection.data as FacebookRow | null) ?? null;
  const auto = (settings.data as { auto_publish?: boolean } | null)?.auto_publish !== false;
  const place = { shopSlug: shop.slug, country: shop.country, host: typeof host.data === "string" && host.data ? host.data : null };
  const view = (slug: string) => (place.host ? `https://${place.host}${blogPath(lang, place, true, slug)}` : blogPath(lang, place, false, slug));
  const when = (iso: string) => formatDateTime(iso, lang, shop.timezone);
  const pick = first(sp.fb_pick);
  const now = requestTime();
  const editHref = (id: string) => `/${lang}/dashboard/blog/${id}?${new URLSearchParams({ shop: shop.slug })}`;

  const status = (p: ListPost) => {
    if (p.status === "published" && p.publish_at && Date.parse(p.publish_at) > now) return b.status_scheduled;
    return { published: b.status_published, hidden: b.status_hidden, draft: b.status_draft, pending: b.status_pending }[p.status];
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {header}
      <p>
        <Link href={`/${lang}/dashboard/blog/new?${new URLSearchParams({ shop: shop.slug })}`} className="inline-block rounded border border-foreground bg-foreground px-4 py-2 font-medium text-white" data-new-post>
          {b.new_post}
        </Link>
      </p>
      {fbOn && pick && (
        <FacebookPagePicker
          pendingId={pick}
          doneUrl={`/${lang}/dashboard/blog?${new URLSearchParams({ shop: shop.slug, at: "facebook", ok: "fb_connected" })}#facebook`}
          labels={{ ...b, saving: b.saving }}
        />
      )}

      <div className="flex flex-col border-t border-line">
        {fbOn && (
          <DashboardSection
            id="facebook"
            first
            forceOpen={first(sp.at) === "facebook" || Boolean(pick) || fb?.status === "expired"}
            title={b.fb_title}
            summary={!fb ? b.fb_summary_off : fb.status === "expired" ? b.fb_summary_expired : t(b.fb_summary_on, { name: fb.page_name })}
          >
            {notice(dict, sp, "facebook")}
            <p className="text-sm">{b.fb_intro}</p>
            {!fb ? (
              <form action={connectFacebook} className="flex flex-col gap-2" data-facebook-connect>
                {hidden({ at: "facebook" })}
                <SubmitButton pending={b.saving}>{b.fb_connect}</SubmitButton>
                <span className="text-sm text-muted">{b.fb_profiles}</span>
              </form>
            ) : (
              <div className="flex flex-col gap-4" data-facebook-connected={fb.status}>
                <div className="flex items-center gap-3">
                  {fb.page_picture ? (
                    // eslint-disable-next-line @next/next/no-img-element -- the Page's picture from Facebook, in Môj obchod only
                    <img src={fb.page_picture} alt="" width={40} height={40} className="h-10 w-10 rounded-full border border-line object-cover" />
                  ) : null}
                  <p className="font-medium">{t(b.fb_connected, { name: fb.page_name })}</p>
                </div>
                {fb.status === "expired" && (
                  <form action={connectFacebook} className="flex flex-col gap-2 border border-foreground p-3" data-facebook-expired>
                    {hidden({ at: "facebook" })}
                    <p className="font-medium">{b.fb_expired}</p>
                    <SubmitButton pending={b.saving}>{b.dialog_reconnect}</SubmitButton>
                  </form>
                )}
                <p className="text-sm text-muted">
                  {t(b.fb_last_sync, { date: fb.last_sync_at ? when(fb.last_sync_at) : dict.account.never })}
                  {fb.next_sync_at && fb.status === "ok" ? ` · ${t(b.fb_next_sync, { date: when(fb.next_sync_at) })}` : ""}
                </p>
                <FacebookImportProgress
                  shopId={shop.id}
                  initial={{ state: fb.import_state, count: fb.import_count, error: fb.import_error }}
                  labels={{ fb_import_running: b.fb_import_running, fb_import_done: b.fb_import_done, fb_import_failed: b.fb_import_failed }}
                />
                {fb.status === "ok" && fb.import_state !== "running" && (
                  <form action={importFacebook}>
                    {hidden({ at: "facebook" })}
                    <SubmitButton pending={b.saving}>{b.fb_import}</SubmitButton>
                  </form>
                )}
                <form action={saveBlogSettings} className="flex flex-col gap-2" data-facebook-settings>
                  {hidden({ at: "facebook" })}
                  <label className="flex items-center gap-2">
                    <input type="radio" name="auto_publish" value="1" defaultChecked={auto} /> {b.fb_auto}
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="auto_publish" value="0" defaultChecked={!auto} /> {b.fb_approve}
                  </label>
                  <SubmitButton pending={b.saving}>{b.fb_settings_save}</SubmitButton>
                </form>
                <form action={disconnectFacebook}>
                  {hidden({ at: "facebook" })}
                  <ConfirmButton question={b.fb_disconnect_confirm} className="rounded border border-foreground px-4 py-2 font-medium">
                    {b.fb_disconnect}
                  </ConfirmButton>
                </form>
              </div>
            )}
            <p className="flex flex-wrap gap-x-4 text-sm">
              <Link href={`/${lang}/sukromie#facebook`} className="underline underline-offset-4">
                {b.fb_privacy}
              </Link>
              <Link href={`/${lang}/sukromie/vymazanie-udajov`} className="underline underline-offset-4">
                {b.fb_deletion}
              </Link>
            </p>
          </DashboardSection>
        )}

        <DashboardSection id="posts" first={!fbOn} forceOpen={(first(sp.at) ?? "posts") === "posts"} title={b.posts_title} summary={t(b.posts_summary, { n: data.posts.length })}>
          {notice(dict, sp, "posts")}
          {data.limit !== null && <p className="text-sm">{t(b.limit_free, { n: data.limit })}</p>}
          {data.posts.length === 0 ? (
            <p className="text-sm text-muted">{b.no_posts}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line border-y border-line" data-blog-posts>
              {data.posts.map((p) => {
                const scheduled = p.status === "published" && p.publish_at && Date.parse(p.publish_at) > now;
                return (
                  <li key={p.id} className="flex gap-3 py-3" data-post={p.slug} data-status={scheduled ? "scheduled" : p.status}>
                    {p.photo ? (
                      // eslint-disable-next-line @next/next/no-img-element -- the post's first photo (800 px)
                      <img src={photoSrc(p.photo)} alt="" className="h-16 w-16 shrink-0 border border-line object-cover" />
                    ) : (
                      <span className="h-16 w-16 shrink-0 border border-line" aria-hidden />
                    )}
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <Link href={editHref(p.id)} className="font-medium hover:underline">
                        {p.title}
                      </Link>
                      <p className="flex flex-wrap gap-x-2 text-sm">
                        <span className="font-semibold">{status(p)}</span>
                        <span className="text-muted">· {p.source === "facebook" ? b.source_facebook : b.source_cacaduu}</span>
                        {p.source === "cacaduu" && p.status !== "draft" && p.fb_choice && <span className="text-muted">· {p.fb_choice === "web_fb" ? b.choice_web_fb : b.choice_web}</span>}
                        {p.publish_at && <span className="text-muted">· {when(p.publish_at)}</span>}
                      </p>
                      <p className="flex flex-wrap gap-x-2 text-sm text-muted">
                        {p.status === "published" && !scheduled && !p.visible && data.limit !== null && <span>{t(b.not_shown_limit, { n: data.limit })}</span>}
                        {p.fb_deleted_at && <span>{b.deleted_on_facebook}</span>}
                        {p.fb_status === "posted" && (p.fb_permalink ? <a href={p.fb_permalink} target="_blank" rel="noopener" className="underline underline-offset-4">{b.fb_posted}</a> : <span>{b.fb_posted}</span>)}
                        {p.fb_status === "waiting" && scheduled && p.publish_at && <span>{t(b.fb_waiting, { date: when(p.publish_at) })}</span>}
                        {p.fb_status === "failed" && <span>{b.fb_failed}{p.fb_error ? `: ${p.fb_error}` : ""}</span>}
                        {p.photos > 0 && <span>{t(b.photos_count, { n: p.photos })}</span>}
                        {p.photos_waiting > 0 && <span>{t(b.photos_waiting, { n: p.photos_waiting })}</span>}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <Link href={editHref(p.id)} className="underline underline-offset-4">
                          {b.edit}
                        </Link>
                        {p.visible && (
                          <a href={view(p.slug)} target="_blank" rel="noopener" className="underline underline-offset-4">
                            {b.view}
                          </a>
                        )}
                        {p.status !== "draft" && (
                          <form action={setBlogPostHidden}>
                            {hidden({ at: "posts", post_id: p.id, hidden: p.status === "hidden" || p.status === "pending" ? "0" : "1", ...(p.status === "pending" ? { approve: "1" } : {}) })}
                            <button type="submit" className="underline underline-offset-4" data-toggle={p.status}>
                              {p.status === "pending" ? b.approve : p.status === "hidden" ? b.show : b.hide}
                            </button>
                          </form>
                        )}
                        {p.status === "pending" && (
                          <form action={setBlogPostHidden}>
                            {hidden({ at: "posts", post_id: p.id, hidden: "1" })}
                            <button type="submit" className="underline underline-offset-4">
                              {b.hide}
                            </button>
                          </form>
                        )}
                        <form action={deleteBlogPost}>
                          {hidden({ at: "posts", post_id: p.id })}
                          <ConfirmButton question={b.delete_confirm} className="underline underline-offset-4">
                            {b.delete}
                          </ConfirmButton>
                        </form>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </DashboardSection>
      </div>
    </div>
  );
}
