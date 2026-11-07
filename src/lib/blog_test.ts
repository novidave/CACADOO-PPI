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
import { cropLoss, facebookBody, formatBlocks, orientationOf, photoLine, placedPhotos, plainBody, readPhotoLine, rewritePhotoLines } from "./blogMarks.ts";
import { cardExcerpt, readingMinutes } from "./pageContent.ts";
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

// ---------------------------------------------------------------- the safe text format (update 77)

const F1 = "aaaaaaaa-2222-4333-8444-555555555555";
const F2 = "bbbbbbbb-2222-4333-8444-555555555555";

Deno.test("the safe format: each mark as its block, bold inside lines, links and hashtags as before", () => {
  const body = `Úvod s **dôležitým** slovom a www.farby.sk.\n\n## Čo máme\n- biela\n- **čierna** #akcia\n\n1. Príďte\n2. Vyberte\n\n> Najlepšie farby\n> v meste\n\n[[foto:${F1}]]\nKoniec`;
  const blocks = formatBlocks(body, { formatted: true, photoIds: [F1, F2] });
  eq(blocks.map((b) => b.type), ["p", "h2", "ul", "ol", "quote", "photo", "p"], "blocks");
  const intro = blocks[0] as { parts: { type: string; text?: string; bold?: boolean; href?: string }[] };
  eq(intro.parts.map((p) => [p.type, p.text, Boolean(p.bold)]), [["text", "Úvod s ", false], ["text", "dôležitým", true], ["text", " slovom a ", false], ["link", "www.farby.sk", false], ["text", ".", false]], "bold and a link");
  const list = blocks[2] as { items: { type: string; text?: string; bold?: boolean }[][] };
  eq(list.items.length, 2, "two bullets");
  eq(list.items[1].map((p) => [p.type, p.text, Boolean(p.bold)]), [["text", "čierna", true], ["text", " ", false], ["tag", "#akcia", false]], "bold + hashtag");
  eq((blocks[3] as { start: number }).start, 1, "numbered from 1");
  eq((blocks[5] as { id: string }).id, F1, "the photo");
});

Deno.test("the safe format: unknown photo ids are dropped, each photo once; no HTML is ever made", () => {
  const body = `[[foto:${F1}]]\n\n[[foto:${F1}]]\n\n[[foto:99999999-2222-4333-8444-555555555555]]\n\nText [[foto:${F2}]] v riadku\n\n<script>alert(1)</script> <b>x</b>`;
  const blocks = formatBlocks(body, { formatted: true, photoIds: [F1, F2] });
  eq(blocks.filter((b) => b.type === "photo").length, 1, "one photo, once");
  const texts = JSON.stringify(blocks);
  assert(!texts.includes(F2) && texts.includes("Text  v riadku"), "a marker inside a line is no photo");
  assert(texts.includes("<script>alert(1)</script> <b>x</b>"), "HTML stays text (React escapes it)");
  eq(placedPhotos(body, [F1, F2]), [F1], "the gallery leaves out only the placed photo");
});

Deno.test("the safe format: a text without marks reads as before; Facebook's own posts are never formatted", () => {
  const plain = "Prvý odsek\nnový riadok\n\nDruhý odsek s https://x.sk";
  eq(JSON.stringify(formatBlocks(plain, { formatted: true })), JSON.stringify(textBlocks(plain).map((parts) => ({ type: "p", parts }))), "the same paragraphs");
  const fb = "- nie zoznam\n## nie nadpis **nie tučné**";
  const blocks = formatBlocks(fb, { formatted: false });
  eq(blocks.map((b) => b.type), ["p"], "one paragraph as written");
  assert(JSON.stringify(blocks).includes("**nie tučné**") && JSON.stringify(blocks).includes("- nie zoznam"), "marks stay text");
  eq(formatBlocks("a ** b", { formatted: true }).length, 1, "an unpaired ** stays");
  assert(JSON.stringify(formatBlocks("a ** b", { formatted: true })).includes("a ** b"), "as written");
});

