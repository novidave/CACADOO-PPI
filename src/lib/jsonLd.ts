import type { PublicShop } from "./data";
import { siteItemUrl, siteLang, siteShopUrl } from "./customDomain";
import { hasHours, openingHoursSpecification, specialOpeningHoursSpecification, type StatusInput } from "./hours";
import { translatedName } from "./names";
import type { Locale } from "@/i18n/config";
import type { StockRow } from "./stock";

/**
 * schema.org data of the shop and item pages (what search engines and AI assistants read), on the
 * Cacaduu address or the shop's own domain (host: the canonical address once it is live). Plain
 * functions: the pages pass the address of PPI (siteUrl()) and the data.
 */

/** The shop's page address: its own domain when live, else on PPI. */
export function shopPageUrl(base: string, slug: string, country: string | null, lang: string, host: string | null, home?: string | null): string {
  return host ? siteShopUrl(host, lang, siteLang(country, home)) : `${base}/${lang}/shops/${slug}`;
}

/** The shop as a Store (a LocalBusiness): address, place, hours, special days, contact links, facilities. */
export function storeJsonLd(shop: PublicShop, lang: string, host: string | null, input: StatusInput, base: string, now = new Date()) {
  const special = specialOpeningHoursSpecification(input, now, 60);
  const url = shopPageUrl(base, shop.slug, shop.country, lang, host, shop.site_lang);
  return {
    "@type": "Store",
    "@id": url,
    name: shop.name,
    // The company behind the shop (update 48): its registered name and tax number (DIČ), as the owner wrote them.
    ...(shop.company_name ? { legalName: shop.company_name } : {}),
    ...(shop.dic ? { taxID: shop.dic } : {}),
    url,
    ...(shop.logo_url ? { logo: shop.logo_url, image: shop.logo_url } : {}),
    ...(shop.phone ? { telephone: shop.phone } : {}),
    ...(shop.email ? { email: shop.email } : {}),
    ...(shop.website || shop.facebook_url ? { sameAs: [shop.website, shop.facebook_url].filter(Boolean) } : {}),
    address: {
      "@type": "PostalAddress",
      ...(shop.address ? { streetAddress: shop.address } : {}),
      ...(shop.zip ? { postalCode: shop.zip } : {}),
      ...(shop.city ? { addressLocality: shop.city } : {}),
      ...(shop.country ? { addressCountry: shop.country } : {}),
    },
    ...(shop.lat !== null && shop.lng !== null ? { geo: { "@type": "GeoCoordinates", latitude: shop.lat, longitude: shop.lng } } : {}),
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
            ...(shop.has_douchette ? [{ "@type": "LocationFeatureSpecification", name: "Bidet shower", value: true }] : []),
          ],
        }
      : {}),
  };
}

const SCHEMA_AVAILABILITY: Record<string, string> = {
  in_stock_count: "https://schema.org/InStock",
  out_of_stock: "https://schema.org/OutOfStock",
};

/**
 * An item's page: the Product with its Offer, and the shop as a Store (LocalBusiness) that the
 * offer's seller points to. The Offer says what the page shows (update 36): the price and its
 * currency whenever the page shows a price, the availability only while the shop's stock data is
 * fresh (not stale) — exactly when the page itself shows the quantity; never invented.
 */
export function itemJsonLd(item: StockRow, shop: PublicShop | null, lang: Locale, host: string | null, input: StatusInput | null, base: string) {
  const url = host ? siteItemUrl(host, lang, item.item_id) : `${base}/${lang}/items/${item.item_id}`;
  const shopUrl = shopPageUrl(base, item.shop_slug, item.shop_country, lang, host, shop?.site_lang);
  const alternateName = translatedName(item.item_name, item.item_name_i18n, lang);
  const store = shop && input
    ? storeJsonLd(shop, lang, host, input, base)
    : {
        "@type": "Store",
        "@id": shopUrl,
        name: item.shop_name,
        url: shopUrl,
        address: {
          "@type": "PostalAddress",
          ...(item.shop_address ? { streetAddress: item.shop_address } : {}),
          ...(item.shop_city ? { addressLocality: item.shop_city } : {}),
          ...(item.shop_country ? { addressCountry: item.shop_country } : {}),
        },
      };
  const availability =
    item.freshness_state !== "stale" && item.availability ? (SCHEMA_AVAILABILITY[item.availability] ?? null) : null;
  const offer =
    item.price !== null && item.currency
      ? {
          offers: {
            "@type": "Offer",
            url,
            price: Number(item.price).toFixed(2),
            priceCurrency: item.currency,
            ...(availability ? { availability } : {}),
            seller: { "@id": shopUrl },
            availableAtOrFrom: { "@id": shopUrl },
          },
        }
      : {};
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Product",
        "@id": url,
        name: item.item_name,
        ...(alternateName ? { alternateName } : {}),
        url,
        ...(item.brand ? { brand: { "@type": "Brand", name: item.brand } } : {}),
        ...(item.ean ? { gtin: item.ean } : {}),
        ...offer,
      },
      store,
    ],
  };
}
