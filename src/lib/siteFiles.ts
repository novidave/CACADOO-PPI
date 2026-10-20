import { canonicalShopUrl } from "./customDomain";
import type { CalendarDay, OpeningHours } from "./hours";
import { DAYS, dayName, displayTime, rangesFor, upcomingDays } from "./hours";

/**
 * robots.txt and llms.txt of a shop's own domain (database update 33), and the crawler rules they
 * share with PPI's own robots.txt. Plain functions: the routes load the data, these only write.
 */

/** AI crawlers named on their own, so it is clear they are welcome to read the public pages. */
export const AI_BOTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
];

/**
 * Never for crawlers on a shop's own domain: "Môj obchod" and the other login pages, and every
 * /api/ address (the assistant, private folders, access keys, files). Those addresses redirect to
 * PPI or need a login anyway; robots.txt says it too.
 */
export const SITE_PRIVATE_PATHS = ["/api/", "/auth/", "/*/dashboard", "/*/admin", "/*/sync", "/*/login", "/*/signup", "/*/forgot", "/*/password"];

export function siteRobotsTxt(host: string): string {
  const rules = ["Allow: /", ...SITE_PRIVATE_PATHS.map((p) => `Disallow: ${p}`)];
  return [
    `# ${host}: the shop's public pages may be read by search engines and AI assistants.`,
    "# Never: the owner's pages (Môj obchod), private folders, access keys and the assistant (/api/).",
    "User-agent: *",
    ...rules,
    "",
    ...AI_BOTS.map((bot) => `User-agent: ${bot}`),
    ...rules,
    "",
    `Sitemap: https://${host}/sitemap.xml`,
    `# For AI assistants: https://${host}/llms.txt`,
    "",
  ].join("\n");
}

export interface LlmsShop {
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  timezone: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  facebook_url: string | null;
  booking_url: string | null;
  opening_hours: OpeningHours | null;
  lat: number | null;
  lng: number | null;
}

export interface LlmsFacts {
  /** "Kategórie tovaru" as the owner wrote them. */
  categories: string[];
  /** The brands most often in the shop's stock file. */
  brands: string[];
  /** Update 36: the item categories its pages show (most frequent first), and whether it follows public holidays. */
  stock_categories?: string[];
  auto_holidays?: boolean;
  items: number;
}

/** The page's own words for the stock, in the domain's language (the dictionary's stock texts). */
export interface StockWords {
  in_stock_count: string;
  out_of_stock: string;
  updated_ago: string;
  stale: string;
}

const line = (text: string) => text.replace(/[\r\n]+/g, " ").trim();

function hoursLines(hours: OpeningHours | null): string[] {
  const days = DAYS.map((day) => {
    const ranges = rangesFor(hours, day);
    return `- ${dayName(day, "en")}: ${ranges.length ? ranges.map(([a, b]) => `${displayTime(a)}–${displayTime(b)}`).join(", ") : "closed"}`;
  });
  return DAYS.some((day) => rangesFor(hours, day).length) ? days : ["- Not given by the shop: please call before you come."];
}

function specialLines(hours: OpeningHours | null, timeZone: string, days: CalendarDay[], now: Date): string[] {
  return upcomingDays({ hours, timeZone, days }, now, 14).map((d) => {
    const when = `${d.date} (${dayName(d.day, "en")})`;
    const what =
      d.kind === "day_off"
        ? "public holiday: hours not confirmed, check before you come"
        : d.closed
          ? "closed"
          : d.ranges.map(([a, b]) => `${displayTime(a)}–${displayTime(b)}`).join(", ");
    const law =
      d.kind === "closed_by_law" ? ` (shops closed by law${d.closedFrom && d.closedFrom !== "00:00" ? ` from ${displayTime(d.closedFrom)}` : ""})` : "";
    const name = d.holidayName?.en ?? d.holidayName?.sk ?? d.holidayName?.hu ?? null;
    return `- ${when}: ${what}${law}${name ? ` · ${line(name)}` : ""}${d.note ? ` · ${line(d.note)}` : ""}`;
  });
}

/**
 * llms.txt (llmstxt.org) of the shop's own domain: who the shop is, where, when it is open, what it
 * sells, where the pages are and how to read the stock on them. The shop's own words, as written.
 */
