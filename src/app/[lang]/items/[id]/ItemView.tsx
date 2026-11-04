import type { Metadata } from "next";
import "@/components/shopPage.css";
import "@/components/unified.css";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { preload } from "react-dom";
import type { Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { itemHref, siteItemUrl, siteLang, sitePath } from "@/lib/customDomain";
import {
  getItem,
  getItemPhoto,
  getLiveSites,
  getOtherOffers,
  getShop,
  getShopCalendars,
  getShopsByIds,
  shopHasPlan,
  shopSiteHost,
  shopStandsAlone,
  type ItemPhoto,
} from "@/lib/data";
import { addressLine, formatDistance, formatPrice } from "@/lib/format";
import { itemNames } from "@/lib/names";
import { requestTime } from "@/lib/requestTime";
import { statusInput } from "@/lib/shopCalendar";
import { itemJsonLd } from "@/lib/jsonLd";
import { pageAlternates, siteUrl } from "@/lib/site";
import { getShopLanguages } from "@/lib/shopLanguages";
import { getItemTexts, getShopTexts } from "@/lib/contentTranslations";
import { contactButtons, contactWidths, CONTACT_KEYS, isAndroid } from "@/lib/contactButtons";
import { shopChatEnabled } from "@/lib/shopChat";
import { JsonLd } from "@/components/JsonLd";
import { ShopMap } from "@/components/ShopMap";
import { ShopStatusLine } from "@/components/ShopStatusLine";
import { StockDot } from "@/components/StockDot";
import { STOCK_WORDS, stockState, type StockState } from "@/lib/stockDot";
import { StockLine } from "@/components/StockLine";
import { ContactButtons } from "@/components/ContactButtons";
import { IconCopy } from "@/components/IconCopy";
import { ItemListButton } from "@/components/ItemListButton";
import { SectionZoom } from "@/components/SectionZoom";

export async function itemMetadata(lang: Locale, id: string): Promise<Metadata> {
  const [dict, item] = await Promise.all([getDictionary(lang), getItem(id).catch(() => null)]);
  if (!item) return {};
  // The canonical address: the shop's own domain once it is live (database update 25).
  const [host, langs, photo] = await Promise.all([
    shopSiteHost(item.shop_slug).catch(() => null),
    getShopLanguages(item.shop_slug, item.shop_country),
    getItemPhoto(item.shop_slug, item.item_id).catch(() => null),
  ]);
  const names = itemNames(item.item_name, item.item_name_i18n, lang);
  const name = names.secondary ? `${names.primary} (${names.secondary})` : names.primary;
  return {
    title: `${name} · ${item.shop_name}`,
    description: t(dict.item.meta_description, {
      name,
      shop: item.shop_name,
      city: item.shop_city ?? "",
    }),
    alternates: host
      ? {
          canonical: siteItemUrl(host, lang, item.item_id),
          languages: {
            ...Object.fromEntries(langs.indexed.map((l) => [l, siteItemUrl(host, l, item.item_id)])),
            "x-default": siteItemUrl(host, langs.home, item.item_id),
          },
        }
      : pageAlternates(lang, `/items/${item.item_id}`, langs.indexed),
    // The product's own photo (database update 78) — only this page shares it.
    ...(photo ? { openGraph: { images: [{ url: photo.large, width: photo.width, height: photo.height, alt: name }] } } : {}),
    // The shop decides (its pre-translated languages), over the site-wide rule of the [lang] layout.
    robots: { index: langs.indexed.includes(lang), follow: true },
  };
}

const PILL: Record<StockState, { bg: string; fg: string; key: "pill_available" | "pill_sold_out" | "pill_no_info" }> = {
  available: { bg: "#E3F1EC", fg: "#1F6150", key: "pill_available" },
  sold_out: { bg: "#FDECEC", fg: "#9B1C1C", key: "pill_sold_out" },
  no_info: { bg: "#FEF6DC", fg: "#7A5A06", key: "pill_no_info" },
};

/**
 * An item's page (the unified design, 2026-11-04, at the owner's request): on the Cacaduu address, or on its shop's own
 * domain (siteSlug: only that shop's items exist there; links stay on the domain). One canonical for both. From the
 * top: the way back to the shop · the product's photo (only when it has one, database update 78) · the main card
 * (category, name, price + stock pill, the stock sentence, "Pridať do nákupného zoznamu", "Opýtať sa asistenta") ·
 * Popis · Podrobnosti (a closed dropdown) · Kde kúpiť (the shop, its status, Navigovať and its phone, the map) ·
 * "Dostupné aj v" (the same rule as before) · the footer.
 */
export async function ItemView({ lang, id, siteSlug, original = false }: { lang: Locale; id: string; siteSlug: string | null; original?: boolean }) {
  const [dict, item] = await Promise.all([getDictionary(lang), getItem(id)]);
  if (!item) notFound();
  if (siteSlug && item.shop_slug !== siteSlug) notFound();
  // Other shops with the same EAN, nearest to this shop first (no visitor location is used).
  // A shop with the paid plan or a domain of its own has its own page: never other shops on
  // it (no "Dostupné aj v" list or "not found elsewhere" text, not on the map or in the
  // JSON-LD). The database decides (shop_stands_alone).
  const near = item.shop_lat !== null && item.shop_lng !== null ? { lat: item.shop_lat, lng: item.shop_lng } : null;
  // Everything that needs only the item, at once (no waterfall); the other offers are dropped when the shop stands alone.
  const [host, alone, shop, offers, itemTexts, langs, photo, assistant] = await Promise.all([
    shopSiteHost(item.shop_slug).catch(() => null),
    shopStandsAlone(item.shop_id),
    getShop(item.shop_slug),
    getOtherOffers(item, near),
    // The description and category (update 40): the shop's own, else the approved "Popis (Cacaduu)".
    getItemTexts(item.item_id),
    getShopLanguages(item.shop_slug, item.shop_country),
    // The product's one photo (update 78): this page is the only place that shows it.
    getItemPhoto(item.shop_slug, item.item_id).catch(() => null),
    // "Opýtať sa asistenta na produkt" only when the shop's assistant is on (the paid plan + the server's AI key).
    shopChatEnabled() ? shopHasPlan(item.shop_id).catch(() => false) : Promise.resolve(false),
  ]);
  if (siteSlug && !host) notFound();
  const others = alone ? [] : offers;
  const [otherShops, calendars, sites, texts] = await Promise.all([
    getShopsByIds([...new Set(others.map((o) => o.shop_id))]),
    // Special days and holidays for the status of each shop (database update 27).
    getShopCalendars([item.shop_id, ...others.map((o) => o.shop_id)]).catch(() => new Map()),
    // Other shops with a live own domain are linked there (their canonical address).
    others.length ? getLiveSites() : Promise.resolve(new Map<string, string>()),
    // In the visitor's language when translated (the original stays; "Zobraziť originál").
    getShopTexts(item.shop_slug, lang, langs, original, [{ kinds: ["item_description", "item_category"], refs: [item.item_id] }]),
  ]);
  const renderedAt = requestTime();
  const hasLocation = item.shop_lat !== null && item.shop_lng !== null;
  const names = itemNames(item.item_name, item.item_name_i18n, lang);
  const shopHref = siteSlug && shop ? sitePath(lang, siteLang(shop.country, shop.site_lang)) : `/${lang}/shops/${item.shop_slug}`;
  const description = texts.text("item_description", item.item_id, itemTexts?.description ?? null);
  const category = texts.text("item_category", item.item_id, itemTexts?.category ?? null);
  const it = dict.item;
  const pill = PILL[stockState(item.availability)];
  // Navigovať on Android = a geo: link (the Maps app), decided from this request's user agent, as on the shop page.
  const android = isAndroid((await headers()).get("user-agent"));
  const contacts = shop
    ? contactButtons({ ...shop }, contactWidths({}), { facebook: dict.shop.facebook, booking: dict.shop.booking, web: dict.shop.website, navigate: dict.shop.directions }, { android })
        .filter((b) => b.key === "navigate" || b.key === "phone")
        .map((b) => ({ ...b, width: "short" as const }))
    : [];
  const cb = dict.contact_buttons;
  const contactLabels = {
    hold: cb.hold,
    release: cb.release,
    announce: cb.announce,
    done: Object.fromEntries(CONTACT_KEYS.map((k) => [k, cb[`done_${k}`]])) as Record<(typeof CONTACT_KEYS)[number], string>,
  };
  const askHref = `${shopHref}?${new URLSearchParams({ ask: t(it.ask_prefill, { name: names.primary }) })}#assistant`;
  const details = [
    item.brand ? { key: "brand", label: it.brand, value: item.brand } : null,
    category ? { key: "category", label: it.category, value: category } : null,
    item.ean ? { key: "ean", label: it.ean, value: item.ean, numbers: true } : null,
  ].filter((d): d is { key: string; label: string; value: string; numbers?: boolean } => Boolean(d));
  // The photo is the page's first picture: preloaded (only when there is one), never lazy.
  if (photo) preload(photo.small, { as: "image", imageSrcSet: `${photo.small} 800w, ${photo.large} ${photo.width}w`, imageSizes: "(min-width: 768px) 768px, 100vw", fetchPriority: "high" });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4" data-unified-page data-item-page>
      <JsonLd data={itemJsonLd(item, shop, lang, host, shop ? statusInput(shop, calendars) : null, siteUrl(), photo?.large ?? null)} />

      {/* 1. The way back to the shop (the first link of the page). */}
      <Link href={shopHref} className="ppi-u-back" aria-label={t(it.back_to, { shop: item.shop_name })} data-item-back>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C2410C" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        <span>{item.shop_name}</span>
      </Link>

      {/* 2. The product's photo — only when it has one (no empty box, no placeholder). */}
      {photo && <PhotoBox photo={photo} name={names.primary} dict={dict} />}

      {/* 3. The main card. */}
      <section aria-labelledby="item-name" className="flex flex-col gap-3 rounded-2xl border-[1.5px] border-[#FBCFA9] bg-white p-4" data-item-details>
        {category && (
          <span className="self-start rounded-full bg-[#FFF1E6] px-3 py-1 text-[13px] font-semibold text-[#9A3A0A]" data-item-category-chip>
            {category}
          </span>
        )}
        <header className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 id="item-name" className="text-[22px] leading-tight font-bold break-words">
              {names.primary}
            </h1>
            {names.secondary && (
              <p className="text-base text-[#5B6670]" data-item-original-name>
                {names.secondary}
              </p>
            )}
          </div>
          <IconCopy kind="text" value={names.primary} label={it.copy_name} done={it.copied_name} refused={it.copy_refused} className="-mt-1.5 -mr-1.5" />
        </header>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p className="text-[30px] leading-none font-bold tabular-nums" data-item-price>
            <span className="sr-only">{it.price}: </span>
            {formatPrice(item.price, lang, item.currency)}
          </p>
          <span className="inline-flex min-h-8 items-center gap-2 rounded-full px-3 text-sm font-bold" style={{ background: pill.bg, color: pill.fg }} data-item-stock-pill={stockState(item.availability)}>
            <StockDot availability={item.availability} size={10} />
            {it[pill.key]}
          </span>
        </div>
        {/* The stock sentence — only on the product page. */}
        <p className="text-[15px]" data-item-stock>
          <span className="sr-only">{it.availability}: </span>
          <StockLine row={item} timeZone={item.shop_timezone} dict={dict} lang={lang} />
        </p>
        <hr className="border-[#F1EDE6]" />
        <ItemListButton
          shopId={item.shop_id}
          item={{ id: item.item_id, name: names.primary, original: names.secondary, price: item.price, currency: item.currency }}
          lang={lang}
          labels={{
            add: it.list_add,
            in_list: it.list_in,
            total: it.list_total,
            minus: it.list_minus,
            plus: it.list_plus,
            remove: it.list_remove,
            count: it.list_count,
            said_added: it.list_said_added,
            said_removed: it.list_said_removed,
          }}
        />
        {assistant && (
          <Link href={askHref} className="flex min-h-[52px] items-center justify-center gap-2.5 rounded-2xl border border-[#ECE7DE] bg-white px-4 text-base font-bold" data-item-ask>
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#F57C20]" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" aria-hidden="true" focusable="false">
                <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
              </svg>
            </span>
            {it.ask}
          </Link>
        )}
      </section>

      {/* 4. Popis: the whole text, always. */}
      {description && (
        <section aria-labelledby="item-description" className="flex flex-col gap-2 rounded-[20px] border border-[#ECE7DE] bg-white p-4" data-item-description={itemTexts?.source ?? ""}>
          <h2 id="item-description" className="text-[17px] font-bold">
            {it.description}
          </h2>
          <p className="text-[15px] leading-relaxed whitespace-pre-line break-words">{description}</p>
        </section>
      )}

      {/* 5. Podrobnosti: a closed dropdown (the rows stay in the HTML for search engines and screen readers). */}
      {details.length > 0 && (
        <details className="ppi-u-details rounded-[20px] border border-[#ECE7DE] bg-white" data-item-more>
          <summary className="flex min-h-[52px] items-center justify-between gap-3 rounded-[20px] px-4">
            <span className="text-[17px] font-bold">{it.details}</span>
            <span className="ppi-u-chev flex h-8 w-8 items-center justify-center rounded-full bg-[#FFF1E6]" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C2410C" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          </summary>
          <dl className="flex flex-col px-4 pb-3">
            {details.map((d) => (
              <div key={d.key} className="flex items-baseline justify-between gap-4 border-t border-[#F1EDE6] py-2.5" {...(d.key === "category" ? { "data-item-category": "" } : {})}>
                <dt className="text-[15px] text-[#5B6670]">{d.label}</dt>
                <dd className={`text-right text-[15px] font-bold break-words ${d.numbers ? "tabular-nums" : ""}`}>{d.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {/* 6. Kde kúpiť: the shop, its status, Navigovať and its phone (hold to open), the map. */}
      <section aria-labelledby="shop-heading" className="overflow-hidden rounded-[20px] border border-[#ECE7DE] bg-white" data-item-shop>
        <header className="flex items-center gap-3 bg-[#FFF6EE] px-4 py-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#ECE7DE] bg-white text-base font-bold text-[#C2410C]" aria-hidden="true">
            {shop?.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element -- logos come from Supabase Storage
              <img src={shop.logo_url} alt="" width={28} height={28} loading="lazy" className="h-7 w-7 object-contain" />
            ) : (
              [...item.shop_name][0]?.toUpperCase()
            )}
          </span>
          <div className="flex min-w-0 flex-col">
            <h2 id="shop-heading" className="text-xs font-bold tracking-wider text-[#9A3A0A] uppercase">
              {it.where}
            </h2>
            <Link href={shopHref} className="truncate text-[17px] font-bold hover:underline">
              {item.shop_name}
            </Link>
          </div>
        </header>
        <div className="flex flex-col gap-3 p-4">
          {addressLine(item.shop_address, item.shop_city) && (
            <p className="flex items-center gap-2.5 text-[15px]">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#FFF1E6]" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C2410C" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                  <path d="M12 21s-7-6.2-7-11.5a7 7 0 0114 0C19 14.8 12 21 12 21z" />
                  <circle cx="12" cy="9.5" r="2.5" />
                </svg>
              </span>
              {addressLine(item.shop_address, item.shop_city)}
            </p>
          )}
          {shop && (
            <span className="self-start" data-status-line>
              <ShopStatusLine input={statusInput(shop, calendars)} labels={dict.status} lang={lang} renderedAt={renderedAt} pill />
            </span>
          )}
          {contacts.length > 0 && (
            <div className="flex flex-col gap-2" data-shop-contacts>
              <ContactButtons buttons={contacts} labels={contactLabels} />
              <p className="text-[13px] text-[#5B6670]">{it.hold_help}</p>
            </div>
          )}
          {hasLocation && (
            <ShopMap
              shops={[
                {
                  slug: item.shop_slug,
                  name: item.shop_name,
                  lat: item.shop_lat!,
                  lng: item.shop_lng!,
                  href: shopHref,
                  ...(shop ? { status: statusInput(shop, calendars) } : {}),
                },
                ...others
                  .filter((o) => o.shop_lat !== null && o.shop_lng !== null)
                  .map((o) => {
                    const other = otherShops.get(o.shop_id);
                    return {
                      slug: o.shop_slug,
                      name: o.shop_name,
                      lat: o.shop_lat!,
                      lng: o.shop_lng!,
                      href: itemHref(sites, lang, o.shop_slug, o.item_id),
                      ...(other ? { status: statusInput(other, calendars) } : {}),
                    };
                  }),
              ]}
              label={dict.shop.map}
              statusLabels={dict.status}
              renderedAt={renderedAt}
              className="h-56 overflow-hidden rounded-[10px] md:h-72"
            />
          )}
        </div>
      </section>

      {/* 7. Dostupné aj v: the same rule as before (only when the shop does not stand alone); no photos. */}
      {item.ean && !alone && (
        <section aria-labelledby="others-heading" className="flex flex-col gap-2 rounded-[20px] border border-[#ECE7DE] bg-white p-4">
          <h2 id="others-heading" className="text-[17px] font-bold">
            {it.also_at}
          </h2>
          {others.length === 0 ? (
            <p className="text-[15px] text-[#5B6670]">{it.none_elsewhere}</p>
          ) : (
            <ul className="flex flex-col">
              {others.map((o) => {
                const otherShop = otherShops.get(o.shop_id);
                return (
                  <li key={o.item_id} data-shop={o.shop_slug} className="flex flex-col gap-1 border-t border-[#F1EDE6] py-3 first:border-t-0 first:pt-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <Link href={itemHref(sites, lang, o.shop_slug, o.item_id)} className="font-bold hover:underline">
                        {o.shop_name}
                      </Link>
                      <span className="flex items-center gap-2 font-bold whitespace-nowrap tabular-nums">
                        <StockDot availability={o.availability} label={dict.stock[STOCK_WORDS[stockState(o.availability)]]} />
                        {formatPrice(o.price, lang, o.currency)}
                      </span>
                    </div>
                    <div className="text-sm text-[#5B6670]">
                      {[o.shop_city, o.distance_km !== null ? formatDistance(o.distance_km, lang) : null].filter(Boolean).join(" · ")}
                    </div>
                    <div className="flex flex-wrap gap-x-3 text-sm">
                      <StockLine row={o} timeZone={o.shop_timezone} dict={dict} lang={lang} listing />
                      {otherShop && <ShopStatusLine input={statusInput(otherShop, calendars)} labels={dict.status} lang={lang} renderedAt={renderedAt} />}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {photo && <SectionZoom labels={{ close: dict.blog.close, zoom_in: dict.blog.zoom_in, zoom_out: dict.blog.zoom_out, prev_page: dict.blog.prev_photo, next_page: dict.blog.next_photo }} />}
    </div>
  );
}

/** The product's photo: 800 / 1600 px from the bucket (never image optimisation), a tap opens the zoom; copy icon. */
function PhotoBox({ photo, name, dict }: { photo: ItemPhoto; name: string; dict: Dictionary }) {
  const it = dict.item;
  const shown = Math.min(800, photo.width);
  const height = Math.max(1, Math.round((photo.height * shown) / photo.width));
  return (
    <figure className="relative overflow-hidden rounded-2xl border border-[#ECE7DE] bg-white" data-item-photo>
      <a href={photo.large} data-zoom={photo.large} data-zoom-group="item-photo" data-zoom-label={name} aria-label={it.photo_zoom} className="flex justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element -- the stored 800 / 1600 px WebP straight from the bucket */}
        <img
          src={photo.small}
          srcSet={photo.width > 800 ? `${photo.small} 800w, ${photo.large} ${photo.width}w` : undefined}
          sizes="(min-width: 768px) 768px, 100vw"
          width={shown}
          height={height}
          alt={name}
          fetchPriority="high"
          decoding="async"
          className="h-auto max-h-[70vh] w-auto max-w-full object-contain"
        />
      </a>
      <span className="absolute top-1.5 right-1.5">
        <IconCopy kind="image" value={photo.small} label={it.copy_photo} done={it.copied_photo} refused={it.copy_refused} />
      </span>
    </figure>
  );
}
