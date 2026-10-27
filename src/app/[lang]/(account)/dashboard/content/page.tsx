import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { blogPath } from "@/lib/blogFormat";
import { forwardUrl, movedFrom } from "@/lib/dashboardPages";
import { formatDate } from "@/lib/format";
import { localDateTime } from "@/lib/hours";
import type { MyShop } from "@/lib/myShops";
import { cardExcerpt, shownSlots, sliderRatio, type SliderRatio, type ContentLimits, type ContentPost, type Slot, type SlideImage } from "@/lib/pageContent";
import { postImage } from "@/lib/sections";
import { requestTime } from "@/lib/requestTime";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ContentEditor, type EditorItem, type EditorPost } from "@/components/ContentEditor";
import { DashboardSection } from "@/components/DashboardSection";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { SectionUploader } from "@/components/SectionUploader";
import { deleteItem, setItemState, updateItem } from "../sectionActions";
import { hiddenFields, inputClass, messages, ShopSwitcher } from "../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/content">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).account.content_page, robots: { index: false } };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A file of the library as owner_content() gives it (database update 38). */
interface OwnerItem {
  id: string;
  kind: "pdf" | "picture";
  title: string;
  show_title: boolean;
  file_name: string | null;
  alt: string | null;
  alt_ai: string | null;
  allow_download: boolean;
  page_layout: "slider" | "stacked";
  visible_from: string | null;
  visible_until: string | null;
  hidden: boolean;
  version: number;
  pages: number | null;
  source: "pdf" | "pictures";
  upload_version: number | null;
  upload_error: string | null;
  ready: boolean;
  downloadable: boolean;
  width: number | null;
  height: number | null;
  created_at: string;
}

interface OwnerContent {
  configured: boolean;
  title: string | null;
  show_title: boolean;
  display: "open" | "collapsed";
  /** Update 39; missing before it. */
  video_target?: "post" | "facebook";
  /** Update 44; missing before it. */
  ratio?: SliderRatio;
  limits: { plan: "free" | "pro"; max_slides: number; max_pdf_slides: number; max_items: number; max_pages: number; max_bytes: number };
  slots: Slot[];
  items: OwnerItem[];
  posts: ContentPost[];
}

/** The first page of every file (10-minute addresses from page-sections: the pictures are private until shown). */
async function loadThumbs(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"], shopId: string): Promise<Map<string, SlideImage>> {
  const { data } = await supabase.functions
    .invoke<{ items: { id: string; width: number; height: number; small: string | null; large: string | null }[] }>("page-sections", {
      body: { action: "library", shop_id: shopId },
    })
    .catch(() => ({ data: null }));
  const map = new Map<string, SlideImage>();
  for (const i of data?.items ?? []) {
    if (i.small && i.large) map.set(i.id, { small: i.small, large: i.large, width: i.width, height: i.height });
  }
  return map;
}

