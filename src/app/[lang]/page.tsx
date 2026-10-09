import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import Link from "next/link";
import { aiSearchEnabled } from "@/lib/aiSearch";
import { createClient } from "@/lib/supabase/server";
import { getShopsByIds, type PublicShop } from "@/lib/data";
import { missingSupabaseEnv, supabaseEnv } from "@/lib/supabase/env";
import { formatPrice } from "@/lib/format";
import { translatedName } from "@/lib/names";
import type { StockRow } from "@/lib/stock";
import { AiSearch } from "@/components/AiSearch";
import { OpenStatus } from "@/components/OpenStatus";
import { ShopMap } from "@/components/ShopMap";
import { StockLine } from "@/components/StockLine";


function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function HomePage({ params, searchParams }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim();
  const onlyAvailable = first(sp.only) === "1";
  // AI is an extra layer above the plain results, only when the shopper asks for it.
  const aiEnabled = aiSearchEnabled();
  const askAi = aiEnabled && first(sp.ai) === "1" && q.length >= 2;

  let rows: StockRow[] = [];
  let shops = new Map<string, PublicShop>();
  let error: string | null = null;

  try {
    const supabase = await createClient();
    if (!supabase) {
      error = `${dict.search.not_connected} (${missingSupabaseEnv().join(", ")})`;
    } else if (q) {
      // No location: every shop is searched, by item, brand, EAN, shop name, street or town.
      const result = await supabase.rpc("search_stock", { q, lat: null, lng: null, only_available: onlyAvailable });
      if (result.error) {
        // Name the (public) project address so setup mistakes are visible.
        error = `${result.error.message} · Supabase: ${supabaseEnv()?.url}`;
      }
      rows = (result.data ?? []) as StockRow[];
      // Opening hours for "Open now"; one extra query for all result shops.
      if (!result.error) shops = await getShopsByIds([...new Set(rows.map((r) => r.shop_id))]);
    }
  } catch (e) {
    // e.g. a mistyped Supabase URL: show it instead of a blank 500 page.
    error = `${dict.search.not_connected} (${e instanceof Error ? e.message : String(e)})`;
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted">{dict.site.tagline}</p>

      <form method="get" className="flex max-w-3xl flex-col gap-3" role="search">
        <div className="flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder={dict.search.placeholder}
            aria-label={dict.search.placeholder}
            className="min-w-0 flex-1 rounded border border-line px-3 py-2 outline-none focus:border-foreground"
          />
          <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium">
            {dict.search.button}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="only" value="1" defaultChecked={onlyAvailable} />
            {dict.search.only_available}
          </label>
          {aiEnabled && (
            <button type="submit" name="ai" value="1" className="rounded border border-line px-3 py-1">
              {dict.search.ai_button}
            </button>
          )}
        </div>
      </form>

      {askAi && (
        <AiSearch
          key={`${q}|${onlyAvailable}`}
          q={q}
          lang={lang}
          only={onlyAvailable}
          labels={{
            title: dict.search.ai_title,
            loading: dict.search.ai_loading,
            searched: dict.search.ai_searched,
            note: dict.search.ai_note,
            unavailable: dict.search.ai_unavailable,
          }}
        />
      )}

      {error && <p className="rounded border border-line p-3 text-sm">{error}</p>}

      {q && !error && (
        <section aria-label={dict.search.results}>
          {rows.length === 0 ? (
            <p>{dict.search.empty_everywhere}</p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
              <div className="lg:sticky lg:top-4 lg:order-2">
                <ShopMap
                  shops={[...new Map(rows.filter((r) => r.shop_lat !== null && r.shop_lng !== null).map((r) => [r.shop_slug, r])).values()].map((r) => ({
                    slug: r.shop_slug,
                    name: r.shop_name,
                    lat: r.shop_lat!,
                    lng: r.shop_lng!,
                    href: `/${lang}/shops/${r.shop_slug}`,
                  }))}
                  label={dict.shop.map}
                />
              </div>
              <ul className="divide-y divide-line border-y border-line lg:order-1">
                {rows.map((row) => (
                  <ResultRow key={row.item_id} row={row} shop={shops.get(row.shop_id)} lang={lang} dict={dict} />
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function ResultRow({
  row,
  shop,
  lang,
  dict,
}: {
  row: StockRow;
  shop: PublicShop | undefined;
  lang: Locale;
  dict: Dictionary;
}) {
  const translated = translatedName(row.item_name, row.item_name_i18n, lang);
  return (
    <li data-shop={row.shop_slug} className="flex flex-col gap-1 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/${lang}/items/${row.item_id}`} className="font-medium hover:underline">
            {row.item_name}
          </Link>
          {translated && <p className="text-sm text-muted">{translated}</p>}
        </div>
        <span className="whitespace-nowrap font-medium">{formatPrice(row.price, lang, row.currency)}</span>
      </div>
      <div className="text-sm text-muted">
        <Link href={`/${lang}/shops/${row.shop_slug}`} className="hover:underline">
          {row.shop_name}
        </Link>
        {[row.shop_address, row.shop_city].filter(Boolean).map((part) => ` · ${part}`)}
      </div>
      <div className="flex flex-wrap gap-x-3 text-sm">
        <StockLine row={row} timeZone={row.shop_timezone} dict={dict} lang={lang} />
        {shop && <OpenStatus hours={shop.opening_hours} timeZone={shop.timezone} lang={lang} dict={dict} />}
      </div>
    </li>
  );
}
