import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { enabledLocales, getDictionary, t } from "@/i18n/dictionaries";
import { languageOf } from "@/i18n/languages";
import { requireUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { TranslationsTable } from "@/components/TranslationsTable";
import { generateDescriptions, saveDescription } from "../../translationActions";
import { languageList, tableLabels } from "../../translationShared";
import { errorText, hiddenFields, messages, SubmitButton } from "../../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/items/[id]">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).owner_tr.item_title, robots: { index: false } };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Item {
  id: string;
  shop_id: string;
  name: string;
  source_code: string;
  ean: string | null;
  brand: string | null;
  description: string | null;
  category: string | null;
}

interface Description {
  draft: string | null;
  draft_at: string | null;
  text: string | null;
  published_at: string | null;
  show: "auto" | "shop" | "cacaduu";
}

/**
 * A product in Môj obchod (database update 40): "Popis" — the shop's own description from its file (never changed),
 * "Popis (Cacaduu)": Claude's draft from the shop's own data only ("Návrh popisu" → edit, "Uložiť a zverejniť",
 * "Zahodiť"), which one the page shows; "Preklady" — the product's name, description and category in every language.
 */
export default async function ItemPage({ params, searchParams }: PageProps<"/[lang]/dashboard/items/[id]">) {
  const { lang, id } = await params;
  if (!isLocale(lang) || !UUID.test(id)) notFound();
  const sp = await searchParams;
  const [dict, session, enabled] = await Promise.all([getDictionary(lang), requireUser(lang), enabledLocales()]);
  const { supabase } = session;
  const o = dict.owner_tr;

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  const { data: itemRow } = await supabase
    .from("shop_items")
    .select("id, shop_id, name, source_code, ean, brand, description, category")
    .eq("id", id)
    .maybeSingle();
  const item = itemRow as Item | null;
  const shop = item ? shops.find((s) => s.id === item.shop_id) : undefined;
  if (!item || !shop) redirect(`/${lang}/dashboard`);

  const [{ data: descRow }, { data: settingsData }] = await Promise.all([
    supabase.from("item_descriptions").select("draft, draft_at, text, published_at, show").eq("item_id", id).maybeSingle(),
    supabase.rpc("owner_language_settings", { p_shop_id: shop.id }),
  ]);
  const desc = (descRow as Description | null) ?? { draft: null, draft_at: null, text: null, published_at: null, show: "auto" as const };
  const main = ((Array.isArray(settingsData) ? settingsData[0] : settingsData) as { main_lang?: string } | undefined)?.main_lang ?? lang;
  const tab = first(sp.tab) === "translations" ? "translations" : "description";
  const m = messages(dict, sp, {});
  const hidden = hiddenFields(lang, shop);
  const here = (query: Record<string, string>) => `/${lang}/dashboard/items/${id}?${new URLSearchParams({ shop: shop.slug, ...query })}`;
  const tabLink = (key: "description" | "translations", label: string) => (
    <Link
      href={here({ tab: key })}
      role="tab"
      aria-selected={tab === key}
      className={`border-b-2 px-1 pb-2 ${tab === key ? "border-foreground font-semibold" : "border-transparent text-muted"}`}
      data-tab={key}
    >
      {label}
    </Link>
  );
  const shown = desc.show === "cacaduu" && desc.text ? "cacaduu" : desc.show === "shop" || item.description?.trim() ? "shop" : desc.text ? "cacaduu" : null;

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <Link href={`/${lang}/dashboard/translations?${new URLSearchParams({ shop: shop.slug, at: "items" })}#items`} className="text-sm underline underline-offset-4">
          {o.back_to_items}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{item.name}</h1>
        <p className="text-sm text-muted">
          {[item.source_code, item.brand, item.ean].filter(Boolean).join(" · ")} · {shop.name}
        </p>
      </header>
      <nav role="tablist" className="flex gap-4 border-b border-line">
        {tabLink("description", o.tab_description)}
        {tabLink("translations", o.tab_translations)}
      </nav>
      {(m.ok || m.err) && (
        <p role="status" className={m.ok ? "border border-foreground p-3 font-medium" : "border border-line p-3"} data-item-message={m.ok ?? m.err}>
          {m.ok ? (((o as unknown as Record<string, string>)[`ok_${m.ok}`] ?? m.okText).replace("{n}", first(sp.n) ?? "1")) : errorText(dict, m.err ?? "")}
        </p>
      )}

      {tab === "description" ? (
        <section className="flex flex-col gap-5" data-description-tab>
          <div className="flex flex-col gap-1">
            <h2 className="font-semibold">{o.shop_description}</h2>
            {item.description?.trim() ? (
              <p className="whitespace-pre-line border border-line p-3" data-shop-description>
                {item.description}
              </p>
            ) : (
              <p className="text-sm text-muted">{o.shop_description_none}</p>
            )}
            <p className="text-xs text-muted">{o.shop_description_help}</p>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="font-semibold">{o.cacaduu_description}</h2>
            {desc.draft ? (
              <form action={saveDescription} className="flex flex-col gap-2 border border-foreground p-3" data-description-draft>
                {hidden({ item_id: id })}
                <p className="text-sm font-semibold">{o.draft_title}</p>
                <p className="text-xs text-muted">{t(o.draft_help, { lang: languageOf(main)?.native ?? main })}</p>
                <textarea name="text" defaultValue={desc.draft} rows={5} maxLength={3000} lang={main} className="rounded border border-line px-3 py-2" data-draft-text />
                <div className="flex flex-wrap gap-3">
                  <button type="submit" name="action" value="publish" className="rounded border border-foreground px-4 py-2 font-medium" data-draft-publish>
                    {o.publish}
                  </button>
                  <button type="submit" name="action" value="discard" className="rounded border border-line px-4 py-2" data-draft-discard>
                    {o.discard}
                  </button>
                </div>
              </form>
            ) : desc.text ? (
              <form action={saveDescription} className="flex flex-col gap-2" data-description-published>
                {hidden({ item_id: id })}
                <p className="text-xs text-muted">{desc.published_at ? t(o.published_at, { date: formatDateTime(desc.published_at, lang, shop.timezone) }) : ""}</p>
                <textarea name="text" defaultValue={desc.text} rows={5} maxLength={3000} lang={main} className="rounded border border-line px-3 py-2" />
                <button type="submit" name="action" value="publish" className="self-start rounded border border-foreground px-4 py-2 font-medium">
                  {o.publish}
                </button>
              </form>
            ) : (
              <p className="text-sm text-muted">{o.cacaduu_none}</p>
            )}
            <form action={generateDescriptions} className="flex flex-col gap-1">
              {hidden({ item_id: id })}
              <SubmitButton pending={o.describing}>{desc.text || desc.draft ? o.describe_again : o.describe}</SubmitButton>
              <span className="text-xs text-muted">{o.describe_help}</span>
            </form>
          </div>

          <form action={saveDescription} className="flex flex-col gap-2" data-description-choice>
            {hidden({ item_id: id, action: "show" })}
            <fieldset className="flex flex-col gap-1">
              <legend className="font-semibold">{o.show_label}</legend>
              {(["auto", "shop", "cacaduu"] as const).map((v) => (
                <label key={v} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="show" value={v} defaultChecked={desc.show === v} data-show={v} />
                  {o[`show_${v}`]}
                </label>
              ))}
            </fieldset>
            <p className="text-xs text-muted">{shown ? t(o.shown_now, { which: shown === "shop" ? o.shop_description : o.cacaduu_description }) : o.shown_none}</p>
            <SubmitButton pending={dict.owner.saving}>{o.save}</SubmitButton>
          </form>
        </section>
      ) : (
        <section className="flex flex-col gap-3" data-translations-tab>
          <p className="text-sm">{o.item_translations_intro}</p>
          <TranslationsTable
            shopId={shop.id}
            langs={languageList(enabled.filter((c) => c !== main))}
            labels={tableLabels(dict)}
            item={id}
            addKinds={["item_name", "item_description", "item_category"]}
          />
        </section>
      )}
    </div>
  );
}
