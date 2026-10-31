import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { enabledLocales, getDictionary } from "@/i18n/dictionaries";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { forwardUrl, movedFrom, sectionUrl } from "@/lib/dashboardPages";
import type { MyShop } from "@/lib/myShops";
import { DashboardSection } from "@/components/DashboardSection";
import { DbError } from "@/components/DbError";
import { TranslationsTable } from "@/components/TranslationsTable";
import { generateDescriptions } from "../translationActions";
import { languageList, tableLabels } from "../translationShared";
import { itemFilter } from "@/lib/ownerItems";
import { ItemsSection, loadItems } from "../Inventory";
import type { LanguageSettings } from "../LanguagesForm";
import { hiddenFields, messages, ShopSwitcher, SubmitButton } from "../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/translations">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).account.translations_page, robots: { index: false } };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Môj obchod → "Jazyky a inventár" (database update 40): "Tovar" (the items, update 41) and "Preklady" (every text of
 * the shop in every language it keeps, with filters, ticks for many, a progress bar and "Späť"). The languages, the
 * stock file's columns and the stock files in other languages moved to "Priečinok s exportom" in update 45 (their
 * old addresses are forwarded there). The database decides again (owner_translations, owner_*_translation[s]).
 */
export default async function TranslationsPage({ params, searchParams }: PageProps<"/[lang]/dashboard/translations">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const at = first(sp.at) ?? "";
  if (movedFrom("translations", at)) redirect(forwardUrl(lang, at, sp));
  const [dict, session, enabled] = await Promise.all([getDictionary(lang), requireUser(lang), enabledLocales()]);
  const { supabase } = session;
  const o = dict.owner_tr;

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];
  const m = messages(dict, sp, { n: Number(first(sp.n) ?? 1) });
  const hidden = hiddenFields(lang, shop);

  const q = (first(sp.q) ?? "").trim();
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  const filter = itemFilter(sp.filter);
  const [{ data: settingsData, error }, stock, stockState] = await Promise.all([
    supabase.rpc("owner_language_settings", { p_shop_id: shop.id }),
    loadItems(supabase, shop, q, page, filter),
    // Whether the uploaded files were deleted (update 43; before it: never).
    supabase.rpc("owner_inventory_state", { p_shop_id: shop.id }),
  ]);
  const filesCleared = !stockState.error && (stockState.data as { files_cleared?: boolean } | null)?.files_cleared === true;
  if (stock.error) return <DbError message={stock.error} dict={dict} />;
  const itemsSection = <ItemsSection shop={shop} lang={lang} dict={dict} m={m} items={stock.items} total={stock.total} counts={stock.counts} q={q} page={page} filter={filter} filesCleared={filesCleared} />;
  const header = (
    <header className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{dict.account.translations_page}</h1>
      <ShopSwitcher shops={shops} current={shop} label={dict.dashboard.shop} href={(slug) => `/${lang}/dashboard/translations?${new URLSearchParams({ shop: slug })}`} />
      <p className="text-muted">{shop.name}</p>
      <p className="text-sm">{o.page_intro}</p>
      <p className="text-sm" data-moved-to-sync>
        {o.moved_to_sync}{" "}
        <Link href={sectionUrl(lang, "review", { shop: shop.slug })} className="underline underline-offset-4">
          {o.moved_to_sync_link}
        </Link>
      </p>
      {m.top}
    </header>
  );
  // Before database update 40 there is nothing to set yet.
  const settings = (Array.isArray(settingsData) ? settingsData[0] : settingsData) as LanguageSettings | undefined;
  if (error || !settings) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        {header}
        {itemsSection}
        <p className="border border-line p-3 text-sm" data-translations-unavailable>
          {o.unavailable}
        </p>
      </div>
    );
  }
  const others = languageList(enabled).filter((l) => l.code !== settings.main_lang);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {header}

      {itemsSection}

      <DashboardSection {...m.section("translations")} title={o.translations_title} summary={o.translations_summary}>
        {m.notice("translations")}
        <p className="text-sm">{o.translations_intro}</p>
        <form action={generateDescriptions} className="flex flex-wrap items-center gap-3 border border-line p-3 text-sm">
          {hidden()}
          <span>{o.describe_bulk_help}</span>
          <SubmitButton pending={o.describing}>{o.describe_bulk}</SubmitButton>
        </form>
        <TranslationsTable shopId={shop.id} langs={others} labels={tableLabels(dict)} />
      </DashboardSection>
    </div>
  );
}

