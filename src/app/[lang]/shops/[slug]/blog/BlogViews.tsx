import type { Metadata } from "next";
import "@/components/unified.css";
import { preload } from "react-dom";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Locale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { getBlogPage, getBlogPost, photoSrc } from "@/lib/blog";
import {
  BLOG_PER_PAGE,
  blogAlternates,
  blogJsonLd,
  blogPath,
  blogPostingJsonLd,
  blogRssUrl,
  blogUrl,
  excerpt,
  type BlogPlace,
  type BlogPost,
} from "@/lib/blogFormat";
import { siteLang, sitePath } from "@/lib/customDomain";
import { getShopLanguages } from "@/lib/shopLanguages";
import { getShopTexts } from "@/lib/contentTranslations";
import { TranslatingRefresh } from "@/components/TranslatingRefresh";
import { getShop, shopHasPlan, shopSiteHost, type PublicShop } from "@/lib/data";
import { shopChatEnabled } from "@/lib/shopChat";
import { readingMinutes } from "@/lib/pageContent";
import { formatDate } from "@/lib/format";
import { shopPageUrl } from "@/lib/jsonLd";
import { siteUrl } from "@/lib/site";
import { PostGallery } from "@/components/PostGallery";
import { IconCopy } from "@/components/IconCopy";
import { PlayMark } from "@/components/YouTubePlay";
import { youtubeId } from "@/lib/video";
import { BlogText } from "@/components/BlogText";
import { placedPhotos } from "@/lib/blogMarks";
import { JsonLd } from "@/components/JsonLd";
import { SectionZoom } from "@/components/SectionZoom";

/**
 * The shop's blog ("Novinky", database update 37) on its Cacaduu address (/{lang}/shops/{slug}/blog) and on its own
 * domain (onSite: /blog, /hu/blog …; only src/proxy.ts sends visitors there): server-rendered HTML with the posts as
 * written, schema.org data (Blog, BlogPosting, BreadcrumbList) and one canonical — the own domain once it is live.
 * The database decides which posts exist (published, their time, the plan's number); anything else is 404.
 */

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function load(slug: string, onSite: boolean) {
  const shop = await getShop(slug).catch(() => null);
  if (!shop) return null;
  const [host, langs] = await Promise.all([shopSiteHost(shop.slug).catch(() => null), getShopLanguages(shop.slug, shop.country)]);
  if (onSite && !host) return null;
  const place: BlogPlace = { shopSlug: shop.slug, country: shop.country, host, homeLang: shop.site_lang };
  return { shop, host, place, langs };
}

/** The shop's page on the address the visitor is on. */
const shopPath = (lang: Locale, shop: PublicShop, onSite: boolean) => (onSite ? sitePath(lang, siteLang(shop.country, shop.site_lang)) : `/${lang}/shops/${shop.slug}`);

const pageNumber = (sp: Record<string, string | string[] | undefined>) => Math.max(1, Math.floor(Number(first(sp.page)) || 1));

const changed = (post: BlogPost) => Date.parse(post.modified_at) - Date.parse(post.publish_at) > 60_000;

/** Update 93: the cover's crop ("Výrez") as an object-position (the first photo of a post is its cover). */
const focusOf = (photo: { focus?: string } | undefined) =>
  photo?.focus === "top" ? "50% 0%" : photo?.focus === "bottom" ? "50% 100%" : undefined;

export async function blogListMetadata(lang: Locale, slug: string, page: number, onSite: boolean): Promise<Metadata> {
  const [dict, found] = await Promise.all([getDictionary(lang), load(slug, onSite)]);
  if (!found) return {};
  const { shop, place, langs } = found;
  const alternates = blogAlternates(siteUrl(), lang, place, undefined, langs.indexed);
  const title = t(dict.blog.title_of, { name: shop.name });
  return {
    title,
    description: t(dict.blog.meta_description, { name: shop.name, city: shop.city ? `, ${shop.city}` : "" }),
    alternates: {
      ...alternates,
      canonical: page > 1 ? `${alternates.canonical}?page=${page}` : alternates.canonical,
      types: { "application/rss+xml": [{ url: blogRssUrl(siteUrl(), place), title }] },
    },
    openGraph: { type: "website", title, url: alternates.canonical },
    // The shop decides (its pre-translated languages), over the site-wide rule of the [lang] layout.
    robots: { index: langs.indexed.includes(lang), follow: true },
  };
}

