import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { siteLang, sitePath, siteShopUrl } from "@/lib/customDomain";
import { getShop, getShopCalendars, getShopItems, shopHasPlan, shopperPdfAllowed, shopSiteHost, shopStockResetting, type PublicShop } from "@/lib/data";
import { archiveEnabled } from "@/lib/assistantArchive";
import { blogCount } from "@/lib/blog";
import { blogPath } from "@/lib/blogFormat";
import { docsKeysEnabled } from "@/lib/docsAccess";
import { addressLine, directionsUrl, formatPrice } from "@/lib/format";
import { translatedName } from "@/lib/names";
import {
  DAYS,
  dayName,
  displayTime,
  hasHours,
  localDateTime,
  rangesFor,
  type StatusInput,
  upcomingDays,
  weekdayOf,
} from "@/lib/hours";
import { requestTime } from "@/lib/requestTime";
import { statusInput } from "@/lib/shopCalendar";
import { shopChatEnabled } from "@/lib/shopChat";
import { storeJsonLd } from "@/lib/jsonLd";
import { pageAlternates, siteUrl } from "@/lib/site";
import { getShopContent, slideViews } from "@/lib/sections";
import { getShopLanguages } from "@/lib/shopLanguages";
import { getShopTexts } from "@/lib/contentTranslations";
import { TranslationNote } from "@/components/TranslationNote";
import { freshnessText } from "@/lib/stock";
import { ContactLinks } from "@/components/ContactLinks";
import { JsonLd } from "@/components/JsonLd";
import { ContentSlider } from "@/components/ContentSlider";
import { SectionZoom } from "@/components/SectionZoom";
import { ShopAssistant } from "@/components/ShopAssistant";
import { ShopMap } from "@/components/ShopMap";
import { LiveStatus } from "@/components/ShopStatus";
import { StockLine } from "@/components/StockLine";

const PAGE_SIZE = 50;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The canonical address: the shop's own domain once it is live (database update 25), on the
 * Cacaduu address and on the domain alike; else the Cacaduu address.
 */
function alternates(shop: PublicShop, lang: Locale, host: string | null, locales: readonly string[]) {
  if (!host) return pageAlternates(lang, `/shops/${shop.slug}`, locales);
  const defaultLang = siteLang(shop.country, shop.site_lang);
  return {
    canonical: siteShopUrl(host, lang, defaultLang),
    languages: {
      ...Object.fromEntries(locales.map((l) => [l, siteShopUrl(host, l, defaultLang)])),
      // The domain's own language for everyone else.
      "x-default": siteShopUrl(host, defaultLang, defaultLang),
    },
  };
}

export async function shopMetadata(lang: Locale, slug: string): Promise<Metadata> {
  const [dict, shop] = await Promise.all([getDictionary(lang), getShop(slug).catch(() => null)]);
  if (!shop) return {};
  const [host, langs] = await Promise.all([shopSiteHost(shop.slug).catch(() => null), getShopLanguages(shop.slug, shop.country)]);
  return {
    title: addressLine(shop.name, shop.city),
    description: t(dict.shop.meta_description, { name: shop.name, city: shop.city ?? "" }),
    // hreflang only for the shop's pre-translated languages; the others are translated on the first visit: noindex.
    alternates: alternates(shop, lang, host, langs.indexed),
    // The shop decides (its pre-translated languages), over the site-wide rule of the [lang] layout.
    robots: { index: langs.indexed.includes(lang), follow: true },
  };
}

/**
 * The shop's page: on its Cacaduu address, or on its own domain (onSite: under the domain's own
 * header with its picture; the links stay on the domain, "/" is the shop's language). Both say
 * the same and point to one canonical. Order: name and logo with the shop's details, map with the
 * status dot, opening hours (status line, today, breaks, the coming special days), "Obsah stránky" (update 38: ONE
 * slider of blog posts, PDFs and pictures in the owner's order), then — with the paid plan — the assistant (always
 * open) and "Mám prístupový kľúč", then the items (a free page: the slider right before the items).
 */
