import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { enabledLocales, getDictionary } from "@/i18n/dictionaries";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { forwardUrl, movedFrom, sectionUrl } from "@/lib/dashboardPages";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { PageTextsTable } from "@/components/PageTextsTable";
import { languageList, pageTextLabels } from "../translationShared";
import { itemFilter } from "@/lib/ownerItems";
import { ItemsSection, loadItems } from "../Inventory";
import type { LanguageSettings } from "../LanguagesForm";
import { messages, ShopSwitcher } from "../shared";
import { itemTabs, PageHead } from "@/components/owner/PageHead";
import { NotForFood } from "@/components/owner/NotForFood";

export async function generateMetadata({
  params,
}: PageProps<"/[lang]/dashboard/translations">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return {
    title: (await getDictionary(lang)).account.translations_page,
    robots: { index: false },
  };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Môj obchod → "Jazyky a inventár" (database update 40): "Tovar" — the products and, since update 62, every
 * translation of them (X z Y jazykov, the "Jazyk" dropdown, bulk actions, descriptions, the translation files) — and
 * "Texty stránky" (update 62, before "Preklady"): the page's other texts, one row per original with its languages.
 * The languages, the stock file's columns and the stock files in other languages moved to "Priečinok s exportom" in
 * update 45 (their old addresses are forwarded there). The database decides (owner_items, owner_page_texts,
 * owner_*_translation[s]).
 */
export default async function TranslationsPage({
  params,
  searchParams,
}: PageProps<"/[lang]/dashboard/translations">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const at = first(sp.at) ?? "";
  if (movedFrom("translations", at)) redirect(forwardUrl(lang, at, sp));
  const [dict, session, enabled] = await Promise.all([
    getDictionary(lang),
    requireUser(lang),
    enabledLocales(),
  ]);
  const { supabase } = session;
  const o = dict.owner_tr;

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];
  const m = messages(dict, sp, { n: Number(first(sp.n) ?? 1) });

  const q = (first(sp.q) ?? "").trim();
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  const filter = itemFilter(sp.filter);
  // the "Jazyk" dropdown (update 62): a valid code, the database checks it again
  const asked = first(sp.tr) ?? "";
  const itemLang = /^[a-z]{2}(-(cyrl|hans|hant))?$/.test(asked) ? asked : null;
  const [{ data: settingsData, error }, stock, stockState] = await Promise.all([
    supabase.rpc("owner_language_settings", { p_shop_id: shop.id }),
    loadItems(supabase, shop, q, page, filter, itemLang),
    // Whether the uploaded files were deleted (update 43; before it: never).
    supabase.rpc("owner_inventory_state", { p_shop_id: shop.id }),
  ]);
  const filesCleared =
    !stockState.error &&
    (stockState.data as { files_cleared?: boolean } | null)?.files_cleared ===
      true;
  if (stock.error) return <DbError message={stock.error} dict={dict} />;
  // update 79: a restaurant's dishes and prices are in the Menu; its Tovar tab says so above the list
  const food = shop.kind === "food";
  const foodNote = food ? (
    <NotForFood lang={lang} shop={shop.slug} labels={dict.setup} />
  ) : null;
  // 2026-11-07 (artboard 13): Tovar · Texty stránky are tabs; a restaurant opens at Texty stránky (itemQueryFor)
  const tab =
    at === "texts" ? "texts" : at === "items" || !food ? "items" : "texts";
  const itemsSection = (
    <>
      {foodNote}
      <ItemsSection
        shop={shop}
        lang={lang}
        dict={dict}
        m={m}
        items={stock.items}
        total={stock.total}
        counts={stock.counts}
        q={q}
        page={page}
        filter={filter}
        filesCleared={filesCleared}
        itemLang={
          stock.langs && itemLang && stock.langs.includes(itemLang)
            ? itemLang
            : null
        }
        langs={stock.langs}
      />
    </>
  );
  const head = (
    <PageHead
      title={dict.account.translations_page}
      item="translations"
      tabs={itemTabs(dict, lang, "translations", shop.slug)}
      current={tab}
    >
      <ShopSwitcher
        shops={shops}
        current={shop}
        label={dict.dashboard.shop}
        href={(slug) =>
          `/${lang}/dashboard/translations?${new URLSearchParams({ shop: slug })}`
        }
      />
    </PageHead>
  );
  // the same on both tabs, under the content (it was above the two dropdowns)
  const pageNotes = (
    <div
      className="flex flex-col gap-2 border-t border-[#E4E4E4] pt-4 text-sm text-[#5C5C5C]"
      data-translations-notes
    >
      <p>{o.page_intro}</p>
      <p data-moved-to-sync>
        {o.moved_to_sync}{" "}
        <Link
          href={sectionUrl(lang, "review", { shop: shop.slug })}
          className="underline underline-offset-4"
        >
          {o.moved_to_sync_link}
        </Link>
      </p>
    </div>
  );
  // Before database update 40 there is nothing to set yet.
  const settings = (
    Array.isArray(settingsData) ? settingsData[0] : settingsData
  ) as LanguageSettings | undefined;
  if (error || !settings) {
    return (
      <div className="flex w-full flex-col gap-5">
        {head}
        {m.top}
        {tab === "items" ? (
          itemsSection
        ) : (
          <p
            className="border border-line p-3 text-sm"
            data-translations-unavailable
          >
            {o.unavailable}
          </p>
        )}
        {pageNotes}
      </div>
    );
  }
  // every switched-on language (the assistant's texts are also kept in the shop's own one, update 46)
  const all = languageList(enabled);

  return (
    <div className="flex w-full flex-col gap-5">
      {head}
      {m.top}
      {tab === "items" ? (
        itemsSection
      ) : (
        <section
          id="texts"
          className="flex w-full max-w-5xl flex-col gap-3 scroll-mt-4"
          aria-label={o.texts_title}
          data-texts-section
        >
          {m.notice("texts")}
          <p className="text-sm">{o.texts_intro}</p>
          <PageTextsTable
            shopId={shop.id}
            langs={all}
            labels={pageTextLabels(dict)}
          />
        </section>
      )}
      {pageNotes}
    </div>
  );
}
