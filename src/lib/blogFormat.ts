import { siteLang } from "./customDomain";

/**
 * The shop's blog ("Novinky", database update 37): its addresses, the text of a post as written (paragraphs, links
 * and hashtags kept), the Facebook preview's text, schema.org data and RSS. Plain functions: the pages pass the data.
 */

export const BLOG_PER_PAGE = 12;
export const READ_ON_WEB = "Čítať na webe:";
const LANGS = ["sk", "hu", "en"] as const;

export interface BlogPhoto {
  id: string;
  kind: "photo" | "video";
  large: string;
  small: string;
  width: number | null;
  height: number | null;
  small_width: number | null;
  small_height: number | null;
  /** A video stays on Facebook: its picture links there. */
  link: string | null;
}

export interface BlogLink {
  kind: "link" | "event";
  url: string;
  title: string | null;
  description: string | null;
}

export interface BlogPost {
  slug: string;
  title: string;
  body: string;
  source: "cacaduu" | "facebook";
  publish_at: string;
  modified_at: string;
  fb_permalink: string | null;
  links: BlogLink[];
  photos: BlogPhoto[];
}

export interface BlogPage {
  total: number;
  page: number;
  per_page: number;
  posts: BlogPost[];
}

// ---------------------------------------------------------------- addresses

/** Where the shop's blog lives: its live own domain (host, its language at "/"), else its Cacaduu page. */
export interface BlogPlace {
  shopSlug: string;
  country: string | null;
  host: string | null;
}

/** A path on the address the visitor is on: "/blog/x" or "/hu/blog/x" on the own domain, "/sk/shops/s/blog/x" on Cacaduu. */
export function blogPath(lang: string, place: BlogPlace, onSite: boolean, postSlug?: string): string {
  const tail = `/blog${postSlug ? `/${postSlug}` : ""}`;
  if (onSite) return `${lang === siteLang(place.country) ? "" : `/${lang}`}${tail}`;
  return `/${lang}/shops/${place.shopSlug}${tail}`;
}

/** The canonical address: on the live own domain when there is one, else on Cacaduu (`base` = its address). */
export function blogUrl(base: string, lang: string, place: BlogPlace, postSlug?: string): string {
  if (place.host) return `https://${place.host}${blogPath(lang, place, true, postSlug)}`;
  return `${base.replace(/\/+$/, "")}${blogPath(lang, place, false, postSlug)}`;
}

/** canonical + hreflang (sk, hu, en, and x-default = the shop's language) of a blog page. */
export function blogAlternates(base: string, lang: string, place: BlogPlace, postSlug?: string) {
  const home = siteLang(place.country);
  return {
    canonical: blogUrl(base, lang, place, postSlug),
    languages: {
      ...Object.fromEntries(LANGS.map((l) => [l, blogUrl(base, l, place, postSlug)])),
      "x-default": blogUrl(base, home, place, postSlug),
    },
  };
}

/** The shop's RSS feed: /blog/rss.xml on the own domain, else on Cacaduu in the shop's language. */
export function blogRssUrl(base: string, place: BlogPlace): string {
  if (place.host) return `https://${place.host}/blog/rss.xml`;
  return `${base.replace(/\/+$/, "")}/${siteLang(place.country)}/shops/${place.shopSlug}/blog/rss.xml`;
}

/** A photo in the public bucket "blog-photos". */
export function blogPhotoUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/blog-photos/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// ---------------------------------------------------------------- the text, as written

export type Inline = { type: "text"; text: string } | { type: "link"; href: string; text: string } | { type: "tag"; text: string } | { type: "br" };

const URL_OR_TAG = /(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+\.[^\s<>"]+)|(^|[\s(])(#[\p{L}\p{N}_]+)/gu;
const TRAILING = /[.,;:!?…'"»”)\]]+$/u;

function inline(line: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  const text = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.type === "text") last.text += t;
    else out.push({ type: "text", text: t });
  };
  for (const m of line.matchAll(URL_OR_TAG)) {
    const start = m.index ?? 0;
    if (m[1]) {
      // ".", "," or ")" right after a link belong to the sentence; a ")" closing a "(" of the link stays in it
      let tail = TRAILING.exec(m[1])?.[0] ?? "";
      let url = m[1].slice(0, m[1].length - tail.length);
      const count = (s: string, c: string) => s.split(c).length - 1;
      while (tail.startsWith(")") && count(url, "(") > count(url, ")")) {
        url += ")";
        tail = tail.slice(1);
      }
      text(line.slice(at, start));
      out.push({ type: "link", href: url.startsWith("www.") ? `https://${url}` : url, text: url });
      text(tail);
    } else {
      text(line.slice(at, start) + m[2]);
      out.push({ type: "tag", text: m[3] });
    }
    at = start + m[0].length;
  }
  text(line.slice(at));
  return out;
}

/** Paragraphs (an empty line between them) of lines; links and hashtags marked, nothing else changed. */
export function textBlocks(body: string): Inline[][] {
  return body
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.trim().length > 0)
    .map((p) => p.split("\n").flatMap((line, i) => [...(i ? [{ type: "br" } as Inline] : []), ...inline(line)]));
}