const dateText = (date: string, lang: Locale) =>
  new Intl.DateTimeFormat(lang, { day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

/** What the owner reads next to a file (the database decides the same for visitors). */
function itemState(item: OwnerItem, today: string, slide: number | null, inSlots: boolean, dict: Dictionary, lang: Locale): string {
  const c = dict.content;
  if (item.upload_error) return t(c.state_error, { reason: (dict.sections as Record<string, string>)[`error_${item.upload_error}`] ?? item.upload_error });
  if (item.version === 0) return item.upload_version ? c.state_processing : c.state_empty;
  if (item.hidden) return c.state_hidden;
  if (item.visible_from && item.visible_from > today) return t(c.state_before, { date: dateText(item.visible_from, lang) });
  if (item.visible_until && item.visible_until < today) return t(c.state_after, { date: dateText(item.visible_until, lang) });
  if (slide !== null) return t(c.state_live, { n: slide });
  return inSlots ? c.state_over_limit : c.state_not_in_slider;
}

/**
 * Môj obchod → "Obsah stránky" (database update 38; it replaces "Sekcie stránky (PDF)"): 1) the shop page's one
 * slider — its title and look, how many automatic posts, PDFs, pinned posts and pictures, their order and a live
 * preview — and 2) the library of the shop's PDFs and pictures (upload, edit, hide, replace, delete). Every shop; the
 * numbers are the plan's (the admin's settings). The database decides everything again (owner_save_content,
 * owner_save_item, content_slots_shown).
 */
export default async function ContentPage({ params, searchParams }: PageProps<"/[lang]/dashboard/content">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const at = first(sp.at) ?? "";
  if (movedFrom("content", at)) redirect(forwardUrl(lang, at, sp));
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const c = dict.content;
  const d = dict.dashboard;

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];

  const [contentResult, thumbs] = await Promise.all([supabase.rpc("owner_content", { p_shop_id: shop.id }), loadThumbs(supabase, shop.id)]);
  const m = messages(dict, sp);
  const hidden = hiddenFields(lang, shop);
  const planUrl = `/${lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`;
  const header = (
    <header className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{dict.account.content_page}</h1>
      <ShopSwitcher shops={shops} current={shop} label={d.shop} href={(slug) => `/${lang}/dashboard/content?${new URLSearchParams({ shop: slug })}`} />
      <p className="text-muted">{shop.name}</p>
      <p className="text-sm">{c.page_intro}</p>
      {m.top}
    </header>
  );
  // Before database update 38 this page has nothing to show yet.
  if (contentResult.error || !contentResult.data) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        {header}
        <p className="border border-line p-3 text-sm" data-content-unavailable>
          {c.unavailable}
        </p>
      </div>
    );
  }
  const data = contentResult.data as OwnerContent;
  const limits: ContentLimits = {
    plan: data.limits.plan === "pro" ? "pro" : "free",
    maxSlides: data.limits.max_slides,
    maxPdfSlides: data.limits.max_pdf_slides,
    maxItems: data.limits.max_items,
    maxPages: data.limits.max_pages,
    maxBytes: data.limits.max_bytes,
  };
  const today = localDateTime(new Date(requestTime()), shop.timezone).date;
  const place = { shopSlug: shop.slug, country: shop.country, host: null };

  const items: EditorItem[] = data.items.map((i) => ({
    id: i.id,
    kind: i.kind,
    ready: i.ready,
    title: i.title,
    showTitle: i.show_title,
    alt: i.alt || i.alt_ai,
    pages: i.pages ?? 0,
    layout: i.page_layout,
    image: thumbs.get(i.id) ?? null,
  }));
  const posts: EditorPost[] = data.posts.map((p) => ({
    id: p.id,
    title: p.title,
    date: formatDate(p.publish_at, lang, shop.timezone),
    dateTime: p.publish_at,
    excerpt: cardExcerpt(p.excerpt),
    href: blogPath(lang, place, false, p.slug),
    image: postImage(p.photo),
    video: p.video ?? null,
  }));
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const shown = shownSlots(data.slots, itemMap, limits);
  const slideOf = new Map<string, number>();
  shown.forEach(({ slot }, n) => slot.item_id && slideOf.set(slot.item_id, n + 1));
  const inSlots = new Set(data.slots.map((s) => s.item_id).filter(Boolean));
  const room = Math.max(0, limits.maxItems - data.items.length);
  const mb = Math.round(limits.maxBytes / 1048576);

  const itemParam = first(sp.item) ?? "";
  const selected = UUID.test(itemParam) ? (data.items.find((i) => i.id === itemParam) ?? null) : null;
  const edit = selected && first(sp.replace) !== "1" ? selected : null;
  const replace = selected && first(sp.replace) === "1" ? selected : null;
  const libraryUrl = (query: Record<string, string> = {}) =>
    `/${lang}/dashboard/content?${new URLSearchParams({ shop: shop.slug, at: "library", ...query })}`;
  const counts = { pdf: data.items.filter((i) => i.kind === "pdf").length, picture: data.items.filter((i) => i.kind === "picture").length };
  const summaries = {
    content: t(c.summary, { n: shown.length, max: limits.maxSlides }),
    library: data.items.length ? t(c.library_summary, { pdf: counts.pdf, pictures: counts.picture, max: limits.maxItems }) : c.library_none,
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {header}

      <div className="flex flex-col border-t border-line" data-content-sections>
        {/* 1. The slider: title, look, slots, order, live preview */}
        <DashboardSection {...m.section("content")} first title={c.slider_title} summary={summaries.content}>
          {m.notice("content")}
          <p className="text-sm text-muted">{c.slider_intro}</p>
          <ContentEditor
            shopId={shop.id}
            settings={{ title: data.title, showTitle: data.show_title, display: data.display, videoTarget: data.video_target, ratio: data.ratio }}
            slots={data.slots}
            limits={limits}
            items={items}
            posts={posts}
            text={c}
            lang={lang}
            planUrl={planUrl}
          />
        </DashboardSection>

        {/* 2. The library: the shop's PDFs and pictures */}
        <DashboardSection {...m.section("library")} title={c.library_title} summary={summaries.library}>
          {m.notice("library")}
          <p className="text-sm text-muted">{c.library_intro}</p>

          {data.items.length > 0 && (
            <ul className="flex flex-col divide-y divide-line border-y border-line" data-library>
              {data.items.map((item) => {
                const thumb = thumbs.get(item.id);
                const state = itemState(item, today, slideOf.get(item.id) ?? null, inSlots.has(item.id), dict, lang);
                const details = [
                  item.kind === "pdf" ? c.kind_pdf : c.kind_picture,
                  item.kind === "pdf" && item.pages ? t(c.pages_count, { n: item.pages }) : null,
                  item.kind === "pdf" ? (item.page_layout === "stacked" ? dict.sections.layout_stacked : dict.sections.layout_slider) : null,
                  item.allow_download ? c.download_on : null,
                  item.visible_from || item.visible_until
                    ? t(c.dates, {
                        from: item.visible_from ? dateText(item.visible_from, lang) : "…",
                        until: item.visible_until ? dateText(item.visible_until, lang) : "…",
                      })
                    : null,
                  item.upload_version && item.version > 0 && !item.upload_error ? c.state_processing : null,
                ].filter(Boolean);
                return (
                  <li key={item.id} className="flex gap-3 py-3" data-library-item={item.kind} data-item-id={item.id}>
                    <div className="flex h-20 w-16 shrink-0 items-center justify-center border border-line bg-white">
                      {thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element -- a 10-minute address of a private picture
                        <img src={thumb.small} alt="" width={64} height={80} className="max-h-full max-w-full object-contain" />
                      ) : (
                        <span className="text-xs text-muted">{item.kind === "pdf" ? "PDF" : "–"}</span>
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="break-words font-semibold">{item.title || item.file_name}</span>
                      <span className="text-sm font-semibold" data-item-state>
                        {state}
                      </span>
                      <span className="text-sm text-muted">{details.join(" · ")}</span>
                      {item.kind === "picture" && (item.alt || item.alt_ai) && (
                        <span className="text-sm text-muted" data-item-alt>
                          {t(item.alt ? c.alt_owner : c.alt_ai, { alt: item.alt || item.alt_ai || "" })}
                        </span>
                      )}
                      <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                        <Link href={`${libraryUrl({ item: item.id })}#item-edit`} className="underline underline-offset-4" data-item-edit>
                          {c.edit}
                        </Link>
                        {item.version > 0 && (
                          <form action={setItemState}>
                            {hidden({ at: "library", item_id: item.id, state: item.hidden ? "show" : "hide" })}
                            <button type="submit" className="underline underline-offset-4" data-item-toggle={item.hidden ? "show" : "hide"}>
                              {item.hidden ? c.show : c.hide}
                            </button>
                          </form>
                        )}
                        <Link href={`${libraryUrl({ item: item.id, replace: "1" })}#item-replace`} className="underline underline-offset-4" data-item-replace>
                          {c.replace}
                        </Link>
                        <form action={deleteItem}>
                          {hidden({ at: "library", item_id: item.id })}
                          <ConfirmButton question={t(c.delete_confirm, { title: item.title || item.file_name || "" })} className="underline underline-offset-4">
                            {c.delete}
                          </ConfirmButton>
                        </form>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {edit && (
            <form action={updateItem} className="flex scroll-mt-4 flex-col gap-3 border border-foreground p-3" id="item-edit" data-item-edit-form>
              {hidden({ at: "library", item_id: edit.id })}
              <h3 className="font-semibold">{t(c.edit_title, { title: edit.title || edit.file_name || "" })}</h3>
              <label className="flex flex-col gap-1">
                <span className="text-sm">{edit.kind === "pdf" ? c.title_pdf : c.title_picture}</span>
                <input name="title" required={edit.kind === "pdf"} maxLength={80} defaultValue={edit.kind === "picture" && !edit.show_title ? "" : edit.title} className={inputClass} />
              </label>
              {edit.kind === "picture" && (
                <label className="flex flex-col gap-1">
                  <span className="text-sm">{c.alt_label}</span>
                  <input name="alt" maxLength={250} defaultValue={edit.alt ?? ""} placeholder={edit.alt_ai ?? ""} className={inputClass} />
                  <span className="text-sm text-muted">{c.alt_hint}</span>
                </label>
              )}
              {edit.kind === "pdf" && (
                <fieldset className="flex flex-col gap-1">
                  <legend className="text-sm">{c.viewer}</legend>
                  {(["slider", "stacked"] as const).map((l) => (
                    <label key={l} className="flex items-center gap-2">
                      <input type="radio" name="page_layout" value={l} defaultChecked={edit.page_layout === l} />
                      {l === "slider" ? dict.sections.layout_slider : dict.sections.layout_stacked}
                    </label>
                  ))}
                  <span className="text-sm text-muted">{c.viewer_hint}</span>
                </fieldset>
              )}
              <label className="flex items-center gap-2">
                <input type="checkbox" name="allow_download" defaultChecked={edit.allow_download} />
                {edit.kind === "pdf" ? c.download_pdf_allow : c.download_picture_allow}
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-sm">{dict.sections.visible_from}</span>
                  <input type="date" name="from" defaultValue={edit.visible_from ?? ""} className={inputClass} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm">{dict.sections.visible_until}</span>
                  <input type="date" name="until" defaultValue={edit.visible_until ?? ""} className={inputClass} />
                </label>
              </div>
              <div className="flex items-center gap-4">
                <PendingButton pending={dict.owner.saving}>{c.save}</PendingButton>
                <Link href={`${libraryUrl()}#library`} className="underline underline-offset-4">
                  {c.cancel}
                </Link>
              </div>
            </form>
          )}

          {replace && (
            <div className="flex scroll-mt-4 flex-col gap-2 border border-foreground p-3" id="item-replace" data-item-replace-form>
              <h3 className="font-semibold">{t(c.replace_title, { title: replace.title || replace.file_name || "" })}</h3>
              <p className="text-sm text-muted">{c.replace_hint}</p>
              <SectionUploader mode="replace" shopId={shop.id} itemId={replace.id} itemKind={replace.kind} labels={dict.sections} text={c} limits={limits} ratio={sliderRatio(data.ratio)} />
              <Link href={`${libraryUrl()}#library`} className="self-start text-sm underline underline-offset-4">
                {c.cancel}
              </Link>
            </div>
          )}

          {room > 0 ? (
            <div className="flex flex-col gap-2 border-t border-line pt-4" id="item-add" data-library-add>
              <h3 className="font-semibold">{c.add_title}</h3>
              <SectionUploader mode="new" shopId={shop.id} labels={dict.sections} text={c} limits={limits} room={room} ratio={sliderRatio(data.ratio)} />
            </div>
          ) : (
            <p className="border border-line p-3 text-sm" data-library-full>
              {t(c.library_full, { max: limits.maxItems })}{" "}
              {limits.plan === "free" && (
                <Link href={planUrl} className="underline underline-offset-4">
                  {c.go_pro}
                </Link>
              )}
            </p>
          )}
          <p className="text-sm text-muted">{t(c.limits_line, { pages: limits.maxPages, mb, max: limits.maxItems })}</p>
        </DashboardSection>
      </div>
    </div>
  );
}
