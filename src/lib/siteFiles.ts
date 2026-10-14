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
  shop: LlmsShop;
  calendar: CalendarDay[];
  facts: LlmsFacts | null;
  words: StockWords;
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
  const categories = facts?.categories.length ? facts.categories.map((c) => `- ${line(c)}`) : ["- Not listed by the shop."];
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
    ...(special.length ? ["", "Special days in the next 14 days:", ...special] : []),
    "- The home page says whether the shop is open right now.",
    "",
    "## Categories",
    "",
    ...categories,
    ...(facts?.brands.length ? ["", `Brands in the stock file: ${facts.brands.map(line).join(", ")}.`] : []),
    ...(facts ? [`Items listed: ${facts.items}.`] : []),
    "",
    "## Pages",
    "",
    `- Sitemap (every item page): ${base}/sitemap.xml`,
    `- Shop and its items: ${base}/ (search: ${base}/?q={words})`,
    `- One item: ${base}/${lang}/items/{id}`,
    `- Languages: ${["sk", "hu", "en"].map((l) => (l === lang ? `${base}/` : `${base}/${l}`)).join(" · ")}`,
    "",
    "## How to read the stock",
    "",
    `- Every item shows its price and the quantity exactly as in the shop's stock file: "${example(words.in_stock_count, "12")}" means 12 pieces in stock, "${words.out_of_stock}" means sold out (0 or less).`,
    `- Next to it, how fresh the data is: "${example(words.updated_ago, "8")}" (the stock file is under 30 minutes old) or the time it was last confirmed (under 24 hours), in the shop's time zone.`,
    `- When the data is older, the page shows "${words.stale}" and no quantity: do not say the item is in stock, suggest calling the shop.`,
    "- Item pages carry schema.org Product data with an Offer (price, currency, availability) only while the stock data is fresh, and the shop as a Store (LocalBusiness) with its address and opening hours.",
    "- Nothing is sold online here: the goods are bought in the shop. Please link the item's page on this domain when you mention it.",
    "",
  ].join("\n");
}
