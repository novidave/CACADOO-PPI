import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { siteLang, sitePath, siteShopUrl } from "@/lib/customDomain";
import { getShop, getShopCalendars, getShopItems, searchShopItems, shopHasPlan, shopCompany, shopContactButtons, shopperPdfAllowed, shopSiteHost, shopStockResetting, type PublicShop } from "@/lib/data";
import { archiveEnabled } from "@/lib/assistantArchive";
import { blogCount } from "@/lib/blog";
import { blogPath } from "@/lib/blogFormat";
import { docsKeysEnabled } from "@/lib/docsAccess";
import { addressLine } from "@/lib/format";
import { contactButtons, contactWidths, CONTACT_KEYS } from "@/lib/contactButtons";
import { productRow } from "@/lib/shopRows";
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
import { sliderRatio } from "@/lib/pageContent";
import { getShopLanguages } from "@/lib/shopLanguages";
import { getShopTexts } from "@/lib/contentTranslations";
import { TranslationNote } from "@/components/TranslationNote";
import { freshnessText } from "@/lib/stock";
import { ContactButtons } from "@/components/ContactButtons";
import { JsonLd } from "@/components/JsonLd";
import { ContentSlider } from "@/components/ContentSlider";
import { SectionZoom } from "@/components/SectionZoom";
import { ShopAssistant } from "@/components/ShopAssistant";
import { ShopMap } from "@/components/ShopMap";
import { ShopStatusLine } from "@/components/ShopStatusLine";
import { ShopProducts, type ShopProductsLabels } from "@/components/ShopProducts";

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
  const [host, langs, { items, total, kind }, assistant, shopperPdf, calendars, content, posts, company, widths] = await Promise.all([
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

  // "Budince 26, 040 01 Budince": the PSČ before the town (update 48).
  const address = addressLine(shop.address, [company?.zip, shop.city].filter(Boolean).join(" "));
  const companyParts = [
    company?.company_name,
    company?.ico ? `${dict.shop.company_ico} ${company.ico}` : null,
    company?.dic ? `${dict.shop.company_dic} ${company.dic}` : null,
  ].filter(Boolean);
  const hasLocation = shop.lat !== null && shop.lng !== null;
  const contacts = contactButtons({ ...shop, zip: company?.zip }, contactWidths(widths), {
    facebook: dict.shop.facebook,
    booking: dict.shop.booking,
    web: dict.shop.website,
    navigate: dict.shop.directions,
  });
  const cb = dict.contact_buttons;
  const contactLabels = {
    hold: cb.hold,
    announce: cb.announce,
    done: Object.fromEntries(CONTACT_KEYS.map((k) => [k, cb[`done_${k}`]])) as Record<(typeof CONTACT_KEYS)[number], string>,
  };
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
      <JsonLd data={{ "@context": "https://schema.org", ...storeJsonLd({ ...shop, ...company }, lang, host, input, siteUrl()) }} />

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
        {companyParts.length > 0 && (
          <p className="text-sm text-muted" data-shop-company>
            {companyParts.join(" · ")}
          </p>
        )}
        {(shop.has_toilet || shop.has_douchette) && (
          <p className="text-sm">
            <span className="text-muted">{dict.shop.facilities}: </span>
            <span className="font-semibold">
              {[shop.has_toilet && dict.shop.toilet, shop.has_douchette && dict.shop.douchette].filter(Boolean).join(" · ")}
            </span>
          </p>
        )}
        {shop.has_card_terminal && <p className="text-sm font-semibold">{dict.shop.card_terminal}</p>}
        {/* The contact buttons (update 51): two columns, press and hold; without JavaScript plain links. */}
        {contacts.length > 0 && (
          <div className="pt-1" data-shop-contacts>
            <ContactButtons buttons={contacts} labels={contactLabels} />
            <noscript>
              <style>{"[data-contact-buttons]{display:none}"}</style>
              <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {contacts.map((c) => (
                  <a key={c.key} href={c.href} className="underline underline-offset-4" {...(c.newTab ? { target: "_blank", rel: "noopener" } : {})}>
                    {c.label}
                  </a>
                ))}
              </span>
            </noscript>
          </div>
        )}
        {posts > 0 && !sliderNews && (
          <p className="text-sm">
            <Link href={newsHref} className="underline underline-offset-4" data-shop-news>
              {dict.shop.news}
            </Link>
          </p>
        )}
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
          ratio={sliderRatio(content.ratio)}
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

      {/* 6. The items: "Produkty" and the visitor's "Zoznam" (2026-10-29). */}
      <section id="items" className="flex scroll-mt-4 flex-col gap-3" aria-labelledby="items-heading">
        <h2 id="items-heading" className="sr-only">
          {dict.shop.items}
        </h2>
        <p className="text-sm">
          <span className="text-muted">{dict.shop.stock}: </span>
          {freshnessText(dict, shop.freshness_state, shop.freshness_age_minutes, shop.latest_file_time, shop.timezone)}
        </p>
        <ShopProducts
          shopId={shop.id}
          slug={shop.slug}
          lang={lang}
          path={shopPath}
          itemBase={`/${lang}/items/`}
          shopName={shop.name}
          address={address || null}
          initial={{ q, kind, total, rows: items.map((item) => productRow(item, lang)) }}
          page={page}
          pageSize={PAGE_SIZE}
          emptyNote={resetting ? { text: dict.shop.stock_updating, kind: "updating" } : { text: dict.shop.no_items, kind: "none" }}
          labels={productLabels(dict)}
        />
      </section>

      {slides.some((v) => v.kind !== "post") && <SectionZoom labels={dict.sections} />}
    </div>
  );
}

/** The texts of the products tabs (ShopProducts / ShopList), in the page language. */
function productLabels(dict: Dictionary): ShopProductsLabels {
  const s = dict.shop;
  return {
    tabs: s.tabs_label,
    products: s.tab_products,
    list: s.tab_list,
    listCount: s.tab_list_count,
    placeholder: s.search_items,
    clear: s.search_clear,
    button: dict.search.button,
    found: { one: s.found_one, few: s.found_few, other: s.found_other },
    none: s.search_none,
    similar: s.search_similar,
    add: s.list_add,
    addMore: s.list_add_more,
    status: { dot_available: dict.stock.dot_available, dot_sold_out: dict.stock.dot_sold_out, dot_no_info: dict.stock.dot_no_info },
    prev: s.prev,
    next: s.next,
    pageOf: s.page_of,
    said: { added: s.said_added, less: s.said_less, removed: s.said_removed, copied: s.said_copied, copyFailed: s.said_copy_failed },
    shopList: {
      title: s.list_title,
      empty: s.list_empty,
      total: s.list_total,
      minus: s.list_minus,
      plus: s.list_plus,
      remove: s.list_remove,
      qty: s.list_qty,
      swipe: s.list_swipe,
      copy: s.list_copy,
      copied: s.list_copied,
      copyManual: s.list_copy_manual,
    },
  };
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
        <ShopStatusLine input={input} labels={dict.status} lang={lang} renderedAt={renderedAt} />
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
