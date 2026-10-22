import { searchAcrossLanguages } from "@/lib/queryExpansion";
import type { Viewport } from "next";
import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { itemHref, shopHref } from "@/lib/customDomain";
import { createCachedPublicClient } from "@/lib/supabase/public";
import { getLiveSites, getShopCalendars, getShopsByIds, type PublicShop } from "@/lib/data";
import { missingSupabaseEnv, supabaseEnv } from "@/lib/supabase/env";
import { formatPrice } from "@/lib/format";
import { translatedName } from "@/lib/names";
import type { StockRow } from "@/lib/stock";
import { ChatSearch, type ChatLabels } from "@/components/ChatSearch";
import { LiveStatus } from "@/components/ShopStatus";
import type { CalendarDay } from "@/lib/hours";
import { requestTime } from "@/lib/requestTime";
import { statusInput } from "@/lib/shopCalendar";
import { StockLine } from "@/components/StockLine";

// The chat input sits above the phone's home bar (env(safe-area-inset-bottom)).
export const viewport: Viewport = { viewportFit: "cover" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The main page (Prompt 10): one chat search in the middle of the screen (ChatSearch). For
 * crawlers, shared links and visitors without JavaScript, /[lang]?q=… also renders the plain
 * database search in the first HTML (no map, no AI); with JavaScript such a link starts the chat
 * with its question instead. No location: search is text only, the town is what the shopper writes.
 */
export default async function HomePage({ params, searchParams }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim().slice(0, 300);

  const s = dict.search;
  const labels: ChatLabels = {
    headline: s.headline,
    placeholder: s.placeholder,
    follow_up: s.follow_up,
    send: s.send,
    stop: s.stop,
    new_chat: s.new_chat,
    examples: [s.example_1, s.example_2, s.example_3],
    examples_label: s.examples_label,
    you: s.you,
    assistant: s.assistant,
    step_understand: s.step_understand,
    step_search: s.step_search,
    step_verify: s.step_verify,
    fallback_note: s.fallback_note,
    limited: s.limited,
    unavailable: s.ai_unavailable,
    nothing_found: s.nothing_found,
    searched: s.ai_searched,
    stopped: s.stopped,
    error: s.error,
    show_more: s.show_more,
    show_map: s.show_map,
    hide_map: s.hide_map,
    ai_note: s.ai_note,
    results: s.results,
    map: dict.shop.map,
    keyboard_hint: s.keyboard_hint,
    step_partners: s.step_partners,
    step_nearby: s.step_nearby,
    step_web: s.step_web,
    group_cacaduu: s.group_cacaduu,
    group_partners: s.group_partners,
    partner_tag: s.partner_tag,
    partner_affiliate: s.partner_affiliate,
    partner_regular: s.partner_regular,
    group_nearby: s.group_nearby,
    group_web: s.group_web,
    may_have: s.may_have,
    call: s.call,
    navigate: s.navigate,
    osm_link: s.osm_link,
    osm_attribution: s.osm_attribution,
    google_attribution: s.google_attribution,
    google_open: s.google_open,
    web_from: s.web_from,
    deep_links: s.deep_links,
    only_cacaduu: s.only_cacaduu,
    privacy_link: s.privacy_link,
  };

  return (
    <ChatSearch lang={lang} labels={labels} statusLabels={dict.status} initialQuestion={q.length >= 2 ? q : null}>
      {q.length >= 2 ? <PlainResults q={q} lang={lang} dict={dict} /> : null}
    </ChatSearch>
  );
}

/** The plain database search (search_stock), server-rendered: the page's first HTML for ?q=…. */
async function PlainResults({ q, lang, dict }: { q: string; lang: Locale; dict: Dictionary }) {
  const renderedAt = requestTime();
  let rows: StockRow[] = [];
  let shops = new Map<string, PublicShop>();
  let calendars = new Map<string, CalendarDay[]>();
  // Shops with a live own domain: their results link there (the canonical address).
  let sites = new Map<string, string>();
  let error: string | null = null;

  try {
    // The same answer for every visitor: through the short shared cache (search_stock is a read).
    const supabase = createCachedPublicClient();
    if (!supabase) {
      error = `${dict.search.not_connected} (${missingSupabaseEnv().join(", ")})`;
    } else {
      // No location: every shop is searched, by item, brand, EAN, shop name, street or town.
      // Every language (update 40): a search with no hit (or in Chinese) also in Claude's words.
      const run = async (words: string) => {
        const result = await supabase.rpc("search_stock", { q: words, lat: null, lng: null, only_available: false });
        if (result.error) throw new Error(`${result.error.message} · Supabase: ${supabaseEnv()?.url}`);
        return (result.data ?? []) as StockRow[];
      };
      let failed: string | null = null;
      try {
        rows = await searchAcrossLanguages(q, run, (r) => r.item_id);
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e);
      }
      error = failed;
      if (!error) {
        const ids = [...new Set(rows.map((r) => r.shop_id))];
        [shops, calendars, sites] = await Promise.all([getShopsByIds(ids), getShopCalendars(ids).catch(() => new Map()), getLiveSites()]);
      }
    }
  } catch (e) {
    error = `${dict.search.not_connected} (${e instanceof Error ? e.message : String(e)})`;
  }

  if (error) return <p className="rounded border border-line p-3 text-sm">{error}</p>;
  return (
    <section aria-label={dict.search.results} data-plain-results>
      {rows.length === 0 ? (
        <p>{dict.search.empty_everywhere}</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {rows.map((row) => (
            <ResultRow key={row.item_id} row={row} shop={shops.get(row.shop_id)} calendars={calendars} sites={sites} renderedAt={renderedAt} lang={lang} dict={dict} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ResultRow({
  row,
  shop,
  calendars,
  sites,
  renderedAt,
  lang,
  dict,
}: {
  row: StockRow;
  shop: PublicShop | undefined;
  calendars: Map<string, CalendarDay[]>;
  sites: Map<string, string>;
  renderedAt: number;
  lang: Locale;
  dict: Dictionary;
}) {
  const translated = translatedName(row.item_name, row.item_name_i18n, lang);
  return (
    <li data-shop={row.shop_slug} className="flex flex-col gap-1 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <a href={itemHref(sites, lang, row.shop_slug, row.item_id)} className="font-medium hover:underline">
            {row.item_name}
          </a>
          {translated && <p className="text-sm text-muted">{translated}</p>}
        </div>
        <span className="whitespace-nowrap font-medium">{formatPrice(row.price, lang, row.currency)}</span>
      </div>
      <div className="text-sm text-muted">
        <a href={shopHref(sites, lang, row.shop_slug, row.shop_country)} className="hover:underline">
          {row.shop_name}
        </a>
        {[row.shop_address, row.shop_city].filter(Boolean).map((part) => ` · ${part}`)}
      </div>
      <div className="flex flex-wrap gap-x-3 text-sm">
        <StockLine row={row} timeZone={row.shop_timezone} dict={dict} lang={lang} />
        {shop && <LiveStatus input={statusInput(shop, calendars)} labels={dict.status} lang={lang} renderedAt={renderedAt} />}
      </div>
    </li>
  );
}
