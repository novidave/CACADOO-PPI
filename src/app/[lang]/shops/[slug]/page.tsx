import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, locales, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { getShop, getShopItems, shopHasPlan, type PublicShop } from "@/lib/data";
import { docsKeysEnabled } from "@/lib/docsAccess";
import { addressLine, directionsUrl, formatPrice } from "@/lib/format";
import { translatedName } from "@/lib/names";
import { DAYS, dayName, hasHours, openingHoursSpecification, rangesFor } from "@/lib/hours";
import { shopChatEnabled } from "@/lib/shopChat";
import { pageAlternates, siteUrl } from "@/lib/site";
import { freshnessText } from "@/lib/stock";
import { ContactLinks } from "@/components/ContactLinks";
import { JsonLd } from "@/components/JsonLd";
import { OpenStatus } from "@/components/OpenStatus";
import { ShopChat } from "@/components/ShopChat";
import { ShopMap } from "@/components/ShopMap";
import { StockLine } from "@/components/StockLine";

const PAGE_SIZE = 50;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata({ params }: PageProps<"/[lang]/shops/[slug]">): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  const [dict, shop] = await Promise.all([getDictionary(lang), getShop(slug).catch(() => null)]);
  if (!shop) return {};
  return {
    title: addressLine(shop.name, shop.city),
    description: t(dict.shop.meta_description, { name: shop.name, city: shop.city ?? "" }),
    alternates: pageAlternates(lang, `/shops/${shop.slug}`, locales),
  };
}

export default async function ShopPage({ params, searchParams }: PageProps<"/[lang]/shops/[slug]">) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, shop] = await Promise.all([getDictionary(lang), getShop(slug)]);
  if (!shop) notFound();

  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim();
  const requestedPage = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  // The AI assistant is a paid feature: shown only when the database says the shop has the plan.
  const [{ items, total }, assistant] = await Promise.all([
    getShopItems(shop.slug, q, requestedPage, PAGE_SIZE),
    shopChatEnabled() ? shopHasPlan(shop.id) : Promise.resolve(false),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const pageUrl = (n: number) =>
    `/${lang}/shops/${shop.slug}?${new URLSearchParams({ ...(q ? { q } : {}), page: String(n) })}`;

  const address = addressLine(shop.address, shop.city);
  const hasLocation = shop.lat !== null && shop.lng !== null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <JsonLd data={localBusiness(shop, lang)} />

      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          {shop.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element -- logos come from Supabase Storage
            <img src={shop.logo_url} alt="" width={48} height={48} className="h-12 w-12 border border-line object-contain" />
          )}
          <h1 className="text-2xl font-semibold tracking-tight">{shop.name}</h1>
        </div>
        {address && <p>{address}</p>}
        <OpenStatus hours={shop.opening_hours} timeZone={shop.timezone} lang={lang} dict={dict} className="text-sm" />
        <p className="text-sm">
          <span className="text-muted">{dict.shop.stock}: </span>
          {freshnessText(dict, shop.freshness_state, shop.freshness_age_minutes, shop.latest_file_time, shop.timezone)}
        </p>
        {(shop.has_toilet || shop.has_douchette) && (
          <p className="text-sm">
            <span className="text-muted">{dict.shop.facilities}: </span>
            <span className="font-semibold">
              {[shop.has_toilet && dict.shop.toilet, shop.has_douchette && dict.shop.douchette].filter(Boolean).join(" · ")}
            </span>
          </p>
        )}
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
          <ContactLinks email={shop.email} facebookUrl={shop.facebook_url} facebookLabel={dict.shop.facebook} />
        </p>
      </header>

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
        />
      )}

      {hasLocation && (
        <ShopMap
          shops={[{ slug: shop.slug, name: shop.name, lat: shop.lat!, lng: shop.lng!, href: `/${lang}/shops/${shop.slug}` }]}
          label={dict.shop.map}
          className="h-56 md:h-72"
        />
      )}

      {hasHours(shop.opening_hours) && <HoursTable shop={shop} lang={lang} dict={dict} />}
      {shop.has_card_terminal && <p className="-mt-3 text-sm font-semibold">{dict.shop.card_terminal}</p>}

      <section className="flex flex-col gap-3" aria-labelledby="items-heading">
        <h2 id="items-heading" className="text-lg font-semibold">
          {dict.shop.items}
        </h2>
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
    </div>
  );
}

function HoursTable({ shop, lang, dict }: { shop: PublicShop; lang: Locale; dict: Dictionary }) {
  return (
    <section aria-labelledby="hours-heading" className="flex flex-col gap-2">
      <h2 id="hours-heading" className="text-lg font-semibold">
        {dict.shop.hours}
      </h2>
      <table className="w-full max-w-sm text-sm">
        <tbody>
          {DAYS.map((day) => {
            const ranges = rangesFor(shop.opening_hours, day);
            return (
              <tr key={day} className="border-b border-line last:border-0">
                <th scope="row" className="py-1 pr-4 text-left font-normal capitalize">
                  {dayName(day, lang)}
                </th>
                <td className="py-1 text-right">
                  {ranges.length ? ranges.map(([a, b]) => `${a}–${b}`).join(", ") : <span className="text-muted">{dict.shop.closed}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** schema.org LocalBusiness: what AI assistants and search engines read. */
function localBusiness(shop: PublicShop, lang: Locale) {
  return {
    "@context": "https://schema.org",
    "@type": "Store",
    "@id": `${siteUrl()}/${lang}/shops/${shop.slug}`,
    name: shop.name,
    url: `${siteUrl()}/${lang}/shops/${shop.slug}`,
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
    ...(shop.has_card_terminal ? { paymentAccepted: "Cash, Credit Card, Debit Card" } : {}),
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
