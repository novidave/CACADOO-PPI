import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { locales, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { siteLang, sitePath, siteShopUrl } from "@/lib/customDomain";
import { getShop, getShopCalendars, getShopItems, shopHasPlan, shopperPdfAllowed, shopSiteHost, type PublicShop } from "@/lib/data";
import { archiveEnabled } from "@/lib/assistantArchive";
import { docsKeysEnabled } from "@/lib/docsAccess";
import { addressLine, directionsUrl, formatPrice } from "@/lib/format";
import { translatedName } from "@/lib/names";
import {
  DAYS,
  dayName,
  displayTime,
  hasHours,
  localDateTime,
  openingHoursSpecification,
  rangesFor,
  specialOpeningHoursSpecification,
  type StatusInput,
  upcomingDays,
  weekdayOf,
} from "@/lib/hours";
import { requestTime } from "@/lib/requestTime";
import { statusInput } from "@/lib/shopCalendar";
import { shopChatEnabled } from "@/lib/shopChat";
import { pageAlternates, siteUrl } from "@/lib/site";
import { getShopSections } from "@/lib/sections";
import { freshnessText } from "@/lib/stock";
import { ContactLinks } from "@/components/ContactLinks";
import { JsonLd } from "@/components/JsonLd";
import { PageSections } from "@/components/PageSections";
import { SectionZoom } from "@/components/SectionZoom";
import { ShopChat } from "@/components/ShopChat";
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
 * Cacadoo address and on the domain alike; else the Cacadoo address.
 */
function alternates(shop: PublicShop, lang: Locale, host: string | null) {
  if (!host) return pageAlternates(lang, `/shops/${shop.slug}`, locales);
  const defaultLang = siteLang(shop.country);
  return {
    canonical: siteShopUrl(host, lang, defaultLang),
    languages: Object.fromEntries(locales.map((l) => [l, siteShopUrl(host, l, defaultLang)])),
  };
}

export async function shopMetadata(lang: Locale, slug: string): Promise<Metadata> {
  const [dict, shop] = await Promise.all([getDictionary(lang), getShop(slug).catch(() => null)]);
  if (!shop) return {};
  const host = await shopSiteHost(shop.slug).catch(() => null);
  return {
    title: addressLine(shop.name, shop.city),
    description: t(dict.shop.meta_description, { name: shop.name, city: shop.city ?? "" }),
    alternates: alternates(shop, lang, host),
  };
}

/**
 * The shop's page: on its Cacadoo address, or on its own domain (onSite: under the domain's own
 * header with its picture; the links stay on the domain, "/" is the shop's language). Both say
 * the same and point to one canonical. Order: name and logo with the shop's details, map with the
 * status dot, opening hours (status line, today, breaks, the coming special days), then — with
 * the paid plan — the assistant (always open) and "Mám prístupový kľúč", then the items. The
 * shop's page sections from PDFs (paid plan, update 28) sit where the owner put them: after the
 * details, after the map, before the items or at the end.
 */
export async function ShopView({ lang, slug, sp, onSite }: { lang: Locale; slug: string; sp: SearchParams; onSite: boolean }) {
  const [dict, shop] = await Promise.all([getDictionary(lang), getShop(slug)]);
  if (!shop) notFound();
  const host = await shopSiteHost(shop.slug).catch(() => null);
  if (onSite && !host) notFound();
  const defaultLang = siteLang(shop.country);

  const q = (first(sp.q) ?? "").trim();
  const requestedPage = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  // The AI assistant is a paid feature: shown only when the database says the shop has the plan.
  const [{ items, total }, assistant, shopperPdf, calendars, sections] = await Promise.all([
    getShopItems(shop.slug, q, requestedPage, PAGE_SIZE),
    shopChatEnabled() ? shopHasPlan(shop.id) : Promise.resolve(false),
    // "Stiahnuť túto konverzáciu (PDF)" (database update 24): only with the archive on.
    archiveEnabled() ? shopperPdfAllowed(shop.slug).catch(() => false) : Promise.resolve(false),
    // Special days and holidays (database update 27): the status and the next 60 days.
    getShopCalendars([shop.id], 60).catch(() => new Map()),
    // Page sections from PDFs (database update 28): only the ones the database shows.
    getShopSections(shop.slug, shop.id).catch(() => []),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const shopPath = onSite ? sitePath(lang, defaultLang) : `/${lang}/shops/${shop.slug}`;
  const pageUrl = (n: number) => `${shopPath}?${new URLSearchParams({ ...(q ? { q } : {}), page: String(n) })}`;

  const address = addressLine(shop.address, shop.city);
  const hasLocation = shop.lat !== null && shop.lng !== null;
  const input = statusInput(shop, calendars);
  const renderedAt = requestTime();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <JsonLd data={localBusiness(shop, lang, host, input)} />

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
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
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
        </p>
      </header>

      <PageSections sections={sections} position="after_details" slug={shop.slug} dict={dict} />

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

      <PageSections sections={sections} position="after_map" slug={shop.slug} dict={dict} />

      {/* 3. Opening hours: status line, the week (today marked, breaks in the row), the coming special days. */}
      <HoursSection shop={shop} input={input} lang={lang} dict={dict} renderedAt={renderedAt} />

      {/* 4. and 5. The assistant (paid plan): always open; "Mám prístupový kľúč" as a closed dropdown under it. */}
      {assistant && (
        <ShopChat
          slug={shop.slug}
          lang={lang}
          shopName={shop.name}
          timeZone={shop.timezone}
          keys={docsKeysEnabled()}
          labels={dict.chat}
          buttonLabel={shop.assistant_label}
          welcome={shop.assistant_welcome}
          archive={archiveEnabled()}
          shopperPdf={shopperPdf}
        />
      )}

      <PageSections sections={sections} position="before_items" slug={shop.slug} dict={dict} />

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
          <p>{dict.shop.no_items}</p>
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

      <PageSections sections={sections} position="end" slug={shop.slug} dict={dict} />
      {sections.length > 0 && <SectionZoom labels={dict.sections} />}
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
}: {
  shop: PublicShop;
  input: StatusInput;
  lang: Locale;
  dict: Dictionary;
  renderedAt: number;
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
              const name = d.holidayName?.[lang] || d.holidayName?.en || d.holidayName?.sk || null;
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
                  {[name, d.note].filter(Boolean).length > 0 && <span className="text-muted">{[name, d.note].filter(Boolean).join(" · ")}</span>}
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

/** schema.org LocalBusiness: what AI assistants and search engines read (the canonical address). */
function localBusiness(shop: PublicShop, lang: Locale, host: string | null, input: StatusInput) {
  const special = specialOpeningHoursSpecification(input, new Date(), 60);
  const url = host ? siteShopUrl(host, lang, siteLang(shop.country)) : `${siteUrl()}/${lang}/shops/${shop.slug}`;
  return {
    "@context": "https://schema.org",
    "@type": "Store",
    "@id": url,
    name: shop.name,
    url,
    ...(shop.logo_url ? { logo: shop.logo_url, image: shop.logo_url } : {}),
    ...(shop.phone ? { telephone: shop.phone } : {}),
    ...(shop.email ? { email: shop.email } : {}),
    ...(shop.website || shop.facebook_url ? { sameAs: [shop.website, shop.facebook_url].filter(Boolean) } : {}),
    address: {
      "@type": "PostalAddress",
      ...(shop.address ? { streetAddress: shop.address } : {}),
      ...(shop.city ? { addressLocality: shop.city } : {}),
      ...(shop.country ? { addressCountry: shop.country } : {}),
    },
    ...(shop.lat !== null && shop.lng !== null
      ? { geo: { "@type": "GeoCoordinates", latitude: shop.lat, longitude: shop.lng } }
      : {}),
    ...(hasHours(shop.opening_hours) ? { openingHoursSpecification: openingHoursSpecification(shop.opening_hours) } : {}),
    // The owner's special days and the days shops must close by law (public days off: hours unknown, left out).
    ...(special.length ? { specialOpeningHoursSpecification: special } : {}),
    ...(shop.has_card_terminal ? { paymentAccepted: "Cash, Credit Card, Debit Card" } : {}),
    // The shop's booking app (the owner's link).
    ...(shop.booking_url
      ? {
          potentialAction: {
            "@type": "ReserveAction",
            target: {
              "@type": "EntryPoint",
              urlTemplate: shop.booking_url,
              actionPlatform: ["https://schema.org/DesktopWebPlatform", "https://schema.org/MobileWebPlatform"],
            },
          },
        }
      : {}),
    ...(shop.has_toilet || shop.has_douchette
      ? {
          amenityFeature: [
            ...(shop.has_toilet ? [{ "@type": "LocationFeatureSpecification", name: "Customer toilet", value: true }] : []),
            ...(shop.has_douchette ? [{ "@type": "LocationFeatureSpecification", name: "Douchette (bidet shower)", value: true }] : []),
          ],
        }
      : {}),
  };
}