Deno.test("every other use gets the text without marks: excerpts, cards, reading time, JSON-LD, Facebook", () => {
  const body = `## Novinky\n- **biela** farba\n> citát\n[[foto:${F1}]]\nKoniec`;
  eq(plainBody(body), "Novinky\nbiela farba\ncitát\n\nKoniec", "plain");
  eq(excerpt(body, 240), "Novinky biela farba citát Koniec", "the blog list / RSS");
  eq(cardExcerpt(body), "Novinky biela farba citát Koniec", "the slider's card");
  eq(cardExcerpt(`Text ${"slovo ".repeat(40)} [[foto:${F1.slice(0, 10)}`).includes("[["), false, "a marker cut short never shows");
  eq(readingMinutes(`[[foto:${F1}]]\n## a`), 1, "reading time counts words only");
  eq(facebookBody(body), "Novinky\n\u2022 biela farba\ncitát\n\nKoniec", "Facebook: bullets, no marks");
  const ld = blogPostingJsonLd({ post: { slug: "a", title: "T", body, source: "cacaduu", publish_at: "2026-11-04T10:00:00Z", modified_at: "2026-11-04T10:00:00Z", fb_permalink: null, links: [], photos: [] } as BlogPost,
    url: "https://x/a", blogUrl: "https://x", blogName: "B", shop: { name: "S", url: "https://x/s" }, images: [] }) as Record<string, unknown>;
  const article = JSON.stringify(ld);
  assert(!article.includes("**") && !article.includes("[[foto") && !article.includes("## "), "JSON-LD articleBody is plain");
});

Deno.test("photo lines with options (2026-11-07): parse, draw, strip, rewrite; anything else is orig", () => {
  const body = `[[foto:${F1}|1:1|hore]]\n\n[[foto:${F2}|16:9]]\n\nKoniec`;
  const blocks = formatBlocks(body, { formatted: true, photoIds: [F1, F2] });
  eq(blocks.filter((b) => b.type === "photo").map((b) => [(b as { ratio: string }).ratio, (b as { crop: string }).crop]), [["1:1", "top"], ["16:9", "center"]], "ratio and crop");
  eq(readPhotoLine(`[[foto:${F1}|7:3|hore]]`), { id: F1, ratio: "orig", crop: "center" }, "an unknown ratio is drawn as orig");
  eq(readPhotoLine(`[[foto:${F1}|4:5|bokom]]`), { id: F1, ratio: "4:5", crop: "center" }, "an unknown crop is stred");
  eq(readPhotoLine(`[[foto:${F1}]]`), { id: F1, ratio: "orig", crop: "center" }, "no options = orig");
  eq(placedPhotos(body, [F1, F2]), [F1, F2], "placed with options too");
  eq(plainBody(body), "Koniec", "stripped from excerpts");
  eq(facebookBody(body), "Koniec", "and from the Facebook message");
  eq(cardExcerpt(`Text [[foto:${F1}|1:1|hore]] a`), "Text a", "the slider's card");
  eq(photoLine(F1, "3:4", "bottom"), `[[foto:${F1}|3:4|dole]]`, "a line with options");
  eq(photoLine(F1, "16:9", "center"), `[[foto:${F1}|16:9]]`, "stred is the default");
  eq(photoLine(F1, "orig", "top"), `[[foto:${F1}]]`, "orig has no crop");
  eq(rewritePhotoLines(`A\n\n[[foto:${F1}]]\n\nB`, F1, { ratio: "1:1", crop: "top" }), `A\n\n[[foto:${F1}|1:1|hore]]\n\nB`, "a line rewritten");
  eq(rewritePhotoLines(`A\n\n[[foto:${F1}|1:1]]\n\nB`, F1, null), "A\n\nB", "removed from the text");
  eq(Math.round(cropLoss(800, 1200, "16:9") * 100), 63, "a portrait photo in 16:9 loses 63 %");
  eq(cropLoss(1600, 900, "16:9"), 0, "nothing for a 16:9 photo");
  eq(cropLoss(800, 1200, "orig"), 0, "orig never crops");
  eq([orientationOf(1600, 900), orientationOf(1000, 1100), orientationOf(800, 1200)], ["landscape", "square", "portrait"], "orientation");
});
