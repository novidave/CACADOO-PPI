import type { Metadata } from "next";
import "@/components/shopPage.css";
import "@/components/unified.css";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { preload } from "react-dom";
import type { Locale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { siteItemUrl, siteLang, sitePath } from "@/lib/customDomain";
import { getShop, getShopCalendars, shopHasPlan, shopSiteHost } from "@/lib/data";
import { addressLine, formatPrice } from "@/lib/format";
import { foodState } from "@/lib/food";
import { categoryName, getShopMenu } from "@/lib/menu";
import { orderLines, type MenuDish } from "@/lib/menuRules";
import { itemNames } from "@/lib/names";
import { requestTime } from "@/lib/requestTime";
import { statusInput } from "@/lib/shopCalendar";
import { pageAlternates, siteUrl } from "@/lib/site";
import { getShopLanguages } from "@/lib/shopLanguages";
import { getShopTexts } from "@/lib/contentTranslations";
import { contactButtons, contactWidths, CONTACT_KEYS, isAndroid } from "@/lib/contactButtons";
import { shopChatEnabled } from "@/lib/shopChat";
import { JsonLd } from "@/components/JsonLd";
import { IconCopy } from "@/components/IconCopy";
import { DishBuy, type DishLine } from "@/components/DishBuy";
import { SectionZoom } from "@/components/SectionZoom";
import { PhotoBox, WhereToBuy } from "./ItemView";

/** Where a menu item lives (update 84's shop_menu_dish_of): the restaurant and the dish (a size gives its dish). */
export interface DishRef {
  slug: string;
  dish: string;
}

/** The dish as the restaurant's Menu shows it (shop_menu: hidden ones are not there), or null. */
async function findDish(ref: DishRef) {
  const [shop, menu] = await Promise.all([getShop(ref.slug), getShopMenu(ref.slug).catch(() => null)]);
  const dish = menu?.items.find((d) => d.id === ref.dish);
  return shop && menu && dish ? { shop, menu, dish } : null;
}

export async function dishMetadata(lang: Locale, ref: DishRef): Promise<Metadata> {
  const [dict, found] = await Promise.all([getDictionary(lang), findDish(ref)]);
  if (!found) return {};
  const { shop, dish } = found;
  const [host, langs] = await Promise.all([shopSiteHost(shop.slug).catch(() => null), getShopLanguages(shop.slug, shop.country)]);
  const names = itemNames(dish.name, dish.name_i18n, lang);
  const name = names.secondary ? `${names.primary} (${names.secondary})` : names.primary;
  return {
    title: `${name} · ${shop.name}`,
    description: t(dict.menu.dish_meta, { name, shop: shop.name, city: shop.city ?? "" }),
    alternates: host
      ? {
          canonical: siteItemUrl(host, lang, dish.id),
          languages: {
            ...Object.fromEntries(langs.indexed.map((l) => [l, siteItemUrl(host, l, dish.id)])),
            "x-default": siteItemUrl(host, langs.home, dish.id),
          },
        }
      : pageAlternates(lang, `/items/${dish.id}`, langs.indexed),
    ...(dish.photo ? { openGraph: { images: [{ url: dish.photo.large, width: dish.photo.width, height: dish.photo.height, alt: name }] } } : {}),
    robots: { index: langs.indexed.includes(lang), follow: true },
  };
}

/**
 * A restaurant's dish on its own page (update 84, at the owner's request: the dishes are rows of the shop page's
 * "Jedlá / Zoznam" box, and each row leads here — the product page's design). From the top: the way back · the photo
 * (only with one) · the main card (category, name, tags, the sizes and the price with "Dostupné" / "Vypredané dnes",
 * "Pridať do nákupného zoznamu", "Objednať" while ordering in the assistant is on, else "Opýtať sa asistenta") · Popis ·
 * Alergény (the EU numbers and names) · Kde kúpiť. Everything comes from shop_menu() — the same price (Sklad's sale
 * price with VAT), sizes, sold out today and photo as on the restaurant's page; a dish is not stock (no stock sentence,
 * no freshness, no other shops).
 */
export async function DishView({ lang, at, siteSlug, original = false }: { lang: Locale; at: DishRef; siteSlug: string | null; original?: boolean }) {
  const [dict, found] = await Promise.all([getDictionary(lang), findDish(at)]);
  if (!found) notFound();
  const { shop, menu, dish } = found;
  if (siteSlug && shop.slug !== siteSlug) notFound();
  const [host, langs, assistant, calendars] = await Promise.all([
    shopSiteHost(shop.slug).catch(() => null),
    getShopLanguages(shop.slug, shop.country),
    shopChatEnabled() ? shopHasPlan(shop.id).catch(() => false) : Promise.resolve(false),
    getShopCalendars([shop.id]).catch(() => new Map()),
  ]);
  if (siteSlug && !host) notFound();
  const [texts, food] = await Promise.all([
    getShopTexts(shop.slug, lang, langs, original, [{ kinds: ["item_description", "item_category"], refs: [dish.id] }]),
    assistant ? foodState(shop.slug).catch(() => null) : Promise.resolve(null),
  ]);
  const it = dict.item;
  const m = dict.menu;
  const names = itemNames(dish.name, dish.name_i18n, lang);
  const shopHref = siteSlug ? sitePath(lang, siteLang(shop.country, shop.site_lang)) : `/${lang}/shops/${shop.slug}`;
  const category = menu.categories.find((c) => c.id === dish.category_id) ?? null;
  const categoryText = category ? categoryName(category, [dish], texts, "") : null;
  const description = texts.text("item_description", dish.id, dish.description);
  const ordering = Boolean(assistant && food?.enabled);
  const lines: DishLine[] = orderLines(dish).map((l) => {
    const price = l.price_cents / 100;
    return {
      id: l.id,
      label: l.label,
      name: l.label ? `${names.primary} ${l.label}` : names.primary,
      original: names.secondary ? (l.label ? `${names.secondary} ${l.label}` : names.secondary) : null,
      price,
      currency: menu.currency,
      priceText: formatPrice(price, lang, menu.currency),
      soldOut: l.sold_out,
      // the restaurant page's assistant with this dish (?order=; without JavaScript ?ask= writes the question)
      orderHref:
        ordering && !l.sold_out
          ? `${shopHref}?${new URLSearchParams({ ask: t(m.order_message, { name: l.label ? `${dish.name} ${l.label}` : dish.name }), order: l.id })}#assistant`
          : null,
    };
  });
  const askHref = `${shopHref}?${new URLSearchParams({ ask: t(m.ask_prefill, { name: names.primary }) })}#assistant`;
  const android = isAndroid((await headers()).get("user-agent"));
  const contacts = contactButtons({ ...shop }, contactWidths({}), { facebook: dict.shop.facebook, booking: dict.shop.booking, web: dict.shop.website, navigate: dict.shop.directions }, { android })
    .filter((b) => b.key === "navigate" || b.key === "phone")
    .map((b) => ({ ...b, width: "short" as const }));
  const cb = dict.contact_buttons;
  const contactLabels = {
    hold: cb.hold,
    release: cb.release,
    announce: cb.announce,
    done: Object.fromEntries(CONTACT_KEYS.map((k) => [k, cb[`done_${k}`]])) as Record<(typeof CONTACT_KEYS)[number], string>,
  };
  const status = statusInput(shop, calendars);
  const renderedAt = requestTime();
  const photo = dish.photo;
  if (photo) preload(photo.small, { as: "image", imageSrcSet: `${photo.small} 800w, ${photo.large} ${photo.width}w`, imageSizes: "(min-width: 768px) 768px, 100vw", fetchPriority: "high" });
  const canonical = host ? siteItemUrl(host, lang, dish.id) : `${siteUrl()}/${lang}/items/${dish.id}`;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4" data-unified-page data-item-page data-dish-page>
      <JsonLd data={dishJsonLd(dish, names.primary, description, menu.currency, canonical)} />

      {/* 1. The way back to the restaurant (the first link of the page). */}
      <Link href={shopHref} className="ppi-u-back" aria-label={t(it.back_to, { shop: shop.name })} data-item-back>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C2410C" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        <span>{shop.name}</span>
      </Link>

      {/* 2. The dish's photo — only when it has one. */}
      {photo && <PhotoBox photo={photo} name={names.primary} dict={dict} />}

      {/* 3. The main card. */}
      <section aria-labelledby="item-name" className="flex flex-col gap-3 rounded-2xl border-[1.5px] border-[#FBCFA9] bg-white p-4" data-item-details>
        {categoryText && (
          <span className="self-start rounded-full bg-[#FFF1E6] px-3 py-1 text-[13px] font-semibold text-[#9A3A0A]" data-item-category-chip>
            {categoryText}
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
        {dish.tags.length > 0 && (
          <p className="flex flex-wrap gap-1.5">
            {dish.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-[#DCF5E5] px-3 py-1 text-[13px] font-semibold text-[#146C37]" data-dish-tag={tag}>
                {tag === "veg" ? m.tag_veg : m.tag_spicy}
              </span>
            ))}
          </p>
        )}
        <DishBuy
          shopId={shop.id}
          lang={lang}
          lines={lines}
          labels={{
            price: it.price,
            sizes: m.sizes,
            available: m.dish_available,
            soldOut: m.sold_out_today,
            order: m.order,
            orderAria: m.order_aria,
            list: {
              add: it.list_add,
              in_list: it.list_in,
              total: it.list_total,
              minus: it.list_minus,
              plus: it.list_plus,
              remove: it.list_remove,
              count: it.list_count,
              said_added: it.list_said_added,
              said_removed: it.list_said_removed,
            },
          }}
        />
        {assistant && !ordering && (
          <Link href={askHref} className="flex min-h-[52px] items-center justify-center gap-2.5 rounded-2xl border border-[#ECE7DE] bg-white px-4 text-base font-bold" data-item-ask>
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#F57C20]" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" aria-hidden="true" focusable="false">
                <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
              </svg>
            </span>
            {m.ask}
          </Link>
        )}
      </section>

      {/* 4. Popis: the whole text. */}
      {description && (
        <section aria-labelledby="item-description" className="flex flex-col gap-2 rounded-[20px] border border-[#ECE7DE] bg-white p-4" data-item-description>
          <h2 id="item-description" className="text-[17px] font-bold">
            {it.description}
          </h2>
          <p className="text-[15px] leading-relaxed whitespace-pre-line break-words">{description}</p>
        </section>
      )}

      {/* 5. Alergény: the EU's numbers with their names (only those of this dish). */}
      {dish.allergens.length > 0 && (
        <section aria-labelledby="dish-allergens" className="flex flex-col gap-2 rounded-[20px] border border-[#ECE7DE] bg-white p-4" data-dish-allergens>
          <h2 id="dish-allergens" className="text-[17px] font-bold">
            {m.allergens}
          </h2>
          <ul className="flex flex-col">
            {dish.allergens.map((a) => (
              <li key={a} className="flex items-baseline gap-3 border-t border-[#F1EDE6] py-2 text-[15px] first:border-t-0 first:pt-0">
                <span className="w-6 shrink-0 font-bold tabular-nums">{a}</span>
                <span>{m[`allergen_${a}` as keyof typeof m]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 6. Kde kúpiť: the restaurant, its status, Navigovať and its phone, the map. */}
      <WhereToBuy
        lang={lang}
        dict={dict}
        shopName={shop.name}
        shopHref={shopHref}
        logoUrl={shop.logo_url}
        address={addressLine(shop.address, shop.city)}
        status={status}
        renderedAt={renderedAt}
        contacts={contacts}
        contactLabels={contactLabels}
        pins={shop.lat !== null && shop.lng !== null ? [{ slug: shop.slug, name: shop.name, lat: shop.lat, lng: shop.lng, href: shopHref, status }] : null}
      />
      {photo && <SectionZoom labels={{ close: dict.blog.close, zoom_in: dict.blog.zoom_in, zoom_out: dict.blog.zoom_out, prev_page: dict.blog.prev_photo, next_page: dict.blog.next_photo }} />}
    </div>
  );
}

/** schema.org's MenuItem for the dish's page: one Offer, or one per size (sold out today = SoldOut). */
function dishJsonLd(dish: MenuDish, name: string, description: string | null, currency: string, url: string) {
  const offer = (cents: number, soldOut: boolean, label?: string) => ({
    "@type": "Offer",
    ...(label ? { name: label } : {}),
    price: (cents / 100).toFixed(2),
    priceCurrency: currency,
    availability: soldOut ? "https://schema.org/SoldOut" : "https://schema.org/InStock",
  });
  return {
    "@context": "https://schema.org",
    "@type": "MenuItem",
    name,
    url,
    ...(description ? { description } : {}),
    ...(dish.photo ? { image: dish.photo.large } : {}),
    ...(dish.tags.includes("veg") ? { suitableForDiet: "https://schema.org/VegetarianDiet" } : {}),
    offers: dish.variants.length
      ? dish.variants.map((v) => offer(v.price_cents, v.sold_out || dish.sold_out, v.label))
      : offer(dish.price_cents ?? 0, dish.sold_out),
  };
}