export async function ShopView({ lang, slug, sp, onSite }: { lang: Locale; slug: string; sp: SearchParams; onSite: boolean }) {
  const [dict, shop] = await Promise.all([getDictionary(lang), getShop(slug)]);
  if (!shop) notFound();
  const defaultLang = siteLang(shop.country, shop.site_lang);

  const q = (first(sp.q) ?? "").trim();
  const requestedPage = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  // Everything that needs only the shop, at once (no waterfall). The AI assistant is a paid feature: shown only when
  // the database says the shop has the plan.
  const [host, langs, { items, total }, assistant, shopperPdf, calendars, content, posts] = await Promise.all([
    shopSiteHost(shop.slug).catch(() => null),
    getShopLanguages(shop.slug, shop.country),
    getShopItems(shop.slug, q, requestedPage, PAGE_SIZE),
    shopChatEnabled() ? shopHasPlan(shop.id) : Promise.resolve(false),
    // "Stiahnuť túto konverzáciu (PDF)" (database update 24): only with the archive on.
    archiveEnabled() ? shopperPdfAllowed(shop.slug).catch(() => false) : Promise.resolve(false),
    // Special days and holidays (database update 27): the status and the next 60 days.
    getShopCalendars([shop.id], 60).catch(() => new Map()),
    // "Obsah stránky" (database update 38): the slides the database shows (none before it).
    getShopContent(shop.slug).catch(() => null),
    // The blog (database update 37): "Novinky" only with at least one post shown.
    blogCount(shop.slug).catch(() => 0),
  ]);
  if (onSite && !host) notFound();
  // No products at all after "Vymazať celý sklad" (update 43): "Sortiment sa práve aktualizuje" until the next file.
  const resetting = items.length === 0 && !q ? await shopStockResetting(shop.slug).catch(() => false) : false;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  // The shop's texts in the visitor's language (update 40): the original stays; "Zobraziť originál" = ?original=1.
  const original = first(sp.original) === "1";
  const postIds = (content?.slides ?? []).flatMap((s) => (s.kind === "post" ? [s.post.id] : []));
  const texts = await getShopTexts(shop.slug, lang, langs, original, [
    { kinds: ["assistant_label", "assistant_welcome", "special_note", "content_title", "section_title", "section_alt"] },
    { kinds: ["blog_title", "blog_body"], refs: postIds },
  ]);
  const shopPath = onSite ? sitePath(lang, defaultLang) : `/${lang}/shops/${shop.slug}`;
  const pageUrl = (n: number) => `${shopPath}?${new URLSearchParams({ ...(q ? { q } : {}), page: String(n) })}`;

  const address = addressLine(shop.address, shop.city);
  const hasLocation = shop.lat !== null && shop.lng !== null;
  const input = statusInput(shop, calendars);
  const renderedAt = requestTime();
  const place = { shopSlug: shop.slug, country: shop.country, host, homeLang: shop.site_lang };
  const slides = content ? slideViews(content, { shopId: shop.id, slug: shop.slug, lang, timeZone: shop.timezone, place, onSite, texts }) : [];
  const contentTitle = texts.text("content_title", shop.id, content?.title ?? null);
  const assistantLabel = texts.text("assistant_label", shop.id, shop.assistant_label);
  const assistantWelcome = texts.text("assistant_welcome", shop.id, shop.assistant_welcome);
  const notes = new Map(upcomingDays(input, new Date(renderedAt), 14).flatMap((d) => (d.note ? [[d.date, texts.text("special_note", d.date, d.note)] as const] : [])));
  const newsHref = blogPath(lang, place, onSite);
  // "Všetky novinky" under the slider when the shop has posts; else the "Novinky" link in the details (never both).
  const sliderNews = slides.length > 0 && Boolean(content?.has_posts);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <JsonLd data={{ "@context": "https://schema.org", ...storeJsonLd(shop, lang, host, input, siteUrl()) }} />

      {/* 1. The shop's name and logo, its details under them (on its own domain too). */}
      <header className="flex flex-col gap-2" data-shop-details>
        <div className="flex items-center gap-3">
          {shop.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element -- logos come from Supabase Storage
            <img src={shop.logo_url} alt="" width={48} height={48} className="h-12 w-12 border border-line object-contain" />
          )}
          <h1 className="text-2xl font-semibold tracking-tight">{shop.name}</h1>
        </div>
        {address && <p>{address}</p>}
        {(shop.has_toilet || shop.has_douchette) && (
          <p className="text-sm">
            <span className="text-muted">{dict.shop.facilities}: </span>
            <span className="font-semibold">
              {[shop.has_toilet && dict.shop.toilet, shop.has_douchette && dict.shop.douchette].filter(Boolean).join(" · ")}
            </span>
          </p>
        )}
        {shop.has_card_terminal && <p className="text-sm font-semibold">{dict.shop.card_terminal}</p>}
        {/* Two columns on phones: where a link sits never depends on the letters' widths, so nothing moves when
            Quicksand replaces the fallback font (one wrapping row re-wrapped and pushed the page down). */}
        <p className="grid grid-cols-2 items-start gap-x-4 gap-y-1 text-sm sm:flex sm:flex-wrap" data-shop-contacts>
          {hasLocation && (
            <a href={directionsUrl(shop.lat!, shop.lng!)} className="underline underline-offset-4" target="_blank" rel="noopener">
              {dict.shop.directions}
            </a>
          )}
          {shop.phone && (
            <a href={`tel:${shop.phone.replace(/\s+/g, "")}`} className="underline underline-offset-4">
              {shop.phone}
            </a>
          )}
          {shop.website && (
            <a href={shop.website} className="underline underline-offset-4" target="_blank" rel="noopener">
              {dict.shop.website}
            </a>
          )}
          <ContactLinks
            email={shop.email}
            facebookUrl={shop.facebook_url}
            facebookLabel={dict.shop.facebook}
            bookingUrl={shop.booking_url}
            bookingLabel={dict.shop.booking}
          />
          {posts > 0 && !sliderNews && (
            <Link href={newsHref} className="underline underline-offset-4" data-shop-news>
              {dict.shop.news}
            </Link>
          )}
        </p>
      </header>

      <TranslationNote texts={texts} path={shopPath} query={{ ...(q ? { q } : {}), ...(page > 1 ? { page: String(page) } : {}) }} labels={dict.translation} />

      {/* 2. The map with the shop's status dot (an extra: the page works without it). */}
      {hasLocation && (
        <ShopMap
          shops={[{ slug: shop.slug, name: shop.name, lat: shop.lat!, lng: shop.lng!, href: shopPath, status: input }]}
          label={dict.shop.map}
          className="h-56 md:h-72"
          statusLabels={dict.status}
          renderedAt={renderedAt}
        />
      )}

      {/* 3. Opening hours: status line, the week (today marked, breaks in the row), the coming special days. */}
      <HoursSection shop={shop} input={input} lang={lang} dict={dict} renderedAt={renderedAt} notes={notes} />

      {/* "Obsah stránky" (update 38): after the opening hours, before the assistant (a free page: before the items). */}
      {slides.length > 0 && content && (
        <ContentSlider
          views={slides}
          title={contentTitle ?? dict.content.default_title}
          showTitle={content.show_title}
          display={content.display}
          allNews={sliderNews ? newsHref : null}
          labels={dict.content}
          lang={lang}
        />
      )}

      {/* 4. and 5. The assistant (paid plan): always open; "Mám prístupový kľúč" as a closed dropdown under it. */}
      {assistant && (
        <ShopAssistant
          slug={shop.slug}
          lang={lang}
          shopName={shop.name}
          timeZone={shop.timezone}
          keys={docsKeysEnabled()}
          labels={dict.chat}
          buttonLabel={assistantLabel}
          welcome={assistantWelcome}
          archive={archiveEnabled()}
          shopperPdf={shopperPdf}
        />
      )}

      {/* 6. The items. */}
      <section className="flex flex-col gap-3" aria-labelledby="items-heading">
        <h2 id="items-heading" className="text-lg font-semibold">
          {dict.shop.items}
        </h2>
        <p className="text-sm">
          <span className="text-muted">{dict.shop.stock}: </span>
          {freshnessText(dict, shop.freshness_state, shop.freshness_age_minutes, shop.latest_file_time, shop.timezone)}
        </p>
        <form method="get" className="flex gap-2" role="search">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder={dict.shop.search_items}
            aria-label={dict.shop.search_items}
            className="min-w-0 flex-1 rounded border border-line px-3 py-2 outline-none focus:border-foreground"
          />
          <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium">
            {dict.search.button}
          </button>
        </form>

        {items.length === 0 ? (
          <p data-stock-note={resetting ? "updating" : "none"}>{resetting ? dict.shop.stock_updating : dict.shop.no_items}</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {items.map((item) => {
              const translated = translatedName(item.item_name, item.item_name_i18n, lang);
              return (
                <li key={item.item_id} className="flex flex-col gap-1 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/${lang}/items/${item.item_id}`} className="font-medium hover:underline">
                        {item.item_name}
                      </Link>
                      {translated && <p className="text-sm text-muted">{translated}</p>}
                    </div>
                    <span className="whitespace-nowrap font-medium">{formatPrice(item.price, lang, item.currency)}</span>
                  </div>
                  <div className="text-sm">
                    <StockLine row={item} timeZone={shop.timezone} dict={dict} lang={lang} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {pages > 1 && (
          <nav className="flex items-center justify-between text-sm" aria-label={t(dict.shop.page_of, { page, pages })}>
            {page > 1 ? (
              <a href={pageUrl(page - 1)} className="underline underline-offset-4">
                {dict.shop.prev}
              </a>
            ) : (
              <span />
            )}
            <span className="text-muted">{t(dict.shop.page_of, { page, pages })}</span>
            {page < pages ? (
              <a href={pageUrl(page + 1)} className="underline underline-offset-4">
                {dict.shop.next}
              </a>
            ) : (
              <span />
            )}
          </nav>
        )}
      </section>

      {slides.some((v) => v.kind !== "post") && <SectionZoom labels={dict.sections} />}
    </div>
  );
}

/** "8:00–12:00, 12:30–17:00" (a range past midnight: "22:00–2:00"). */
const rangeText = (ranges: [string, string][]) => ranges.map(([a, b]) => `${displayTime(a)}–${displayTime(b)}`).join(", ");

function HoursSection({
  shop,
  input,
  lang,
  dict,
  renderedAt,
  notes,
}: {
  shop: PublicShop;
  input: StatusInput;
  lang: Locale;
  dict: Dictionary;
  renderedAt: number;
  /** The special days' notes in the visitor's language (update 40). */
  notes: Map<string, string>;
}) {
  const now = new Date(renderedAt);
  const today = weekdayOf(localDateTime(now, shop.timezone).date);
  const coming = upcomingDays(input, now, 14);
  const dateText = (date: string) =>
    new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  return (
    <section aria-labelledby="hours-heading" className="flex flex-col gap-2" data-hours>
      <h2 id="hours-heading" className="text-lg font-semibold">
        {dict.shop.hours}
      </h2>
      <p className="text-sm" data-status-line>
        <LiveStatus input={input} labels={dict.status} lang={lang} renderedAt={renderedAt} />
      </p>
      {hasHours(shop.opening_hours) && (
        <table className="w-full max-w-sm text-sm">
          <tbody>
            {DAYS.map((day) => {
              const ranges = rangesFor(shop.opening_hours, day);
              const isToday = day === today;
              return (
                <tr key={day} className={`border-b border-line last:border-0 ${isToday ? "font-semibold" : ""}`} data-day={day} {...(isToday ? { "data-today": "" } : {})}>
                  <th scope="row" className={`py-1 pr-4 text-left capitalize ${isToday ? "font-semibold" : "font-normal"}`}>
                    {dayName(day, lang)}
                    {isToday && <span className="font-normal normal-case text-muted"> · {dict.status.today}</span>}
                  </th>
                  <td className="py-1 text-right">
                    {ranges.length ? rangeText(ranges) : <span className="text-muted">{dict.shop.closed}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {coming.length > 0 && (
        <div className="flex flex-col gap-1 pt-2" data-special-days>
          <h3 className="text-sm font-semibold">{dict.status.upcoming}</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {coming.map((d) => {
              const name = (d.holidayName as Record<string, string | null> | undefined)?.[lang] || d.holidayName?.en || d.holidayName?.sk || null;
              const hours =
                d.kind === "day_off"
                  ? dict.status.check_hours
                  : d.closed
                    ? d.kind === "closed_by_law"
                      ? dict.status.closed_holiday
                      : dict.status.closed_all_day
                    : `${rangeText(d.ranges)}${d.closedFrom ? ` · ${t(dict.status.closed_from, { time: displayTime(d.closedFrom) })}` : ""}`;
              return (
                <li key={d.date} className="flex flex-wrap gap-x-2" data-special-day={d.date}>
                  <span className="capitalize">{dateText(d.date)}</span>
                  {[name, notes.get(d.date) ?? d.note].filter(Boolean).length > 0 && (
                    <span className="text-muted">{[name, notes.get(d.date) ?? d.note].filter(Boolean).join(" · ")}</span>
                  )}
                  <span className="font-semibold">{hours}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