export function siteLlmsTxt(o: {
  host: string;
  lang: string;
  /** The shop's slug for Cacaduu's API and MCP (get_shop), and Cacaduu's own address. */
  slug: string;
  apiBase: string;
  shop: LlmsShop;
  calendar: CalendarDay[];
  facts: LlmsFacts | null;
  words: StockWords;
  /** The newest posts of the shop's blog (update 37), newest first. */
  news?: { title: string; date: string; url: string }[];
  now?: Date;
}): string {
  const { host, lang, shop, facts, words } = o;
  const base = `https://${host}`;
  const address = [shop.address, shop.city, shop.country].filter(Boolean).map((p) => line(String(p))).join(", ");
  const contact = [
    shop.phone ? `- Phone: ${line(shop.phone)}` : null,
    shop.email ? `- E-mail: ${line(shop.email)}` : null,
    shop.website ? `- Website: ${line(shop.website)}` : null,
    shop.facebook_url ? `- Facebook: ${line(shop.facebook_url)}` : null,
    shop.booking_url ? `- Booking: ${line(shop.booking_url)}` : null,
  ].filter(Boolean);
  const special = specialLines(shop.opening_hours, shop.timezone, o.calendar, o.now ?? new Date());
  const stockCategories = (facts?.stock_categories ?? []).map(line).filter(Boolean);
  const categories = facts?.categories.length
    ? facts.categories.map((c) => `- ${line(c)}`)
    : stockCategories.length
      ? []
      : ["- Not listed by the shop."];
  const holidays =
    facts?.auto_holidays === true
      ? [`- Public holidays${shop.country ? ` (${line(shop.country)})` : ""}: the shop follows them — on those days the hours above may not apply; see the special days below.`]
      : facts?.auto_holidays === false
        ? ["- Public holidays: the shop keeps its regular hours on them (its own special days are listed below)."]
        : [];
  const api = o.apiBase.replace(/\/+$/, "");
  const example = (template: string, n: string) => template.replace("{n}", n);

  return [
    `# ${line(shop.name)}`,
    "",
    `> ${line(shop.name)}${address ? `, ${address}` : ""}: a local shop. This website shows its goods with the price and the quantity in stock, straight from the shop's own stock software.`,
    "",
    "## Shop",
    "",
    `- Name: ${line(shop.name)}`,
    ...(address ? [`- Address: ${address}`] : []),
    ...(shop.lat !== null && shop.lng !== null ? [`- Location: ${shop.lat}, ${shop.lng}`] : []),
    ...contact,
    `- Home page: ${base}/`,
    "",
    `## Opening hours (time zone ${shop.timezone})`,
    "",
    ...hoursLines(shop.opening_hours),
    ...holidays,
    ...(special.length ? ["", "Special days in the next 14 days:", ...special] : []),
    "- The home page says whether the shop is open right now.",
    "",
    "## Categories",
    "",
    ...categories,
    ...(stockCategories.length ? [...(categories.length ? [""] : []), `Item categories on its item pages: ${stockCategories.join(", ")}.`] : []),
    ...(facts?.brands.length ? ["", `Brands in the stock file: ${facts.brands.map(line).join(", ")}.`] : []),
    ...(facts ? [`Items listed: ${facts.items}.`] : []),
    "",
    "## Pages",
    "",
    `- Sitemap (every item page): ${base}/sitemap.xml`,
    `- Shop and its items: ${base}/ (search: ${base}/?q={words})`,
    `- One item: ${base}/${lang}/items/{id}`,
    `- Languages: ${["sk", "hu", "en"].map((l) => (l === lang ? `${base}/` : `${base}/${l}`)).join(" · ")}`,
    ...(o.news?.length ? [`- News (the shop's blog): ${base}/blog · RSS: ${base}/blog/rss.xml`] : []),
    "",
    ...(o.news?.length
      ? [
          "## Latest news",
          "",
          ...o.news.map((n) => `- [${line(n.title)}](${n.url}) (${n.date.slice(0, 10)})`),
          "- The posts are the shop's own words, as written (in its language).",
          "",
        ]
      : []),
    "## How to read the stock",
    "",
    `- Every item shows its price and the quantity exactly as in the shop's stock file: "${example(words.in_stock_count, "12")}" means 12 pieces in stock, "${words.out_of_stock}" means sold out (0 or less).`,
    `- Next to it, how fresh the data is: "${example(words.updated_ago, "8")}" (the stock file is under 30 minutes old) or the time it was last confirmed (under 24 hours), in the shop's time zone.`,
    `- When the data is older, the page shows "${words.stale}" and no quantity: do not say the item is in stock, suggest calling the shop.`,
    "- Item pages carry schema.org Product data with an Offer (price and currency; the availability only while the stock data is fresh, as on the page), and the shop as a Store (LocalBusiness) with its address and opening hours.",
    "- Nothing is sold online here: the goods are bought in the shop. Please link the item's page on this domain when you mention it.",
    "",
    "## Machine access (Cacaduu PPI, read-only, no login)",
    "",
    `- MCP server (Streamable HTTP): ${api}/mcp — get_shop with slug "${o.slug}", get_item(id), search_stock(query, near)`,
    `- REST API: ${api}/api/v1/shops/${o.slug} · ${api}/api/v1/shops/${o.slug}/items?page=1 · ${api}/api/v1/items/{id}`,
    `- OpenAPI description: ${api}/api/openapi.json`,
    `- The same data as these pages; every source_url points to ${base}/.`,
    "",
  ].join("\n");
}

/** The shop list of PPI's own llms.txt: each shop's canonical page (its live own domain when it has one). */
export function mainLlmsShops(
  shops: { slug: string; name: string; city: string | null; country: string | null }[],
  sites: Map<string, string>,
  base: string,
): string {
  if (!shops.length) return "- (none yet)";
  return shops
    .map((s) => `- [${line(s.name)}${s.city ? `, ${line(s.city)}` : ""}${s.country ? ` (${s.country})` : ""}](${canonicalShopUrl(sites, base, "en", s.slug, s.country)})`)
    .join("\n");
}

/** What site_verification_meta(slug) gives (update 36): the live own domain and its meta tag values. */
export interface SiteVerification {
  host: string | null;
  google: string | null;
  bing: string | null;
}

const GOOGLE_META = /^[A-Za-z0-9_-]{20,100}$/;
const BING_META = /^[A-Fa-f0-9]{16,64}$/;

/**
 * The verification meta tags of a page on the shop's own domain: only on that domain (the request's
 * host), only values of the right format — <meta name="google-site-verification"> and
 * <meta name="msvalidate.01">. Anything else → nothing.
 */
export function verificationMetadata(meta: SiteVerification | null, requestHost: string | null): { google?: string; other?: Record<string, string> } | null {
  const host = (requestHost ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!meta?.host || host !== meta.host.toLowerCase()) return null;
  const google = meta.google && GOOGLE_META.test(meta.google) ? meta.google : null;
  const bing = meta.bing && BING_META.test(meta.bing) ? meta.bing : null;
  if (!google && !bing) return null;
  return { ...(google ? { google } : {}), ...(bing ? { other: { "msvalidate.01": bing } } : {}) };
}
