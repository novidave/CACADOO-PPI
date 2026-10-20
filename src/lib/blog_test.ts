// Unit tests (Deno) of the shop blog's shared rules (database update 37): addresses on Cacaduu and on the own domain
// (canonical, hreflang, RSS), the text as written (paragraphs, links, hashtags), excerpts, the Facebook message,
// schema.org BlogPosting + BreadcrumbList, RSS and the llms.txt lines. Run: npm run test:blog
import {
  blogAlternates,
  blogJsonLd,
  blogPath,
  blogPhotoUrl,
  blogPostingJsonLd,
  blogRss,
  blogRssUrl,
  blogUrl,
  excerpt,
  facebookMessage,
  textBlocks,
  type BlogPost,
} from "./blogFormat.ts";
import { localToUtc, utcToLocalInput } from "./format.ts";
import { siteLlmsTxt } from "./siteFiles.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
}

const BASE = "https://cacaduu.com";
const onCacaduu = { shopSlug: "pekaren-anna", country: "SK", host: null };
const onDomain = { shopSlug: "davide", country: "SK", host: "davide.sk" };

Deno.test("Addresses: Cacaduu paths per language; the own domain's '/blog' in the shop's language, '/hu/blog' in the others", () => {
  eq(blogPath("sk", onCacaduu, false), "/sk/shops/pekaren-anna/blog", "list on Cacaduu");
  eq(blogPath("hu", onCacaduu, false, "nova"), "/hu/shops/pekaren-anna/blog/nova", "post on Cacaduu");
  eq(blogPath("sk", onDomain, true), "/blog", "list on the domain");
  eq(blogPath("en", onDomain, true, "nova"), "/en/blog/nova", "post in another language");
  eq(blogUrl(BASE, "sk", onCacaduu, "nova"), "https://cacaduu.com/sk/shops/pekaren-anna/blog/nova", "canonical on Cacaduu");
  eq(blogUrl(BASE, "sk", onDomain, "nova"), "https://davide.sk/blog/nova", "canonical = the own domain once live");
  const alt = blogAlternates(BASE, "hu", onDomain, "nova");
  eq(alt.canonical, "https://davide.sk/hu/blog/nova", "canonical of the Hungarian page");
  eq(alt.languages, { sk: "https://davide.sk/blog/nova", hu: "https://davide.sk/hu/blog/nova", en: "https://davide.sk/en/blog/nova", "x-default": "https://davide.sk/blog/nova" }, "hreflang");
  eq(blogRssUrl(BASE, onDomain), "https://davide.sk/blog/rss.xml", "RSS on the domain");
  eq(blogRssUrl(BASE, { ...onCacaduu, country: "HU" }), "https://cacaduu.com/hu/shops/pekaren-anna/blog/rss.xml", "RSS in the shop's language");
  eq(blogPhotoUrl("https://p.supabase.co/", "a/b/c-800.webp"), "https://p.supabase.co/storage/v1/object/public/blog-photos/a/b/c-800.webp", "photo");
});

Deno.test("The text as written: paragraphs and lines, links clickable (no trailing dot), hashtags kept", () => {
  const blocks = textBlocks("Prvý odsek\ns druhým riadkom.\n\n\nPozrite https://example.com/akcia. A www.davide.sk!\n#jahody #čerstvé (viac na https://sk.wikipedia.org/wiki/Jahoda_(rod))");
  eq(blocks.length, 2, "two paragraphs");
  eq(blocks[0], [{ type: "text", text: "Prvý odsek" }, { type: "br" }, { type: "text", text: "s druhým riadkom." }], "a line break inside");
  const second = blocks[1];
  const links = second.filter((p) => p.type === "link");
  eq(links, [
    { type: "link", href: "https://example.com/akcia", text: "https://example.com/akcia" },
    { type: "link", href: "https://www.davide.sk", text: "www.davide.sk" },
    { type: "link", href: "https://sk.wikipedia.org/wiki/Jahoda_(rod)", text: "https://sk.wikipedia.org/wiki/Jahoda_(rod)" },
  ], "links, the dot and the closing bracket of the sentence outside");
  eq(second.filter((p) => p.type === "tag").map((p) => (p as { text: string }).text), ["#jahody", "#čerstvé"], "hashtags with accents");
  const joined = second.map((p) => (p.type === "br" ? "\n" : (p as { text: string }).text)).join("");
  eq(joined, "Pozrite https://example.com/akcia. A www.davide.sk!\n#jahody #čerstvé (viac na https://sk.wikipedia.org/wiki/Jahoda_(rod))", "nothing added, nothing left out");
  eq(textBlocks("  \n\n "), [], "no text");
  eq(textBlocks("Cena 5 €#1"), [[{ type: "text", text: "Cena 5 €#1" }]], "a # inside a word is no hashtag");
});

