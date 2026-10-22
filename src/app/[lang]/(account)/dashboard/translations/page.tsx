import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { enabledLocales, getDictionary, t } from "@/i18n/dictionaries";
import { languageOf } from "@/i18n/languages";
import { requireUser } from "@/lib/auth";
import { forwardUrl, movedFrom } from "@/lib/dashboardPages";
import type { MyShop } from "@/lib/myShops";
import { DashboardSection } from "@/components/DashboardSection";
import { DbError } from "@/components/DbError";
import { LanguageFileUpload } from "@/components/LanguageFileUpload";
import { TranslationsTable } from "@/components/TranslationsTable";
import { generateDescriptions, saveLanguages } from "../translationActions";
import { languageList, tableLabels } from "../translationShared";
import { itemFilter } from "@/lib/ownerItems";
import { ColumnsSection, ItemsSection, loadItems } from "../Inventory";
import { hiddenFields, messages, ShopSwitcher, SubmitButton } from "../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/translations">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).account.translations_page, robots: { index: false } };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface Settings {
  main_lang: string;
  inventory_langs: string[];
  preferred_langs: string[];
  domain_lang: string | null;
  auto_descriptions: boolean;
  max_preferred: number;
  saved: boolean;
}

/**
 * Môj obchod → "Jazyky a inventár" (database update 40; the stock file's columns and the items moved here on
 * 22 October 2026): "Jazyky", "Stĺpce súboru so skladom", "Súbory so skladom v jazykoch", "Tovar", "Preklady". 1) "Jazyky" — the shop's own language, the languages of its
 * stock files, its preferred languages (pre-translated, first in the picker; the plan's number) and the own domain's
 * default language, and whether Claude's descriptions go live by themselves; 2) "Preklady" — every text of the shop in
 * every language it keeps, with filters, ticks for many, a progress bar and "Späť". The database decides again
 * (owner_save_language_settings, owner_translations, owner_*_translation[s]).
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
  const [{ data: settingsData, error }, stock] = await Promise.all([
    supabase.rpc("owner_language_settings", { p_shop_id: shop.id }),
    loadItems(supabase, shop, q, page, filter),
  ]);
  if (stock.error) return <DbError message={stock.error} dict={dict} />;
  // "Stĺpce súboru so skladom" and "Tovar" (moved here from Môj obchod on 22 October 2026).
  const columnsSection = <ColumnsSection shop={shop} dict={dict} hidden={hidden} m={m} />;
  const itemsSection = <ItemsSection shop={shop} lang={lang} dict={dict} m={m} items={stock.items} total={stock.total} counts={stock.counts} q={q} page={page} filter={filter} />;
  const header = (
    <header className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{dict.account.translations_page}</h1>
      <ShopSwitcher shops={shops} current={shop} label={dict.dashboard.shop} href={(slug) => `/${lang}/dashboard/translations?${new URLSearchParams({ shop: slug })}`} />
      <p className="text-muted">{shop.name}</p>
      <p className="text-sm">{o.page_intro}</p>
      {m.top}
    </header>
  );
  // Before database update 40 there is nothing to set yet.
  const settings = (Array.isArray(settingsData) ? settingsData[0] : settingsData) as Settings | undefined;
  if (error || !settings) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        {header}
        {columnsSection}
        {itemsSection}
        <p className="border border-line p-3 text-sm" data-translations-unavailable>
          {o.unavailable}
        </p>
      </div>
    );
  }
  const all = languageList(enabled);
  const others = all.filter((l) => l.code !== settings.main_lang);
  const preferredSummary = settings.preferred_langs.length
    ? settings.preferred_langs.map((c) => languageOf(c)?.native ?? c).join(", ")
    : o.none;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {header}

      <DashboardSection
        {...m.section("languages")}
        first
        title={o.languages_title}
        summary={t(o.languages_summary, { main: languageOf(settings.main_lang)?.native ?? settings.main_lang, preferred: preferredSummary })}
      >
        {m.notice("languages")}
        <form action={saveLanguages} className="flex flex-col gap-5" data-language-settings>
          {hidden()}
          <label className="flex flex-col gap-1">
            <span className="font-semibold">{o.main_label}</span>
            <select name="main_lang" defaultValue={settings.main_lang} className="rounded border border-line px-3 py-2" data-main-lang>
              {all.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.native}
                </option>
              ))}
            </select>
            <span className="text-sm text-muted">{o.main_help}</span>
          </label>

          <fieldset className="flex flex-col gap-2">
            <legend className="font-semibold">{o.inventory_label}</legend>
            <LanguageChecks name="inventory_langs" langs={others} checked={settings.inventory_langs} />
            <span className="text-sm text-muted">{o.inventory_help}</span>
          </fieldset>

          <fieldset className="flex flex-col gap-2" data-preferred>
            <legend className="font-semibold">{o.preferred_label}</legend>
            <span className="text-sm">{t(o.preferred_limit, { n: settings.max_preferred })}</span>
            <LanguageChecks name="preferred_langs" langs={others} checked={settings.preferred_langs} />
            <span className="text-sm text-muted">{o.preferred_help}</span>
          </fieldset>

          <label className="flex flex-col gap-1">
            <span className="font-semibold">{o.domain_label}</span>
            <select name="domain_lang" defaultValue={settings.domain_lang ?? ""} className="rounded border border-line px-3 py-2" data-domain-lang>
              <option value="">{o.domain_main}</option>
              {all.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.native}
                </option>
              ))}
            </select>
            <span className="text-sm text-muted">{o.domain_help}</span>
          </label>

          <label className="flex items-start gap-2">
            <input type="checkbox" name="auto_descriptions" defaultChecked={settings.auto_descriptions} className="mt-1" data-auto-descriptions />
            <span className="flex flex-col gap-1">
              <span className="font-semibold">{o.auto_label}</span>
              <span className="text-sm text-muted">{o.auto_help}</span>
            </span>
          </label>

          <SubmitButton pending={dict.owner.saving}>{o.save}</SubmitButton>
        </form>
      </DashboardSection>

      {columnsSection}

      <DashboardSection {...m.section("files")} title={o.files_title} summary={o.files_summary}>
        <LanguageFileUpload
          shopId={shop.id}
          langs={languageList(settings.inventory_langs.filter((c) => c !== settings.main_lang))}
          mainLabel={languageOf(settings.main_lang)?.native ?? settings.main_lang}
          labels={o.files}
        />
      </DashboardSection>

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

function LanguageChecks({ name, langs, checked }: { name: string; langs: { code: string; native: string }[]; checked: string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
      {langs.map((l) => (
        <label key={l.code} className="flex items-center gap-2 text-sm">
          <input type="checkbox" name={name} value={l.code} defaultChecked={checked.includes(l.code)} data-lang-check={`${name}:${l.code}`} />
          <span lang={l.code}>{l.native}</span>
        </label>
      ))}
    </div>
  );
}

