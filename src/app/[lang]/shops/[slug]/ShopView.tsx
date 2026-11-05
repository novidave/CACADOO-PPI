import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/components/shopPage.css";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { siteLang, sitePath, siteShopUrl } from "@/lib/customDomain";
import { getShop, getShopCalendars, getShopItems, searchShopItems, shopHasPlan, shopCompany, shopContactButtons, shopperPdfAllowed, shopSiteHost, shopStockResetting, type PublicShop } from "@/lib/data";
import { archiveEnabled } from "@/lib/assistantArchive";
import { blogCount, getBlogPost, photoSrc } from "@/lib/blog";
import { placedPhotos } from "@/lib/blogMarks";
import { blogPath } from "@/lib/blogFormat";
import { docsKeysEnabled } from "@/lib/docsAccess";
import { addressLine } from "@/lib/format";
import { contactButtons, contactWidths, CONTACT_KEYS, isAndroid } from "@/lib/contactButtons";
import { dishRows, productRow } from "@/lib/shopRows";
import {
  dayName,
  displayTime,
  hasHours,
  localDateTime,
  type StatusInput,
  upcomingDays,
  weekdayOf,
  weekHours,
} from "@/lib/hours";
import { requestTime } from "@/lib/requestTime";
import { STATUS_PILLS } from "@/lib/statusColors";
import { statusInput } from "@/lib/shopCalendar";
import { shopChatEnabled } from "@/lib/shopChat";
import { storeJsonLd } from "@/lib/jsonLd";
import { pageAlternates, siteUrl } from "@/lib/site";
import { getShopContent, postImage, slideViews } from "@/lib/sections";
import { articlePhoto, readingMinutes, sliderRatio } from "@/lib/pageContent";
import { InlineArticle } from "@/components/InlineArticle";
import { getShopLanguages } from "@/lib/shopLanguages";
import { getShopTexts } from "@/lib/contentTranslations";
import { TranslatingRefresh } from "@/components/TranslatingRefresh";
import { freshnessText } from "@/lib/stock";
import { AmenityPills } from "@/components/AmenityPills";
import { ShopBackdrop } from "@/components/ShopBackdrop";
import { ContactButtons } from "@/components/ContactButtons";
import { JsonLd } from "@/components/JsonLd";
import { ContentSlider } from "@/components/ContentSlider";
import { SectionZoom } from "@/components/SectionZoom";
import { ShopAssistant } from "@/components/ShopAssistant";
import { ShopMap } from "@/components/ShopMap";
import { ShopStatusLine } from "@/components/ShopStatusLine";
import { ShopProducts } from "@/components/ShopProducts";
import { productLabels } from "@/lib/productLabels";
import { foodState } from "@/lib/food";
import { categoryName, getShopMenu, searchShopMenu } from "@/lib/menu";
import { menuJsonLd, orderLines } from "@/lib/menuRules";
import { itemNames } from "@/lib/names";

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
  const [host, langs, { items, total, kind }, assistant, shopperPdf, calendars, content, posts, company, widths, menu] = await Promise.all([
    shopSiteHost(shop.slug).catch(() => null),
    getShopLanguages(shop.slug, shop.country),
    // With words the forgiving search (update 54): exact hits first, then close ones, else the most similar names.
    q
      ? searchShopItems(shop.slug, q, PAGE_SIZE, (requestedPage - 1) * PAGE_SIZE)
      : getShopItems(shop.slug, q, requestedPage, PAGE_SIZE).then((r) => ({ ...r, kind: null })),
    shopChatEnabled() ? shopHasPlan(shop.id) : Promise.resolve(false),
    // "Stiahnuť túto konverzáciu (PDF)" (database update 24): only with the archive on.
    archiveEnabled() ? shopperPdfAllowed(shop.slug).catch(() => false) : Promise.resolve(false),
    // Special days and holidays (database update 27): the status and the next 60 days.
    getShopCalendars([shop.id], 60).catch(() => new Map()),
    // "Obsah stránky" (database update 38): the slides the database shows (none before it).
    getShopContent(shop.slug).catch(() => null),
    // The blog (database update 37): "Novinky" only with at least one post shown.
    blogCount(shop.slug).catch(() => 0),
    // PSČ, company name, IČO and DIČ under the address (database update 48; nothing before it).
    shopCompany(shop.slug).catch(() => null),
    // Short / long contact buttons (database update 51; the defaults before it).
    shopContactButtons(shop.slug).catch(() => ({})),
    // A restaurant's Menu (database update 80): null for every other shop (and before update 80).
    getShopMenu(shop.slug).catch(() => null),
  ]);
  // A restaurant (update 84): its dishes in the same box — the search's dishes (?q= without JavaScript), and
  // "Objednať" from a dish's page (?order=<menu item>) while ordering in the assistant is on.
  const orderId = menu && assistant ? (first(sp.order) ?? "").toLowerCase() : "";
  const orderDish = orderId ? menu?.items.find((d) => orderLines(d).some((l) => l.id === orderId)) : undefined;
  const [menuFound, food] = menu
    ? await Promise.all([
        q.length >= 2 ? searchShopMenu(shop.slug, q).catch(() => []) : Promise.resolve(null),
        orderDish ? foodState(shop.slug).catch(() => null) : Promise.resolve(null),
      ])
    : [null, null];
  if (onSite && !host) notFound();
  const orderLine = orderDish && food?.enabled ? orderLines(orderDish).find((l) => l.id === orderId && !l.sold_out) : undefined;
  const order = orderDish && orderLine
    ? { id: orderLine.id, text: t(dict.menu.order_message, { name: orderLine.label ? `${orderDish.name} ${orderLine.label}` : orderDish.name }) }
    : null;
  const dishes = menu ? dishRows(menu, lang, q.length >= 2 ? q : "", menuFound) : null;
  const listed = dishes ? dishes.length : total;
  // No products at all after "Vymazať celý sklad" (update 43): "Sortiment sa práve aktualizuje" until the next file.
  const resetting = !menu && items.length === 0 && !q ? await shopStockResetting(shop.slug).catch(() => false) : false;
  const pages = Math.max(1, Math.ceil(listed / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  // The shop's texts in the visitor's language (update 40): the original stays; "Zobraziť originál" = ?original=1.
  const original = first(sp.original) === "1";
  const postIds = (content?.slides ?? []).flatMap((s) => (s.kind === "post" ? [s.post.id] : []));
  // The posts' full texts and photos for the inline articles under the slider (Screen 11; one cached read each, ≤ 10).
  const postSlugs = (content?.slides ?? []).flatMap((s) => (s.kind === "post" ? [s.post.slug] : []));
  const [texts, fullPosts] = await Promise.all([
    getShopTexts(shop.slug, lang, langs, original, [
      { kinds: ["assistant_label", "assistant_welcome", "special_note", "content_title", "section_title", "section_alt"] },
      { kinds: ["blog_title", "blog_body"], refs: postIds },
      // a restaurant's dishes: their descriptions and categories (the names come with the menu, name_i18n)
      { kinds: ["item_description", "item_category"], refs: menu?.items.map((d) => d.id) ?? [] },
    ]),
    Promise.all(postSlugs.map((p) => getBlogPost(shop.slug, p).catch(() => null))),
  ]);
  const shopPath = onSite ? sitePath(lang, defaultLang) : `/${lang}/shops/${shop.slug}`;

  // "Budince 26, 040 01 Budince": the PSČ before the town (update 48).
  const address = addressLine(shop.address, [company?.zip, shop.city].filter(Boolean).join(" "));
  const companyParts = [
    company?.company_name,
    company?.ico ? `${dict.shop.company_ico} ${company.ico}` : null,
    company?.dic ? `${dict.shop.company_dic} ${company.dic}` : null,
  ].filter(Boolean);
  const hasLocation = shop.lat !== null && shop.lng !== null;
  // Green pills, only those the shop has (Screen 11).
  const amenities = [
    shop.has_toilet && { key: "toilet" as const, text: dict.shop.toilet },
    shop.has_douchette && { key: "douchette" as const, text: dict.shop.douchette },
    shop.has_card_terminal && { key: "card" as const, text: dict.shop.card_terminal },
  ].filter((a): a is { key: "toilet" | "douchette" | "card"; text: string } => Boolean(a));
  // Navigovať on Android = a geo: link (the Maps app), decided from this request's user agent (the first HTML is right)
  const android = isAndroid((await headers()).get("user-agent"));
  const contacts = contactButtons(
    { ...shop, zip: company?.zip },
    contactWidths(widths),
    { facebook: dict.shop.facebook, booking: dict.shop.booking, web: dict.shop.website, navigate: dict.shop.directions },
    { android },
  );
  const cb = dict.contact_buttons;
  const contactLabels = {
    hold: cb.hold,
    release: cb.release,
    announce: cb.announce,
    done: Object.fromEntries(CONTACT_KEYS.map((k) => [k, cb[`done_${k}`]])) as Record<(typeof CONTACT_KEYS)[number], string>,
  };
  const input = statusInput(shop, calendars);
  const renderedAt = requestTime();
  const place = { shopSlug: shop.slug, country: shop.country, host, homeLang: shop.site_lang };
  const slides = content ? slideViews(content, { shopId: shop.id, slug: shop.slug, lang, timeZone: shop.timezone, place, onSite, texts }) : [];
  // Each post's article as written (in the visitor's language when translated), keyed like its slide.
  const articles: Record<string, ReactNode> = {};
  for (const post of fullPosts) {
    if (!post?.id) continue;
    const view = slides.find((v) => v.key === `post-${post.id}`);
    if (!view || view.kind !== "post") continue;
    const body = texts.text("blog_body", post.id, post.body);
    // update 77: the photos the text places ([[foto:id]]) are drawn there; the article's own photo only when not placed
    const placed = new Set(post.formatted ? placedPhotos(body, post.photos.filter((p) => p.kind === "photo").map((p) => p.id)) : []);
    const photo = articlePhoto(post.photos.filter((p) => !placed.has(p.id)));
    articles[view.key] = (
      <InlineArticle
        meta={t(dict.content.blog_meta, { date: view.date, n: String(readingMinutes(body)) })}
        title={view.title}
        body={body}
        photo={photo ? postImage(photo) : null}
        formatted={post.formatted}
        photos={post.photos
          .filter((p) => placed.has(p.id))
          .map((p) => ({ id: p.id, small: photoSrc(p.small), large: photoSrc(p.large), width: p.width, height: p.height }))}
      />
    );
  }
  const contentTitle = texts.text("content_title", shop.id, content?.title ?? null);
  const assistantLabel = texts.text("assistant_label", shop.id, shop.assistant_label);
  const assistantWelcome = texts.text("assistant_welcome", shop.id, shop.assistant_welcome);
  const notes = new Map(upcomingDays(input, new Date(renderedAt), 14).flatMap((d) => (d.note ? [[d.date, texts.text("special_note", d.date, d.note)] as const] : [])));
  const newsHref = blogPath(lang, place, onSite);
  // "Všetky novinky" under the slider when the shop has posts; else the "Novinky" link in the details (never both).
  const sliderNews = slides.length > 0 && Boolean(content?.has_posts);
  // JSON-LD: the shop; a restaurant (update 80) is a Restaurant with its Menu, in the page language's words.
  const store = storeJsonLd({ ...shop, ...company }, lang, host, input, siteUrl());
  const storeLd = menu
    ? {
        ...store,
        "@type": "Restaurant",
        hasMenu: menuJsonLd(menu, store.url, {
          name: (d) => itemNames(d.name, d.name_i18n, lang).primary,
          description: (d) => texts.text("item_description", d.id, d.description),
          section: (c) => categoryName(c, menu.items.filter((d) => d.category_id === c?.id), texts, dict.menu.other),
          image: (p) => p.large,
        }),
      }
    : store;

  return (
    <div className="relative isolate mx-auto flex w-full max-w-[760px] flex-col gap-6" data-shop-page>
      {/* Artboard 12's background (pale animals drifting with the scroll), behind every card; decoration only. */}
      <ShopBackdrop />
      <JsonLd data={{ "@context": "https://schema.org", ...storeLd }} />

      {/* 1. The shop's name and logo, its details under them (on its own domain too). Screen 11 (2026-10-31). */}
      <header className="flex flex-col" data-shop-details>
        <div className="flex items-center gap-3.5">
          {shop.logo_url && (
            <span className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-xl border border-[#E0E0E0] bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element -- logos come from Supabase Storage */}
              <img src={shop.logo_url} alt="" width={36} height={36} className="h-9 w-9 object-contain" />
            </span>
          )}
          <h1 className="text-2xl font-medium">{shop.name}</h1>
        </div>
        {address && <p className="mt-3.5 text-base">{address}</p>}
        {companyParts.length > 0 && (
          <p className="mt-3 self-start bg-[#FBF6EC] text-[13px] text-[#6E6E6E]" data-shop-company>
            {companyParts.join(" · ")}
          </p>
        )}
        {amenities.length > 0 && (
          <div className="mt-3">
            <AmenityPills items={amenities} label={dict.shop.facilities} />
          </div>
        )}
        {/* The contact buttons (update 51, Screen 11): two columns, real links, press and hold. */}
        {contacts.length > 0 && (
          <div className="mt-4" data-shop-contacts>
            <ContactButtons buttons={contacts} labels={contactLabels} />
          </div>
        )}
        {posts > 0 && !sliderNews && (
          <p className="mt-3 text-sm">
            <Link href={newsHref} className="underline underline-offset-4" data-shop-news>
              {dict.shop.news}
            </Link>
          </p>
        )}
      </header>

      {/* No "Preložené automaticky · Zobraziť originál" on customer pages (2026-11-04, at the owner's request; ?original=1
          still works). While a text is still being translated, the page looks again once, 20 s later. */}
      {texts.missing && <TranslatingRefresh />}

      {/* 2. The map with the shop's status dot (an extra: the page works without it). */}
      {hasLocation && (
        <ShopMap
          shops={[{ slug: shop.slug, name: shop.name, lat: shop.lat!, lng: shop.lng!, href: shopPath, status: input }]}
          label={dict.shop.map}
          className="h-[222px]"
          statusLabels={dict.status}
          renderedAt={renderedAt}
        />
      )}

      {/* 3. Opening hours: one card (the status pill, the coming holidays and special days, the week); then "Obsah
          stránky" (update 38): after the opening hours, before the assistant (a free page: before the items). Every
          card of the page is a child of the one column, so every gap is the same (gap-6). */}
      <HoursSection shop={shop} input={input} lang={lang} dict={dict} renderedAt={renderedAt} notes={notes} />
      {slides.length > 0 && content && (
        <ContentSlider
          views={slides}
          title={contentTitle ?? dict.content.default_title}
          showTitle={content.show_title}
          display={content.display}
          allNews={sliderNews ? newsHref : null}
          labels={dict.content}
          lang={lang}
          ratio={sliderRatio(content.ratio)}
          articles={articles}
          hold={dict.contact_buttons.hold}
          release={dict.contact_buttons.release}
          first
        />
      )}

      {/* 4. and 5. The assistant (paid plan): always open; "Mám prístupový kľúč" as a closed dropdown under it. */}
      {assistant && (
        <ShopAssistant
          // "Opýtať sa asistenta" from a product page or a post: the question written for the shopper (≤ 300)
          question={(first(sp.ask) ?? "").slice(0, 300)}
          // "Objednať" on a dish's page (update 84): that dish goes to the assistant with its question at once
          order={order}
          slug={shop.slug}
          shopId={shop.id}
          lang={lang}
          shopName={shop.name}
          timeZone={shop.timezone}
          keys={docsKeysEnabled()}
          labels={dict.chat}
          buttonLabel={assistantLabel}
          welcome={assistantWelcome}
          archive={archiveEnabled()}
          shopperPdf={shopperPdf}
          // the header's list button only where the page has the shopper's Zoznam for goods (not a restaurant's Menu)
          listButton={!menu}
        />
      )}

      {/* 6. The items: "Produkty" and the visitor's "Zoznam" (2026-10-29). A restaurant (update 84, at the owner's request):
          the same box, the first tab "Jedlá" — its dishes (a dish or each size) with the dot and the price; no stock line
          (dishes are not stock: no file, no freshness). */}
      <section id="items" className="flex scroll-mt-4 flex-col gap-3" aria-labelledby="items-heading">
        <h2 id="items-heading" className="sr-only">
          {menu ? dict.shop.tab_dishes : dict.shop.items}
        </h2>
        {!menu && (
          <p className="text-sm" data-shop-stock-line>
            <span className="text-muted">{dict.shop.stock}: </span>
            {freshnessText(dict, shop.freshness_state, shop.freshness_age_minutes, shop.latest_file_time, shop.timezone)}
          </p>
        )}
        <ShopProducts
          shopId={shop.id}
          slug={shop.slug}
          lang={lang}
          path={shopPath}
          itemBase={`/${lang}/items/`}
          shopName={shop.name}
          address={address || null}
          initial={
            dishes
              ? {
                  q: q.length >= 2 ? q : "",
                  kind: q.length >= 2 ? (dishes.length ? "match" : null) : null,
                  total: dishes.length,
                  rows: dishes.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
                }
              : { q, kind, total, rows: items.map((item) => productRow(item, lang)) }
          }
          page={page}
          pageSize={PAGE_SIZE}
          emptyNote={
            menu
              ? { text: dict.menu.empty, kind: "menu" }
              : resetting
                ? { text: dict.shop.stock_updating, kind: "updating" }
                : { text: dict.shop.no_items, kind: "none" }
          }
          labels={productLabels(dict, Boolean(menu))}
        />
      </section>

      {/* The shop's own "Právne informácie" (update 65); on its own domain the layout's footer has the link. */}
      {!onSite && (
        <Link href={`/${lang}/shops/${shop.slug}/pravne-informacie`} className="flex min-h-11 items-center self-start text-sm text-muted underline underline-offset-4" data-shop-legal-link>
          {dict.shop_legal.link}
        </Link>
      )}

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
  // this week's real hours: a special day in the coming 7 days replaces its weekday's regular row (2026-11-04)
  const week = weekHours(input, now);
  const dateText = (date: string) =>
    new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  const pill = STATUS_PILLS.closed;
  return (
    <section aria-labelledby="hours-heading" className="rounded-[20px] border border-[#ECE7DE] bg-white px-4 pt-4 pb-2" data-hours>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2.5">
        <h2 id="hours-heading" className="text-[19px] font-bold">
          {dict.shop.hours}
        </h2>
        <span data-status-line>
          <ShopStatusLine input={input} labels={dict.status} lang={lang} renderedAt={renderedAt} pill />
        </span>
      </div>
      {/* The holidays and the owner's special days of the next 14 days, in the closed pill's red; nothing when none. */}
      {coming.length > 0 && (
        <>
          <ul className="mb-3 flex flex-col items-start gap-1.5 text-sm" aria-label={dict.status.upcoming} data-hours-upcoming>
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
              const about = [name, notes.get(d.date) ?? d.note].filter(Boolean).join(" · ");
              return (
                <li
                  key={d.date}
                  className="rounded-xl px-2.5 py-1 font-semibold"
                  style={{ background: pill.bg, color: pill.fg }}
                  data-special-day={d.date}
                >
                  <span className="capitalize">{dateText(d.date)}</span> · {hours}
                  {about && <span className="font-normal"> · {about}</span>}
                </li>
              );
            })}
          </ul>
          <hr className="mb-1 border-line" data-hours-divider />
        </>
      )}
      {hasHours(shop.opening_hours) && (
        <table className="w-full text-[15px]">
          <tbody>
            {week.map(({ day, ranges, changed, date }) => {
              const isToday = day === today;
              return (
                <tr
                  key={day}
                  className={isToday ? "ppi-hours-today" : "ppi-hours-row"}
                  data-day={day}
                  {...(isToday ? { "data-today": "" } : {})}
                  {...(changed ? { "data-special-row": date } : {})}
                >
                  <th scope="row" className={`py-[9px] pr-4 text-left capitalize ${isToday ? "font-bold" : "font-normal"}`}>
                    {dayName(day, lang)}
                    {isToday && <span className="text-xs font-semibold normal-case text-[#6B5310]"> · {dict.status.today}</span>}
                  </th>
                  <td className={`py-[9px] text-right ${isToday ? "font-bold" : ""}`}>
                    {ranges.length ? rangeText(ranges) : <span className="text-[#5B6670]">{dict.shop.closed}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