Deno.test("Excerpts cut at a word; the Facebook message ends with 'Čítať na webe: <address>'", () => {
  eq(excerpt("Krátky text.", 240), "Krátky text.", "short");
  const e = excerpt("slovo ".repeat(100), 50);
  assert(e.endsWith("…") && [...e].length <= 50 && !e.includes("slovo…") === false, e);
  eq(excerpt("Riadok\n\nďalší   riadok", 100), "Riadok ďalší riadok", "spaces as one");
  eq(facebookMessage("Titul", "Text  \n", "https://davide.sk/blog/titul"), "Text\n\nČítať na webe: https://davide.sk/blog/titul", "text + link");
  eq(facebookMessage("Titul", "", "https://x.sk/blog/t"), "Titul\n\nČítať na webe: https://x.sk/blog/t", "no text: the title");
});

const POST: BlogPost = {
  slug: "nova-kolekcia",
  title: "Nová kolekcia",
  body: "Prišla nová kolekcia.",
  source: "facebook",
  publish_at: "2026-10-12T08:30:00Z",
  modified_at: "2026-10-13T10:00:00Z",
  fb_permalink: "https://www.facebook.com/123/posts/456",
  links: [],
  photos: [],
};

Deno.test("schema.org: BlogPosting with the shop as LocalBusiness author and publisher, and the BreadcrumbList", () => {
  const ld = blogPostingJsonLd({
    post: POST,
    url: "https://davide.sk/blog/nova-kolekcia",
    blogUrl: "https://davide.sk/blog",
    blogName: "Novinky – Davide",
    shop: { name: "Davide", url: "https://davide.sk/" },
    images: ["https://p.supabase.co/storage/v1/object/public/blog-photos/a-1600.webp"],
  });
  const [posting, crumbs] = ld["@graph"] as Record<string, unknown>[];
  eq(posting["@type"], "BlogPosting", "type");
  eq([posting.headline, posting.datePublished, posting.dateModified, posting.url], ["Nová kolekcia", "2026-10-12T08:30:00Z", "2026-10-13T10:00:00Z", "https://davide.sk/blog/nova-kolekcia"], "fields");
  eq(posting.author, { "@type": "LocalBusiness", "@id": "https://davide.sk/", name: "Davide", url: "https://davide.sk/" }, "author = the shop");
  eq(posting.publisher, posting.author, "publisher = the shop");
  eq(posting.image, ["https://p.supabase.co/storage/v1/object/public/blog-photos/a-1600.webp"], "image");
  eq(posting.sameAs, ["https://www.facebook.com/123/posts/456"], "the original on Facebook");
  eq((crumbs.itemListElement as { name: string; item: string }[]).map((i) => [i.name, i.item]), [
    ["Davide", "https://davide.sk/"],
    ["Novinky – Davide", "https://davide.sk/blog"],
    ["Nová kolekcia", "https://davide.sk/blog/nova-kolekcia"],
  ], "shop › Novinky › post");
  const list = blogJsonLd({ url: "https://davide.sk/blog", name: "Novinky", shop: { name: "Davide", url: "https://davide.sk/" }, posts: [{ title: "A", url: "u", publish_at: "p", modified_at: "m" }] });
  eq(((list["@graph"] as Record<string, unknown>[])[0].blogPost as unknown[]).length, 1, "Blog with its posts");
});

