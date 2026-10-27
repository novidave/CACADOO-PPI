import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
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
import { TranslationNote } from "@/components/TranslationNote";
import { getShop, shopSiteHost, type PublicShop } from "@/lib/data";
import { formatDate } from "@/lib/format";
import { shopPageUrl } from "@/lib/jsonLd";
import { siteUrl } from "@/lib/site";
import { lora } from "@/app/fonts";
import { BlogGallery } from "@/components/BlogGallery";
import { BlogPhoto } from "@/components/BlogPhoto";
import { PlayMark } from "@/components/YouTubePlay";
import { youtubeId } from "@/lib/video";
import { BlogText } from "@/components/BlogText";
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

  return (
    <div className={`${lora.variable} mx-auto flex max-w-3xl flex-col gap-6`} data-blog-list>
      <JsonLd
        data={blogJsonLd({
          url: listUrl,
          name: t(b.title_of, { name: shop.name }),
          shop: { name: shop.name, url: shopUrl },
          posts: posts.map((p) => ({ title: p.title, url: blogUrl(base, lang, place, p.slug), publish_at: p.publish_at, modified_at: p.modified_at })),
        })}
      />
      <Breadcrumb dict={dict} items={[{ label: shop.name, href: shopPath(lang, shop, onSite) }, { label: b.title }]} />
      <header className="flex flex-col gap-1">
        <h1 className="ppi-blog-h1">{t(b.title_of, { name: shop.name })}</h1>
        <p className="ppi-blog-nav">
          <Link href={shopPath(lang, shop, onSite)} className="underline underline-offset-4">
            {b.back_shop}
          </Link>
        </p>
      </header>

      {posts.length === 0 ? (
        <p className="ppi-blog-body text-muted">{b.empty}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-line border-y border-line">
          {posts.map((post, index) => {
            const href = blogPath(lang, place, onSite, post.slug);
            const photo = post.photos[0];
            return (
              <li key={post.slug} className="flex flex-col gap-3 py-5 sm:flex-row" data-blog-post={post.slug}>
                {photo && (
                  <Link href={href} className="relative block shrink-0 sm:w-48" tabIndex={-1} aria-hidden>
                    <BlogPhoto large={photoSrc(photo.large)} small={photoSrc(photo.small)} width={photo.width} height={photo.height} shown={192} alt="" className="aspect-[4/3] h-auto w-full border border-line object-cover" preload={index === 0} />
                    {post.photos.some((p) => p.kind === "video") && (
                      <span className="absolute inset-0 flex items-center justify-center" data-blog-list-video>
                        <PlayMark size={44} />
                      </span>
                    )}
                  </Link>
                )}
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 className="ppi-blog-h2">
                    <Link href={href} className="hover:underline">
                      {post.title}
                    </Link>
                  </h2>
                  <p className="ppi-blog-caption text-muted">
                    <time dateTime={post.publish_at}>{t(b.published, { date: formatDate(post.publish_at, lang, shop.timezone) })}</time>
                  </p>
                  {post.body.trim() && <p className="ppi-blog-body break-words">{excerpt(post.body, 240)}</p>}
                  <p className="ppi-blog-nav">
                    <Link href={href} className="underline underline-offset-4">
                      {b.read_more}
                    </Link>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {pages > 1 && (
        <nav className="ppi-blog-nav flex items-center justify-between gap-4" aria-label={t(b.page_of, { page: requested, pages })}>
          {requested > 1 ? (
            <Link href={here(requested - 1)} className="underline underline-offset-4" rel="prev">
              ← {b.newer}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted">{t(b.page_of, { page: requested, pages })}</span>
          {requested < pages ? (
            <Link href={here(requested + 1)} className="underline underline-offset-4" rel="next">
              {b.older} →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}

      <p className="ppi-blog-nav">
        <a href={blogRssUrl(siteUrl(), place)} className="underline underline-offset-4" type="application/rss+xml">
          {b.rss}
        </a>
      </p>
    </div>
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
  const texts = await getShopTexts(shop.slug, lang, found.langs, original, [{ kinds: ["blog_title", "blog_body"], refs: written.id ? [written.id] : [] }]);
  const post = written.id
    ? { ...written, title: texts.text("blog_title", written.id, written.title), body: texts.text("blog_body", written.id, written.body) }
    : written;
  const b = dict.blog;
  const base = siteUrl();
  const url = blogUrl(base, lang, place, post.slug);
  const listPath = blogPath(lang, place, onSite);
  const images = post.photos.filter((p) => p.kind === "photo").map((p) => photoSrc(p.large));

  // A YouTube video shown in the gallery (update 39) is not repeated as a link card.
  const shownVideos = new Set(post.photos.filter((p) => p.kind === "video").map((p) => youtubeId(p.link)).filter(Boolean));
  const links = post.links.filter((l) => !shownVideos.has(youtubeId(l.url)));
  return (
    <article className={`${lora.variable} mx-auto flex max-w-3xl flex-col gap-5`} data-blog-article={post.slug}>
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
      <Breadcrumb dict={dict} items={[{ label: shop.name, href: shopPath(lang, shop, onSite) }, { label: b.title, href: listPath }, { label: post.title }]} />
      <header className="flex flex-col gap-1">
        <h1 className="ppi-blog-h1">{post.title}</h1>
        <p className="ppi-blog-caption text-muted">
          <time dateTime={post.publish_at}>{t(b.published, { date: formatDate(post.publish_at, lang, shop.timezone) })}</time>
          {changed(post) && (
            <>
              {" · "}
              <time dateTime={post.modified_at}>{t(b.updated, { date: formatDate(post.modified_at, lang, shop.timezone) })}</time>
            </>
          )}
        </p>
      </header>

      <TranslationNote texts={texts} path={blogPath(lang, place, onSite, post.slug)} labels={dict.translation} />
      <BlogGallery photos={post.photos} group={`blog-${post.slug}`} title={post.title} src={photoSrc} dict={dict} />
      <BlogText body={post.body} />

      {links.length > 0 && (
        <ul className="flex flex-col gap-2" data-blog-links>
          {links.map((link) => (
            <li key={link.url}>
              <a href={link.url} target="_blank" rel="noopener" className="flex flex-col gap-0.5 border border-line p-3 hover:border-foreground">
                <span className="ppi-blog-caption uppercase tracking-wide text-muted">{link.kind === "event" ? b.event : b.link}</span>
                <span className="font-medium break-words">{link.title ?? link.url}</span>
                {link.description && <span className="ppi-blog-caption text-muted">{link.description}</span>}
                <span className="ppi-blog-caption truncate underline underline-offset-4">{link.url.replace(/^https?:\/\//, "")}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {post.source === "facebook" && post.fb_permalink && (
        <p className="ppi-blog-nav">
          {/* A plain link: no Facebook script, pixel or embedded widget on public pages. */}
          <a href={post.fb_permalink} target="_blank" rel="noopener" className="underline underline-offset-4" data-facebook-original>
            {b.facebook_original}
          </a>
        </p>
      )}

      <p className="ppi-blog-nav flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-4">
        <Link href={listPath} className="underline underline-offset-4">
          {b.all_posts}
        </Link>
        <Link href={shopPath(lang, shop, onSite)} className="underline underline-offset-4">
          {b.back_shop}
        </Link>
      </p>
      {images.length > 0 && (
        <SectionZoom labels={{ close: b.close, zoom_in: b.zoom_in, zoom_out: b.zoom_out, prev_page: b.prev_photo, next_page: b.next_photo }} />
      )}
    </article>
  );
}

function Breadcrumb({ dict, items }: { dict: Dictionary; items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label={dict.blog.breadcrumb} className="ppi-blog-nav text-muted">
      <ol className="flex flex-wrap items-center gap-x-2">
        {items.map((item, i) => (
          <li key={i} className="flex items-center gap-x-2">
            {i > 0 && <span aria-hidden>›</span>}
            {item.href ? (
              <Link href={item.href} className="hover:underline">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-foreground">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export { pageNumber };
