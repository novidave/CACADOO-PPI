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
import { ToggleSubmit } from "@/components/owner/ToggleSubmit";
import { timeWord } from "@/lib/crmInbox";
import { DbError } from "@/components/DbError";
import { FacebookImportProgress } from "@/components/FacebookImportProgress";
import { FacebookPagePicker } from "@/components/FacebookPagePicker";
import { hiddenFields, ShopSwitcher, SubmitButton } from "../shared";
import { connectFacebook, deleteBlogPost, disconnectFacebook, importFacebook, saveBlogSettings, setBlogPostHidden } from "./actions";
import { PageTitle } from "@/components/owner/PageHead";
import { buttonClass, cardClass, ghostClass } from "@/components/owner/ui";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/blog">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).owner_blog.title };
}

const BLOG_FILTERS = ["all", "published", "scheduled", "draft", "pending"] as const;
type BlogFilter = (typeof BLOG_FILTERS)[number];

const plural = (forms: Record<string, string>, prefix: string, n: number, lang: Locale) =>
  t(forms[`${prefix}_${new Intl.PluralRules(lang).select(n)}`] ?? forms[`${prefix}_other`], { n });

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
  edited_at?: string | null;
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
      <PageTitle>{b.title}</PageTitle>
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
  // "sync dnes 6:10"
  const syncWhen = (iso: string) => {
    const w = timeWord(iso, requestTime(), shop.timezone, lang);
    return w.kind === "time" ? t(b.pill_today, { time: w.text }) : w.kind === "yesterday" ? b.pill_yesterday : w.text;
  };
  const pick = first(sp.fb_pick);
  const now = requestTime();
  const editHref = (id: string) => `/${lang}/dashboard/blog/${id}?${new URLSearchParams({ shop: shop.slug })}`;

  // artboard 11: the filter chips (counted from the same list owner_blog_posts returns), the post rows, the Facebook card
  const isScheduled = (p: ListPost) => p.status === "published" && Boolean(p.publish_at) && Date.parse(p.publish_at!) > now;
  const kindOf = (p: ListPost): BlogFilter => (p.status === "pending" ? "pending" : p.status === "draft" ? "draft" : isScheduled(p) ? "scheduled" : p.status === "published" ? "published" : "all");
  const counts: Record<BlogFilter, number> = { all: data.posts.length, published: 0, scheduled: 0, draft: 0, pending: 0 };
  for (const p of data.posts) {
    const k = kindOf(p);
    if (k !== "all") counts[k] += 1;
  }
  const fValue = first(sp.f) ?? "all";
  const filter: BlogFilter = (BLOG_FILTERS as readonly string[]).includes(fValue) ? (fValue as BlogFilter) : "all";
  const posts = filter === "all" ? data.posts : data.posts.filter((p) => kindOf(p) === filter);
  const [pinned, videos] = await Promise.all([
    supabase.from("shop_content_slots").select("post_id").eq("shop_id", shop.id).eq("kind", "pinned_post"),
    data.posts.length
      ? supabase.from("blog_photos").select("post_id").eq("kind", "video").in("post_id", data.posts.map((p) => p.id).slice(0, 500))
      : Promise.resolve({ data: [] as { post_id: string }[] }),
  ]);
  const pinnedIds = new Set(((pinned.data ?? []) as { post_id: string | null }[]).flatMap((r) => (r.post_id ? [r.post_id] : [])));
  const videoIds = new Set(((videos.data ?? []) as { post_id: string }[]).map((r) => r.post_id));
  const day = (iso: string) => new Intl.DateTimeFormat(lang, { timeZone: shop.timezone, day: "numeric", month: "numeric" }).format(new Date(iso));
  const dayTime = (iso: string) =>
    `${day(iso)} ${new Intl.DateTimeFormat(lang, { timeZone: shop.timezone, hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso))}`;
  const edited = (iso: string) => {
    const w = timeWord(iso, now, shop.timezone, lang);
    return t(b.pill_edited, { when: w.kind === "yesterday" ? b.pill_yesterday : w.kind === "time" ? t(b.pill_today, { time: w.text }) : w.text });
  };
  const chip = (key: BlogFilter, label: string) => (
    <Link
      key={key}
      href={`/${lang}/dashboard/blog?${new URLSearchParams({ shop: shop.slug, ...(key === "all" ? {} : { f: key }) })}`}
      aria-current={filter === key ? "page" : undefined}
      className={`inline-flex min-h-12 flex-none items-center whitespace-nowrap rounded-3xl border px-[18px] text-[15px] font-bold ${filter === key ? "border-[#111] bg-[#111] text-white" : "border-[#D6D6D6] bg-white text-[#111]"}`}
      data-blog-filter={key}
    >
      {label} {counts[key]}
    </Link>
  );
  const pill = (text: string, strong = false, key?: string) => (
    <span key={key ?? text} className={`inline-flex h-[26px] items-center whitespace-nowrap rounded-[13px] border px-2.5 text-[13px] font-bold ${strong ? "border-[#111]" : "border-[#D6D6D6]"}`}>
      {text}
    </span>
  );
  const menuItem = "flex min-h-11 w-full items-center rounded-lg px-3 text-left text-[15px] font-semibold hover:bg-[#F2F2F2]";
  const postsWord = plural(b, "posts_n", data.posts.length, lang);
  const lineText = data.limit === null ? t(b.head_pro, { posts: postsWord }) : t(b.head_free, { posts: postsWord, limit: data.limit });

  return (
    <div className="flex w-full max-w-[1180px] flex-col gap-[18px]">
      <header className="flex flex-col gap-2" data-page-head="blog">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <PageTitle>{b.title}</PageTitle>
            <p className="text-[15px] text-muted" data-blog-line>
              {lineText}
            </p>
          </div>
          <Link href={`/${lang}/dashboard/blog/new?${new URLSearchParams({ shop: shop.slug })}`} className={`${buttonClass} min-h-14 px-6`} data-new-post>
            + {b.new_post}
          </Link>
        </div>
        <ShopSwitcher shops={shops} current={shop} label={dict.dashboard.shop} href={(slug) => `/${lang}/dashboard/blog?${new URLSearchParams({ shop: slug })}`} />
        {shops.length > 1 && <p className="text-muted">{shop.name}</p>}
        <p className="text-sm">{b.intro}</p>
      </header>
      {fbOn && pick && (
        <FacebookPagePicker
          pendingId={pick}
          doneUrl={`/${lang}/dashboard/blog?${new URLSearchParams({ shop: shop.slug, at: "facebook", ok: "fb_connected" })}#facebook`}
          labels={{ ...b, saving: b.saving }}
        />
      )}

      <div className={`grid gap-[18px] ${fbOn ? "lg:grid-cols-[minmax(0,1fr)_320px]" : ""} lg:items-start`}>
        {/* LEFT: the filter chips and the posts */}
        <section id="posts" className="flex min-w-0 scroll-mt-4 flex-col gap-3" aria-label={b.posts_title} data-blog-list>
          {notice(dict, sp, "posts")}
          <nav aria-label={b.filter_label} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0" data-blog-filters>
            {chip("all", b.filter_all)}
            {chip("published", b.filter_published)}
            {chip("scheduled", b.filter_scheduled)}
            {chip("draft", b.filter_draft)}
            {counts.pending > 0 && chip("pending", b.filter_pending)}
          </nav>
          {data.limit !== null && <p className="text-sm">{t(b.limit_free, { n: data.limit })}</p>}
          {posts.length === 0 ? (
            <p className="border-t border-[#E4E4E4] py-4 text-sm text-muted">{data.posts.length === 0 ? b.no_posts : b.no_posts_filter}</p>
          ) : (
            <ul className="flex flex-col border-t border-[#E4E4E4]" data-blog-posts>
              {posts.map((p) => {
                const scheduled = isScheduled(p);
                const pills: React.ReactNode[] = [];
                if (p.status === "pending") {
                  pills.push(pill(b.from_facebook, false, "src"), pill(b.status_pending, true, "st"));
                } else if (p.status === "draft") {
                  pills.push(pill(b.status_draft, false, "st"), pill(edited(p.edited_at ?? p.created_at), false, "ed"));
                } else if (p.status === "hidden") {
                  pills.push(pill(b.status_hidden, true, "st"));
                } else if (scheduled && p.publish_at) {
                  pills.push(pill(t(b.pill_scheduled, { date: dayTime(p.publish_at) }), true, "st"));
                  if (p.fb_choice === "web_fb" && p.fb_status === "waiting") pills.push(pill(b.pill_fb_at_publish, false, "fb"));
                } else {
                  pills.push(pill(t(b.pill_published, { date: day(p.publish_at ?? p.created_at) }), false, "st"));
                }
                if (p.status !== "pending" && p.source === "facebook") pills.push(pill(b.from_facebook, false, "src"));
                if (p.source === "cacaduu" && p.status === "published" && !scheduled) {
                  if (p.fb_status === "posted") pills.push(pill(b.pill_web_fb, false, "ch"));
                  else if (p.fb_status === "failed") pills.push(pill(b.fb_failed, true, "ch"));
                  else if (p.fb_choice === "web") pills.push(pill(b.choice_web, false, "ch"));
                }
                if (p.photos > 0) pills.push(pill(plural(b, "pill_photos", p.photos, lang), false, "ph"));
                if (p.photos_waiting > 0) pills.push(pill(t(b.pill_photos_waiting, { n: p.photos_waiting }), false, "pw"));
                if (pinnedIds.has(p.id)) pills.push(pill(b.pill_pinned, false, "pin"));
                if (p.status === "published" && !scheduled && !p.visible && data.limit !== null) pills.push(pill(t(b.not_shown_limit, { n: data.limit }), true, "lim"));
                if (p.fb_deleted_at) pills.push(pill(b.deleted_on_facebook, false, "del"));
                return (
                  <li
                    key={p.id}
                    className="relative grid min-h-[104px] grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-3 border-b border-[#E4E4E4] py-2.5 sm:grid-cols-[96px_minmax(0,1fr)_auto] sm:gap-3.5"
                    data-post={p.slug}
                    data-status={scheduled ? "scheduled" : p.status}
                  >
                    <span className="relative" aria-hidden="true">
                      {p.photo ? (
                        // eslint-disable-next-line @next/next/no-img-element -- the post's first photo (800 px)
                        <img src={photoSrc(p.photo)} alt="" className="h-[60px] w-[72px] rounded-xl object-cover sm:h-20 sm:w-24" />
                      ) : (
                        <span className="block h-[60px] w-[72px] rounded-xl border border-dashed border-[#BDBDBD] bg-[#F5F5F5] sm:h-20 sm:w-24" />
                      )}
                      {videoIds.has(p.id) && (
                        <span className="absolute inset-0 flex items-center justify-center">
                          <span className="flex size-8 items-center justify-center rounded-full bg-black/70 text-white">▶</span>
                        </span>
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col gap-1.5">
                      <Link href={editHref(p.id)} className="text-[17px] font-bold leading-snug after:absolute after:inset-0 after:content-['']" data-post-edit>
                        {p.title}
                      </Link>
                      <span className="flex flex-wrap gap-1.5">{pills}</span>
                    </span>
                    <span className="relative flex items-center gap-1">
                      {p.status === "pending" ? (
                        <form action={setBlogPostHidden}>
                          {hidden({ at: "posts", post_id: p.id, hidden: "0", approve: "1" })}
                          <button type="submit" className={`${buttonClass} min-h-12 px-4 text-[15px]`} data-toggle="pending">
                            {b.approve}
                          </button>
                        </form>
                      ) : null}
                      {/* what the list did before besides "Upraviť": view, hide / show, delete */}
                      <details className="relative" data-post-menu>
                        <summary className="flex size-11 cursor-pointer list-none items-center justify-center rounded-xl text-xl font-bold hover:bg-[#F2F2F2] [&::-webkit-details-marker]:hidden" aria-label={b.more_actions}>
                          ⋯
                        </summary>
                        <div className="absolute right-0 top-12 z-30 flex w-60 flex-col gap-0.5 rounded-2xl border border-[#E4E4E4] bg-white p-2 shadow-lg">
                          <Link href={editHref(p.id)} className={menuItem}>
                            {b.edit}
                          </Link>
                          {p.visible && (
                            <a href={view(p.slug)} target="_blank" rel="noopener" className={menuItem}>
                              {b.view}
                            </a>
                          )}
                          {p.fb_status === "posted" && p.fb_permalink && (
                            <a href={p.fb_permalink} target="_blank" rel="noopener" className={menuItem}>
                              {b.fb_posted}
                            </a>
                          )}
                          {p.status !== "draft" && (
                            <form action={setBlogPostHidden}>
                              {hidden({ at: "posts", post_id: p.id, hidden: p.status === "hidden" || p.status === "pending" ? (p.status === "pending" ? "1" : "0") : "1" })}
                              <button type="submit" className={menuItem} data-toggle={p.status === "pending" ? "pending-hide" : p.status}>
                                {p.status === "hidden" ? b.show : b.hide}
                              </button>
                            </form>
                          )}
                          <form action={deleteBlogPost}>
                            {hidden({ at: "posts", post_id: p.id })}
                            <ConfirmButton question={b.delete_confirm} className={menuItem}>
                              {b.delete}
                            </ConfirmButton>
                          </form>
                        </div>
                      </details>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" aria-hidden="true" className="hidden sm:block">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* RIGHT: "Facebook stránka" (only when Facebook is set up on Cacaduu) */}
        {fbOn && (
          <section id="facebook" className={`${cardClass} min-w-0 scroll-mt-4`} aria-labelledby="facebook-title" data-facebook-card>
            <h2 id="facebook-title" className="text-lg font-bold">
              {b.fb_title}
            </h2>
            {notice(dict, sp, "facebook")}
            {!fb ? (
              <form action={connectFacebook} className="flex flex-col gap-2" data-facebook-connect>
                {hidden({ at: "facebook" })}
                <p className="text-sm">{b.fb_intro}</p>
                <SubmitButton pending={b.saving}>{b.fb_connect}</SubmitButton>
                <span className="text-sm text-muted">{b.fb_profiles}</span>
              </form>
            ) : (
              <div className="flex flex-col gap-3.5" data-facebook-connected={fb.status}>
                <div className="flex items-center gap-3">
                  {fb.page_picture ? (
                    // eslint-disable-next-line @next/next/no-img-element -- the Page's picture from Facebook, in Môj obchod only
                    <img src={fb.page_picture} alt="" width={48} height={48} className="size-12 flex-none rounded-full object-cover" />
                  ) : (
                    <span aria-hidden="true" className="size-12 flex-none rounded-full bg-[#EDEDED]" />
                  )}
                  <span className="flex min-w-0 flex-col">
                    <strong className="truncate">{fb.page_name}</strong>
                    <span className="text-sm text-muted">
                      {fb.status === "expired"
                        ? b.fb_summary_expired
                        : t(b.fb_connected_sync, { date: fb.last_sync_at ? syncWhen(fb.last_sync_at) : dict.account.never })}
                    </span>
                  </span>
                </div>
                {fb.status === "expired" && (
                  <form action={connectFacebook} className="flex flex-col gap-2 rounded-xl border border-foreground p-3" data-facebook-expired>
                    {hidden({ at: "facebook" })}
                    <p className="font-medium">{b.fb_expired}</p>
                    <SubmitButton pending={b.saving}>{b.dialog_reconnect}</SubmitButton>
                  </form>
                )}
                <FacebookImportProgress
                  shopId={shop.id}
                  initial={{ state: fb.import_state, count: fb.import_count, error: fb.import_error }}
                  labels={{ fb_import_running: b.fb_import_running, fb_import_done: b.fb_import_done, fb_import_failed: b.fb_import_failed }}
                />
                {fb.status === "ok" && fb.import_state !== "running" && (
                  <form action={importFacebook}>
                    {hidden({ at: "facebook" })}
                    <button type="submit" className={`${ghostClass} w-full`} data-facebook-import>
                      {b.fb_import}
                    </button>
                  </form>
                )}
                {fb.next_sync_at && fb.status === "ok" && <p className="text-[13px] text-muted">{t(b.fb_next_sync, { date: when(fb.next_sync_at) })}</p>}
                <form action={saveBlogSettings} className="flex flex-col gap-1 border-t border-[#E4E4E4]" data-facebook-settings>
                  {hidden({ at: "facebook" })}
                  <ToggleSubmit name="auto_publish" label={b.fb_auto_short} defaultChecked={auto} data="auto-publish" />
                  <span className="text-sm text-muted">{auto ? b.fb_auto_on : b.fb_auto_off}</span>
                  <noscript>
                    <button type="submit" className={ghostClass}>
                      {b.fb_settings_save}
                    </button>
                  </noscript>
                </form>
                <form action={disconnectFacebook}>
                  {hidden({ at: "facebook" })}
                  <ConfirmButton question={b.fb_disconnect_confirm} className={`${ghostClass} w-full`}>
                    {b.fb_disconnect}
                  </ConfirmButton>
                </form>
              </div>
            )}
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <Link href={`/${lang}/sukromie#facebook`} className="underline underline-offset-4">
                {b.fb_privacy}
              </Link>
              <Link href={`/${lang}/sukromie/vymazanie-udajov`} className="underline underline-offset-4">
                {b.fb_deletion}
              </Link>
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