Deno.test("RSS 2.0: the posts with their address, date, text (escaped) and first photo", () => {
  const xml = blogRss({
    title: "Novinky – Pekáreň & spol.",
    link: "https://cacaduu.com/sk/shops/p/blog",
    self: "https://cacaduu.com/sk/shops/p/blog/rss.xml",
    description: "Novinky",
    lang: "sk",
    items: [{ title: "<Akcia>", url: "https://cacaduu.com/sk/shops/p/blog/akcia", date: "2026-10-12T08:30:00Z", text: "Zľava 20 % & viac", image: "https://x/a-1600.webp" }],
  });
  assert(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>') && xml.includes('<rss version="2.0"'), "RSS 2.0");
  assert(xml.includes("<title>Novinky – Pekáreň &amp; spol.</title>") && xml.includes("<title>&lt;Akcia&gt;</title>"), "escaped");
  assert(xml.includes('<atom:link href="https://cacaduu.com/sk/shops/p/blog/rss.xml" rel="self"'), "self link");
  assert(xml.includes("<pubDate>Mon, 12 Oct 2026 08:30:00 GMT</pubDate>"), "date");
  assert(xml.includes('<enclosure url="https://x/a-1600.webp" type="image/webp"'), "first photo");
});

Deno.test("Scheduling: the owner's time in the shop's time zone (summer and winter time) ↔ UTC", () => {
  eq(localToUtc("2026-07-01T10:00", "Europe/Bratislava")?.toISOString(), "2026-07-01T08:00:00.000Z", "summer");
  eq(localToUtc("2026-12-01T10:00", "Europe/Bratislava")?.toISOString(), "2026-12-01T09:00:00.000Z", "winter");
  eq(localToUtc("2026-10-25T02:30", "Europe/Budapest")?.toISOString().slice(0, 13), "2026-10-25T01", "the night the clocks go back");
  eq(utcToLocalInput("2026-12-01T09:00:00Z", "Europe/Bratislava"), "2026-12-01T10:00", "back");
  eq(localToUtc("tomorrow", "Europe/Bratislava"), null, "not a time");
});

Deno.test("llms.txt of the own domain: the newest posts and the RSS", () => {
  const text = siteLlmsTxt({
    host: "davide.sk",
    lang: "sk",
    slug: "davide",
    apiBase: BASE,
    shop: { name: "Davide", address: null, city: "Košice", country: "SK", timezone: "Europe/Bratislava", phone: null, email: null, website: null, facebook_url: null, booking_url: null, opening_hours: null, lat: null, lng: null },
    calendar: [],
    facts: null,
    words: { in_stock_count: "{n} ks", out_of_stock: "Vypredané", updated_ago: "pred {n} min", stale: "?" },
    news: [{ title: "Nová kolekcia", date: "2026-10-12T08:30:00Z", url: "https://davide.sk/blog/nova-kolekcia" }],
  });
  assert(text.includes("- News (the shop's blog): https://davide.sk/blog · RSS: https://davide.sk/blog/rss.xml"), "the blog and its feed");
  assert(text.includes("## Latest news\n\n- [Nová kolekcia](https://davide.sk/blog/nova-kolekcia) (2026-10-12)"), "the newest posts");
  const none = siteLlmsTxt({
    host: "davide.sk", lang: "sk", slug: "davide", apiBase: BASE,
    shop: { name: "Davide", address: null, city: null, country: "SK", timezone: "UTC", phone: null, email: null, website: null, facebook_url: null, booking_url: null, opening_hours: null, lat: null, lng: null },
    calendar: [], facts: null, words: { in_stock_count: "{n}", out_of_stock: "x", updated_ago: "{n}", stale: "?" },
  });
  assert(!none.includes("Latest news"), "nothing without posts");
});