/** The beginning of a text for lists and descriptions: whole words, "…" when cut. */
export function excerpt(body: string, max = 240): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/u, "")}…`;
}

/** The post on Facebook (the same text as the shop-blog function sends): its text, then "Čítať na webe: <address>". */
export function facebookMessage(title: string, body: string, url: string): string {
  const text = body.trim() ? body.replace(/\s+$/u, "") : title.trim();
  return `${text}\n\n${READ_ON_WEB} ${url}`;
}

// ---------------------------------------------------------------- schema.org

export interface BlogJsonLdShop {
  name: string;
  /** The shop's canonical page. */
  url: string;
}

const business = (shop: BlogJsonLdShop) => ({ "@type": "LocalBusiness", "@id": shop.url, name: shop.name, url: shop.url });

function breadcrumb(items: { name: string; url: string }[]) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({ "@type": "ListItem", position: i + 1, name: item.name, item: item.url })),
  };
}

/** A post's page: the BlogPosting (the shop is its author and publisher) and the way to it (shop › Novinky › post). */
export function blogPostingJsonLd(o: {
  post: BlogPost;
  url: string;
  blogUrl: string;
  blogName: string;
  shop: BlogJsonLdShop;
  images: string[];
}) {
  const { post } = o;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        "@id": o.url,
        headline: post.title,
        url: o.url,
        mainEntityOfPage: o.url,
        datePublished: post.publish_at,
        dateModified: post.modified_at || post.publish_at,
        ...(o.images.length ? { image: o.images } : {}),
        ...(post.body.trim() ? { articleBody: post.body } : {}),
        author: business(o.shop),
        publisher: business(o.shop),
        isPartOf: { "@type": "Blog", "@id": o.blogUrl, name: o.blogName },
        ...(post.fb_permalink ? { sameAs: [post.fb_permalink] } : {}),
      },
      breadcrumb([
        { name: o.shop.name, url: o.shop.url },
        { name: o.blogName, url: o.blogUrl },
        { name: post.title, url: o.url },
      ]),
    ],
  };
}

/** The blog's page: the Blog with its posts on this page, and the way to it (shop › Novinky). */
export function blogJsonLd(o: { url: string; name: string; shop: BlogJsonLdShop; posts: { title: string; url: string; publish_at: string; modified_at: string }[] }) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Blog",
        "@id": o.url,
        name: o.name,
        url: o.url,
        publisher: business(o.shop),
        blogPost: o.posts.map((p) => ({ "@type": "BlogPosting", headline: p.title, url: p.url, datePublished: p.publish_at, dateModified: p.modified_at })),
      },
      breadcrumb([
        { name: o.shop.name, url: o.shop.url },
        { name: o.name, url: o.url },
      ]),
    ],
  };
}

// ---------------------------------------------------------------- RSS

const xml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/** RSS 2.0 of the shop's newest posts: title, address, date, the text as written and the first photo. */
export function blogRss(o: {
  title: string;
  link: string;
  self: string;
  description: string;
  lang: string;
  items: { title: string; url: string; date: string; text: string; image: string | null }[];
}): string {
  const items = o.items.map((i) =>
    [
      "<item>",
      `<title>${xml(i.title)}</title>`,
      `<link>${xml(i.url)}</link>`,
      `<guid isPermaLink="true">${xml(i.url)}</guid>`,
      `<pubDate>${new Date(i.date).toUTCString()}</pubDate>`,
      `<description>${xml(i.text)}</description>`,
      ...(i.image ? [`<enclosure url="${xml(i.image)}" type="${i.image.endsWith(".jpg") ? "image/jpeg" : "image/webp"}" length="0"/>`] : []),
      "</item>",
    ].join(""),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "<channel>",
    `<title>${xml(o.title)}</title>`,
    `<link>${xml(o.link)}</link>`,
    `<atom:link href="${xml(o.self)}" rel="self" type="application/rss+xml"/>`,
    `<description>${xml(o.description)}</description>`,
    `<language>${xml(o.lang)}</language>`,
    ...(o.items[0] ? [`<lastBuildDate>${new Date(o.items[0].date).toUTCString()}</lastBuildDate>`] : []),
    ...items,
    "</channel>",
    "</rss>",
    "",
  ].join("\n");
}
