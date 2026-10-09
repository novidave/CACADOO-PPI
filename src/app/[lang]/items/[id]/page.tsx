import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, locales, type Locale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { getItem, getOtherOffers, getShop, getShopsByIds, shopHasPlan } from "@/lib/data";
import { addressLine, directionsUrl, formatDistance, formatPrice } from "@/lib/format";
import { translatedName } from "@/lib/names";
import { pageAlternates, siteUrl } from "@/lib/site";
import type { StockRow } from "@/lib/stock";
import { JsonLd } from "@/components/JsonLd";
import { OpenStatus } from "@/components/OpenStatus";
import { ShopMap } from "@/components/ShopMap";
import { StockLine } from "@/components/StockLine";

export async function generateMetadata({ params }: PageProps<"/[lang]/items/[id]">): Promise<Metadata> {
  const { lang, id } = await params;
  if (!isLocale(lang)) return {};
  const [dict, item] = await Promise.all([getDictionary(lang), getItem(id).catch(() => null)]);
  if (!item) return {};
  const translated = translatedName(item.item_name, item.item_name_i18n, lang);
  const name = translated ? `${item.item_name} (${translated})` : item.item_name;
  return {
    title: `${name} · ${item.shop_name}`,
    description: t(dict.item.meta_description, {
      name,
      shop: item.shop_name,
      city: item.shop_city ?? "",
    }),
    alternates: pageAlternates(lang, `/items/${item.item_id}`, locales),
  };
}

export default async function ItemPage({ params }: PageProps<"/[lang]/items/[id]">) {
  const { lang, id } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, item] = await Promise.all([getDictionary(lang), getItem(id)]);
  if (!item) notFound();

  // Other shops with the same EAN, nearest to this shop first (no visitor location is used).
  // A shop with the paid plan has its own page: never other shops on it (not in the list,
  // the map or the JSON-LD).
  const near = item.shop_lat !== null && item.shop_lng !== null ? { lat: item.shop_lat, lng: item.shop_lng } : null;
  const pro = await shopHasPlan(item.shop_id);

  const [shop, others] = await Promise.all([getShop(item.shop_slug), pro ? Promise.resolve([]) : getOtherOffers(item, near)]);
  const otherShops = await getShopsByIds([...new Set(others.map((o) => o.shop_id))]);
  const hasLocation = item.shop_lat !== null && item.shop_lng !== null;
  const translated = translatedName(item.item_name, item.item_name_i18n, lang);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <JsonLd data={product(item, lang)} />

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{item.item_name}</h1>
        {translated && <p className="text-lg text-muted">{translated}</p>}
        <p className="text-2xl font-semibold">{formatPrice(item.price, lang, item.currency)}</p>
        <p>
          <StockLine row={item} timeZone={item.shop_timezone} dict={dict} lang={lang} />
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-sm">
          {item.brand && (
            <>
              <dt className="text-muted">{dict.item.brand}</dt>
              <dd>{item.brand}</dd>
            </>
          )}
          {item.ean && (
            <>
              <dt className="text-muted">{dict.item.ean}</dt>
              <dd className="tabular-nums">{item.ean}</dd>
            </>
          )}
        </dl>
      </header>

      <section aria-labelledby="shop-heading" className="flex flex-col gap-2 border border-line p-4">
        <h2 id="shop-heading" className="text-sm text-muted">
          {dict.item.shop}
        </h2>
        <Link href={`/${lang}/shops/${item.shop_slug}`} className="text-lg font-semibold hover:underline">
          {item.shop_name}
        </Link>
        <p>{addressLine(item.shop_address, item.shop_city)}</p>
        {shop && <OpenStatus hours={shop.opening_hours} timeZone={shop.timezone} lang={lang} dict={dict} className="text-sm" />}
        <p className="flex flex-wrap gap-x-4 text-sm">
          {hasLocation && (
            <a
              href={directionsUrl(item.shop_lat!, item.shop_lng!)}
              className="underline underline-offset-4"
              target="_blank"
              rel="noopener"
            >
              {dict.shop.directions}
            </a>
          )}
          {shop?.phone && (
            <a href={`tel:${shop.phone.replace(/\s+/g, "")}`} className="underline underline-offset-4">
              {shop.phone}
            </a>
          )}
        </p>
      </section>

      {hasLocation && (
        <ShopMap
          shops={[
            { slug: item.shop_slug, name: item.shop_name, lat: item.shop_lat!, lng: item.shop_lng!, href: `/${lang}/shops/${item.shop_slug}` },
            ...others
              .filter((o) => o.shop_lat !== null && o.shop_lng !== null)
              .map((o) => ({ slug: o.shop_slug, name: o.shop_name, lat: o.shop_lat!, lng: o.shop_lng!, href: `/${lang}/items/${o.item_id}` })),
          ]}
          label={dict.shop.map}
          className="h-56 md:h-72"
        />
      )}

      {item.ean && !pro && (
        <section aria-labelledby="others-heading" className="flex flex-col gap-2">
          <h2 id="others-heading" className="text-lg font-semibold">
            {dict.item.also_at}
          </h2>
          {others.length === 0 ? (
            <p className="text-muted">{dict.item.none_elsewhere}</p>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {others.map((o) => {
                const otherShop = otherShops.get(o.shop_id);
                return (
                  <li key={o.item_id} data-shop={o.shop_slug} className="flex flex-col gap-1 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <Link href={`/${lang}/items/${o.item_id}`} className="font-medium hover:underline">
                        {o.shop_name}
                      </Link>
                      <span className="whitespace-nowrap font-medium">{formatPrice(o.price, lang, o.currency)}</span>
                    </div>
                    <div className="text-sm text-muted">
                      {[o.shop_city, o.distance_km !== null ? formatDistance(o.distance_km, lang) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                    <div className="flex flex-wrap gap-x-3 text-sm">
                      <StockLine row={o} timeZone={o.shop_timezone} dict={dict} lang={lang} />
                      {otherShop && (
                        <OpenStatus hours={otherShop.opening_hours} timeZone={otherShop.timezone} lang={lang} dict={dict} />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

const SCHEMA_AVAILABILITY: Record<string, string> = {
  in_stock_count: "https://schema.org/InStock",
  out_of_stock: "https://schema.org/OutOfStock",
};

/** schema.org Product + Offer. The offer is left out entirely when the shop's stock data is stale. */
function product(item: StockRow, lang: Locale) {
  const url = `${siteUrl()}/${lang}/items/${item.item_id}`;
  const alternateName = translatedName(item.item_name, item.item_name_i18n, lang);
  const offer =
    item.freshness_state !== "stale" && item.price !== null && item.availability
      ? {
          offers: {
            "@type": "Offer",
            url,
            price: Number(item.price).toFixed(2),
            priceCurrency: item.currency,
            availability: SCHEMA_AVAILABILITY[item.availability],
            seller: {
              "@type": "Store",
              "@id": `${siteUrl()}/${lang}/shops/${item.shop_slug}`,
              name: item.shop_name,
              address: {
                "@type": "PostalAddress",
                ...(item.shop_address ? { streetAddress: item.shop_address } : {}),
                ...(item.shop_city ? { addressLocality: item.shop_city } : {}),
                ...(item.shop_country ? { addressCountry: item.shop_country } : {}),
              },
            },
          },
        }
      : {};
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": url,
    name: item.item_name,
    ...(alternateName ? { alternateName } : {}),
    url,
    ...(item.brand ? { brand: { "@type": "Brand", name: item.brand } } : {}),
    ...(item.ean ? { gtin: item.ean } : {}),
    ...offer,
  };
}