export async function BlogListView({ lang, slug, sp, onSite }: { lang: Locale; slug: string; sp: Record<string, string | string[] | undefined>; onSite: boolean }) {
  const [dict, found] = await Promise.all([getDictionary(lang), load(slug, onSite)]);
  if (!found) notFound();
  const { shop, place } = found;
  const b = dict.blog;
  const requested = pageNumber(sp);
  const data = await getBlogPage(shop.slug, requested);
  // Titles and texts in the visitor's language when translated (update 40); the original as written stays.
  const texts = await getShopTexts(shop.slug, lang, found.langs, first(sp.original) === "1", [
    { kinds: ["blog_title", "blog_body"], refs: (data?.posts ?? []).flatMap((p) => (p.id ? [p.id] : [])) },
  ]);
  const posts = (data?.posts ?? []).map((p) => (p.id ? { ...p, title: texts.text("blog_title", p.id, p.title), body: texts.text("blog_body", p.id, p.body) } : p));
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / BLOG_PER_PAGE));
  if (requested > pages) notFound();
  const base = siteUrl();
  const shopUrl = shopPageUrl(base, shop.slug, shop.country, lang, found.host, shop.site_lang);
  const listUrl = blogUrl(base, lang, place);
  const here = (n: number) => `${blogPath(lang, place, onSite)}${n > 1 ? `?page=${n}` : ""}`;
  const date = (post: BlogPost) => formatDate(post.publish_at, lang, shop.timezone);
  // The first post of the first page is the hero card, text first (the owner's choice, 2026-11-04): its title and three
  // lines of text are the page's largest element, painted with the first frame; the photo is a 112 px square beside
  // the title, never preloaded (a photo hero was the largest element and, sharing slow 4G with the page's scripts,
  // finished at ~3.0 s — the budget is 2.0 s, PERFORMANCE.md).
  const hero = requested === 1 ? posts[0] : undefined;
  const heroPhoto = hero?.photos[0];
  const rest = hero ? posts.slice(1) : posts;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5" data-unified-page data-blog-list>
      <JsonLd
        data={blogJsonLd({
          url: listUrl,
          name: t(b.title_of, { name: shop.name }),
          shop: { name: shop.name, url: shopUrl },
          posts: posts.map((p) => ({ title: p.title, url: blogUrl(base, lang, place, p.slug), publish_at: p.publish_at, modified_at: p.modified_at })),
        })}
      />
      {/* The way back to the shop (the breadcrumb stays in the JSON-LD). */}
      <BackChip href={shopPath(lang, shop, onSite)} label={shop.name} aria={t(b.back_to, { shop: shop.name })} />
      <header className="flex flex-col gap-1">
        <h1 className="text-[32px] leading-tight font-bold">{b.title}</h1>
        <p className="text-[15px] text-[#5B6670]">{t(b.subtitle, { name: shop.name })}</p>
      </header>

      {posts.length === 0 ? (
        <p className="text-[15px] text-[#5B6670]">{b.empty}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {hero && (
            <li data-blog-post={hero.slug} data-blog-hero>
              <Link href={blogPath(lang, place, onSite, hero.slug)} className="flex flex-col items-start gap-3 rounded-[18px] border-[1.5px] border-[#FBCFA9] bg-white p-4">
                <span className="flex w-full items-start gap-3.5">
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-2">
                    <DateChip date={hero.publish_at} text={date(hero)} />
                    <span className="text-[22px] leading-snug font-bold">{hero.title}</span>
                  </span>
                  {heroPhoto && (
                    <span className="relative h-28 w-28 shrink-0 overflow-hidden rounded-[14px]" data-blog-hero-photo>
                      {/* eslint-disable-next-line @next/next/no-img-element -- the stored 800 px WebP straight from the bucket */}
                      <img src={photoSrc(heroPhoto.small)} alt="" width={112} height={112} decoding="async" className="h-full w-full object-cover" style={{ objectPosition: focusOf(heroPhoto) }} />
                      {hero.photos.some((p) => p.kind === "video") && (
                        <span className="absolute inset-0 flex items-center justify-center" data-blog-list-video aria-hidden="true">
                          <PlayMark size={36} />
                        </span>
                      )}
                    </span>
                  )}
                </span>
                {hero.body.trim() && <span className="line-clamp-3 text-[16px] leading-normal text-[#5B6670]">{excerpt(hero.body, 320)}</span>}
                <span className="inline-flex min-h-9 items-center rounded-full bg-[#FFF1E6] px-4 text-[15px] font-bold text-[#9A3A0A]">{b.read_arrow}</span>
              </Link>
            </li>
          )}
          {rest.map((post) => {
            const photo = post.photos[0];
            return (
              <li key={post.slug} data-blog-post={post.slug}>
                <Link href={blogPath(lang, place, onSite, post.slug)} className="flex gap-3.5 rounded-2xl border border-[#ECE7DE] bg-white p-3">
                  {photo && (
                    <span className="relative h-24 w-24 shrink-0 overflow-hidden rounded-xl">
                      {/* eslint-disable-next-line @next/next/no-img-element -- the stored 800 px WebP */}
                      <img src={photoSrc(photo.small)} alt="" width={96} height={96} loading="lazy" decoding="async" className="h-full w-full object-cover" style={{ objectPosition: focusOf(photo) }} />
                      {post.photos.some((p) => p.kind === "video") && (
                        <span className="absolute inset-0 flex items-center justify-center" data-blog-list-video aria-hidden="true">
                          <PlayMark size={32} />
                        </span>
                      )}
                    </span>
                  )}
                  <span className="flex min-w-0 flex-col items-start gap-1.5 py-0.5">
                    <DateChip date={post.publish_at} text={date(post)} />
                    <span className="text-[17px] leading-snug font-bold">{post.title}</span>
                    {post.body.trim() && <span className="line-clamp-2 text-[14px] text-[#5B6670]">{excerpt(post.body, 200)}</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}

      {pages > 1 && (
        <nav className="flex items-center justify-between gap-3" aria-label={t(b.page_of, { page: requested, pages })} data-blog-pages>
          <PagePill href={requested > 1 ? here(requested - 1) : null} rel="prev" text={b.newer} />
          <span className="text-sm text-[#5B6670] tabular-nums">{t(b.page_of, { page: requested, pages })}</span>
          <PagePill href={requested < pages ? here(requested + 1) : null} rel="next" text={b.older} />
        </nav>
      )}
    </div>
  );
}

function BackChip({ href, label, aria }: { href: string; label: string; aria: string }) {
  return (
    <Link href={href} className="ppi-u-back" aria-label={aria} data-back>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C2410C" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M15 5l-7 7 7 7" />
      </svg>
      <span>{label}</span>
    </Link>
  );
}

function DateChip({ date, text }: { date: string; text: string }) {
  return (
    <time dateTime={date} className="rounded-full bg-white px-2.5 py-0.5 text-[12px] font-bold text-[#9A3A0A] shadow-[0_0_0_1px_#F1EDE6]">
      {text}
    </time>
  );
}

/** "Novšie" / "Staršie": a pill link, or the same pill shown disabled at the ends. */
function PagePill({ href, rel, text }: { href: string | null; rel: "prev" | "next"; text: string }) {
  const look = "inline-flex min-h-11 items-center rounded-full border px-4 text-[15px] font-bold";
  return href ? (
    <Link href={href} rel={rel} className={`${look} border-[#F57C20] bg-white text-[#1A1A1A]`}>
      {rel === "prev" ? `← ${text}` : `${text} →`}
    </Link>
  ) : (
    <span aria-disabled="true" className={`${look} border-[#ECE7DE] bg-white text-[#B5B5B5]`}>
      {rel === "prev" ? `← ${text}` : `${text} →`}
    </span>
  );
}

export async function blogPostMetadata(lang: Locale, slug: string, postSlug: string, onSite: boolean): Promise<Metadata> {
  const [found, post] = await Promise.all([load(slug, onSite), getBlogPost(slug, postSlug)]);
  if (!found || !post) return {};
  const { shop, place, langs } = found;
  const alternates = blogAlternates(siteUrl(), lang, place, post.slug, langs.indexed);
  const description = excerpt(post.body.trim() || post.title, 160);
  const image = post.photos.find((p) => p.kind === "photo") ?? post.photos[0];
  return {
    title: `${post.title} · ${shop.name}`,
    description,
    alternates,
    // The shop decides (its pre-translated languages), over the site-wide rule of the [lang] layout.
    robots: { index: langs.indexed.includes(lang), follow: true },
    openGraph: {
      type: "article",
      title: post.title,
      description,
      url: alternates.canonical,
      siteName: shop.name,
      publishedTime: post.publish_at,
      modifiedTime: post.modified_at,
      ...(image ? { images: [{ url: photoSrc(image.large), width: image.width ?? undefined, height: image.height ?? undefined, alt: post.title }] } : {}),
    },
    twitter: { card: image ? "summary_large_image" : "summary", title: post.title, description },
  };
}

export async function BlogPostView({ lang, slug, postSlug, onSite, original = false }: { lang: Locale; slug: string; postSlug: string; onSite: boolean; original?: boolean }) {
  const [dict, found, written] = await Promise.all([getDictionary(lang), load(slug, onSite), getBlogPost(slug, postSlug)]);
  if (!found || !written) notFound();
  const { shop, place } = found;
  // The post in the visitor's language when translated (update 40); the original as written stays a tap away.
  const [texts, newest, assistant] = await Promise.all([
    getShopTexts(shop.slug, lang, found.langs, original, [{ kinds: ["blog_title", "blog_body"], refs: written.id ? [written.id] : [] }]),
    // "Ďalšie novinky": the next older post (or the newest other one) from the blog's first page
    getBlogPage(shop.slug, 1).catch(() => null),
    // "Opýtať sa asistenta" only when the shop's assistant is on
    shopChatEnabled() ? shopHasPlan(shop.id).catch(() => false) : Promise.resolve(false),
  ]);
  const post = written.id
    ? { ...written, title: texts.text("blog_title", written.id, written.title), body: texts.text("blog_body", written.id, written.body) }
    : written;
  const b = dict.blog;
  const base = siteUrl();
  const url = blogUrl(base, lang, place, post.slug);
  const listPath = blogPath(lang, place, onSite);
  const images = post.photos.filter((p) => p.kind === "photo").map((p) => photoSrc(p.large));
  // Photos the text places ([[foto:id]], update 77) are drawn there and left out of the gallery.
  const placed = new Set(post.formatted ? placedPhotos(post.body, post.photos.filter((p) => p.kind === "photo").map((p) => p.id)) : []);
  const textPhotos = post.photos
    .filter((p) => placed.has(p.id))
    .map((p) => ({ id: p.id, small: photoSrc(p.small), large: photoSrc(p.large), width: p.width, height: p.height }));
  const gallery = post.photos.filter((p) => !placed.has(p.id));
  const photoCount = gallery.filter((p) => p.kind === "photo").length;
  let photoN = 0;
  const galleryPhotos = gallery.map((p, i) => {
    if (p.kind === "photo") photoN++;
    return {
      id: p.id,
      kind: p.kind,
      small: photoSrc(p.small),
      large: photoSrc(p.large),
      width: p.width,
      height: p.height,
      link: p.link,
      youtube: p.kind === "video" ? youtubeId(p.link) : null,
      alt: p.kind === "video" ? t(b.video_label, { n: i + 1 }) : photoCount > 1 ? `${post.title} – ${t(b.photo, { n: photoN, total: photoCount })}` : post.title,
    };
  });
  if (galleryPhotos[0]) preload(galleryPhotos[0].small, { as: "image", fetchPriority: "high" });

  // A YouTube video shown in the gallery (update 39) is not repeated as a link card.
  const shownVideos = new Set(post.photos.filter((p) => p.kind === "video").map((p) => youtubeId(p.link)).filter(Boolean));
  const links = post.links.filter((l) => !shownVideos.has(youtubeId(l.url)));
  const others = (newest?.posts ?? []).filter((p) => p.slug !== post.slug);
  const at = (newest?.posts ?? []).findIndex((p) => p.slug === post.slug);
  const nextPost = at >= 0 ? (newest?.posts[at + 1] ?? null) : (others[0] ?? null);
  const nextTitle = nextPost?.id ? texts.text("blog_title", nextPost.id, nextPost.title) : nextPost?.title;
  const minutes = readingMinutes(post.body);
  const shopHref = shopPath(lang, shop, onSite);
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-4" data-unified-page data-blog-article={post.slug}>
      <JsonLd
        data={blogPostingJsonLd({
          post,
          url,
          blogUrl: blogUrl(base, lang, place),
          blogName: t(b.title_of, { name: shop.name }),
          shop: { name: shop.name, url: shopPageUrl(base, shop.slug, shop.country, lang, found.host, shop.site_lang) },
          images,
        })}
      />
      <BackChip href={listPath} label={b.title} aria={t(b.back_to_news, { shop: shop.name })} />
      <header className="flex flex-col gap-2">
        <p className="text-[12px] font-bold tracking-wide text-[#C2410C] uppercase" data-blog-meta>
          <time dateTime={post.publish_at}>{formatDate(post.publish_at, lang, shop.timezone)}</time>
          {" · "}
          {t(b.minutes, { n: String(minutes) })}
          {changed(post) && (
            <>
              {" · "}
              <time dateTime={post.modified_at}>{t(b.edited, { date: formatDate(post.modified_at, lang, shop.timezone) })}</time>
            </>
          )}
        </p>
        <div className="flex items-start gap-2">
          <h1 className="min-w-0 flex-1 text-[28px] leading-tight font-bold break-words">{post.title}</h1>
          <IconCopy kind="text" value={url} label={b.copy_link} done={b.copied_link} refused={dict.item.copy_refused} className="-mt-1 -mr-1.5" />
        </div>
      </header>

      {/* No "Preložené automaticky · Zobraziť originál" on customer pages (2026-11-04, at the owner's request; ?original=1
          still works). While a text is still being translated, the page looks again once, 20 s later. */}
      {texts.missing && <TranslatingRefresh />}
      <PostGallery
        photos={galleryPhotos}
        group={`blog-${post.slug}`}
        title={post.title}
        labels={{ counter: b.counter, show: b.show_photo, video: b.video, play_youtube: b.play_youtube }}
      />
      <BlogText body={post.body} formatted={post.formatted} photos={textPhotos} />

      {links.length > 0 && (
        <ul className="flex flex-col gap-2" data-blog-links>
          {links.map((link) => (
            <li key={link.url}>
              <a href={link.url} target="_blank" rel="noopener" className="flex flex-col gap-1 rounded-[14px] border border-[#ECE7DE] bg-white p-3.5">
                <span className="text-[12px] font-bold tracking-wide text-[#9A3A0A] uppercase">{link.kind === "event" ? b.event : b.link}</span>
                <span className="font-bold break-words">{link.title ?? link.url}</span>
                {link.description && <span className="text-sm text-[#5B6670]">{link.description}</span>}
                <span className="truncate text-sm text-[#C2410C] underline underline-offset-4">{link.url.replace(/^https?:\/\//, "")}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {post.source === "facebook" && post.fb_permalink && (
        <p>
          {/* A plain link: no Facebook script, pixel or embedded widget on public pages. */}
          <a href={post.fb_permalink} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center gap-2 text-[15px] font-semibold underline underline-offset-4" data-facebook-original>
            {b.facebook_original}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
            </svg>
          </a>
        </p>
      )}

      {assistant && (
        <Link
          href={`${shopHref}?${new URLSearchParams({ ask: t(b.ask_prefill, { title: post.title }) })}#assistant`}
          className="flex min-h-[52px] items-center justify-center gap-2.5 rounded-2xl border border-[#ECE7DE] bg-white px-4 text-base font-bold"
          data-blog-ask
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#F57C20]" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" aria-hidden="true" focusable="false">
              <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
            </svg>
          </span>
          {b.ask}
        </Link>
      )}

      {nextPost && (
        <section aria-labelledby="blog-next" className="flex flex-col gap-2" data-blog-next>
          <h2 id="blog-next" className="text-[17px] font-bold">
            {b.more_news}
          </h2>
          <Link href={blogPath(lang, place, onSite, nextPost.slug)} className="flex gap-3.5 rounded-2xl border border-[#ECE7DE] bg-white p-3">
            {nextPost.photos[0] && (
              <span className="h-20 w-20 shrink-0 overflow-hidden rounded-xl">
                {/* eslint-disable-next-line @next/next/no-img-element -- the stored 800 px WebP */}
                <img src={photoSrc(nextPost.photos[0].small)} alt="" width={80} height={80} loading="lazy" decoding="async" className="h-full w-full object-cover" style={{ objectPosition: focusOf(nextPost.photos[0]) }} />
              </span>
            )}
            <span className="flex min-w-0 flex-col items-start gap-1.5 py-0.5">
              <DateChip date={nextPost.publish_at} text={formatDate(nextPost.publish_at, lang, shop.timezone)} />
              <span className="text-[17px] leading-snug font-bold">{nextTitle}</span>
            </span>
          </Link>
        </section>
      )}

      <nav className="flex flex-wrap gap-2.5 pt-1" aria-label={b.title}>
        <Link href={listPath} className="inline-flex min-h-11 items-center rounded-full border border-[#F57C20] bg-white px-4 text-[15px] font-bold" data-blog-all>
          {b.all_posts}
        </Link>
        <Link href={shopHref} className="inline-flex min-h-11 items-center rounded-full border border-[#ECE7DE] bg-white px-4 text-[15px] font-bold" data-blog-shop>
          {b.back_shop}
        </Link>
      </nav>
      {images.length > 0 && (
        <SectionZoom labels={{ close: b.close, zoom_in: b.zoom_in, zoom_out: b.zoom_out, prev_page: b.prev_photo, next_page: b.next_photo }} />
      )}
    </article>
  );
}

export { pageNumber };
