import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { LANGUAGES } from "@/i18n/languages";
import { formatPrice } from "@/lib/format";
import { LANGUAGE_COLUMN_ROWS, MAPPING_FIELDS, REQUIRED_FIELDS, TEXT_FIELDS, type MyShop } from "@/lib/myShops";
import { translatedName, type NameI18n } from "@/lib/names";
import { availabilityText, type AvailabilityKey } from "@/lib/stock";
import { DashboardSection } from "@/components/DashboardSection";
import { approveColumns, saveTranslation } from "./actions";
import { inputClass, type messages, SubmitButton } from "./shared";

/**
 * "Stĺpce súboru so skladom" and "Tovar" (the items with their names in other languages), on Môj obchod →
 * "Jazyky a inventár" (/dashboard/translations) since the owner's request of 22 October 2026. Nothing here changes
 * the uploaded stock or how it is shown: that comes only from the file.
 */

const PAGE_SIZE = 50;

interface OwnerItem {
  item_id: string;
  source_code: string;
  item_name: string;
  ean: string | null;
  price: number | null;
  currency: string;
  quantity: number | null;
  availability: AvailabilityKey | null;
  total_count: number;
  name_lang: string | null;
  name_i18n: NameI18n | null;
  name_i18n_by_owner: boolean;
  translated_name_source: string | null;
}

const NAME_LANGUAGES = ["sk", "hu", "en"] as const;

type Messages = ReturnType<typeof messages>;
type Hidden = (extra?: Record<string, string>) => React.ReactNode;

/** One page of the shop's items (search q, 50 per page). */
export async function loadItems(
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  shop: MyShop,
  q: string,
  page: number,
) {
  const { data, error } = await supabase.rpc("owner_items", { p_shop_id: shop.id, q: q || null, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE });
  const items = (data ?? []) as OwnerItem[];
  return { items, total: Number(items[0]?.total_count ?? 0), error: error?.message ?? null };
}

/** The approval of the stock file's columns (with the language columns of update 40). */
export function ColumnsSection({ shop, dict, hidden, m, first = false }: { shop: MyShop; dict: Dictionary; hidden: Hidden; m: Messages; first?: boolean }) {
  const o = dict.owner;
  const d = dict.dashboard;
  const { notice, section } = m;
  // Columns of the stock file: every column name of the last file (values only of the approved ones).
  const columns = shop.file_columns?.length ? shop.file_columns : [...new Set((shop.sample_rows ?? []).flatMap((row) => Object.keys(row)))];
  const sampleColumns = [...new Set((shop.sample_rows ?? []).flatMap((row) => Object.keys(row)))];
  const summary = columns.length === 0 ? d.summary_no_file : shop.mapping_status === "confirmed" ? o.state_confirmed : o.state_proposed;
  return (
    <DashboardSection {...section("columns")} first={first} title={o.columns_title} summary={summary}>
              <p className="text-sm">{o.columns_intro}</p>
              {columns.length === 0 ? (
                <p className="text-muted">{o.columns_waiting}</p>
              ) : (
                <form action={approveColumns} className="flex flex-col gap-3">
                  {hidden({ at: "columns" })}
                  {notice("columns")}
                  <p className="font-semibold">{shop.mapping_status === "confirmed" ? o.state_confirmed : o.state_proposed}</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {MAPPING_FIELDS.map((field) => (
                      <label key={field} className="flex flex-col gap-1">
                        <span className="text-sm">
                          {o[`col_${field}`]}
                          {REQUIRED_FIELDS.includes(field) && <span className="text-muted"> · {o.required}</span>}
                        </span>
                        <select
                          name={`col_${field}`}
                          required={REQUIRED_FIELDS.includes(field)}
                          defaultValue={shop.field_mapping?.[field] ?? ""}
                          className={`${inputClass} bg-white`}
                        >
                          <option value="">{o.not_in_file}</option>
                          {columns.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                  <fieldset className="flex flex-col gap-2" data-language-columns>
                    <legend className="text-sm font-semibold">{dict.owner_tr.columns_lang_title}</legend>
                    <p className="text-xs text-muted">{dict.owner_tr.columns_lang_help}</p>
                    {Array.from({ length: LANGUAGE_COLUMN_ROWS }, (_, i) => {
                      const entry = Object.entries(shop.field_mapping ?? {}).filter(([k, v]) => k.includes("@") && v)[i];
                      const [field, language] = entry ? entry[0].split("@") : ["name", ""];
                      return (
                        <div key={i} className="grid grid-cols-3 gap-2">
                          <select name={`lc_col_${i}`} defaultValue={entry?.[1] ?? ""} className={`${inputClass} bg-white`} aria-label={dict.owner_tr.columns_lang_column}>
                            <option value="">{o.not_in_file}</option>
                            {columns.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          <select name={`lc_field_${i}`} defaultValue={field} className={`${inputClass} bg-white`} aria-label={dict.owner_tr.columns_lang_field}>
                            {TEXT_FIELDS.map((f) => (
                              <option key={f} value={f}>
                                {o[`col_${f}`]}
                              </option>
                            ))}
                          </select>
                          <select name={`lc_lang_${i}`} defaultValue={language} className={`${inputClass} bg-white`} aria-label={dict.owner_tr.columns_lang_language}>
                            <option value="">{dict.owner_tr.columns_lang_none}</option>
                            {LANGUAGES.map((l) => (
                              <option key={l.code} value={l.code}>
                                {l.native}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </fieldset>
                  <SampleRows rows={(shop.sample_rows ?? []).slice(0, 5)} columns={sampleColumns} title={o.sample_rows} />
                  <p className="text-xs text-muted">{o.private_columns_note}</p>
                  <SubmitButton pending={o.saving}>{o.approve}</SubmitButton>
                </form>
              )}
            </DashboardSection>
  );
}

/** The shop's items as its file has them, with their names in other languages and a link to each product's page. */
export function ItemsSection({
  shop,
  lang,
  dict,
  hidden,
  m,
  items,
  total,
  q,
  page,
}: {
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  hidden: Hidden;
  m: Messages;
  items: OwnerItem[];
  total: number;
  q: string;
  page: number;
}) {
  const d = dict.dashboard;
  const { notice, section } = m;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageUrl = (n: number) =>
    `/${lang}/dashboard/translations?${new URLSearchParams({ shop: shop.slug, at: "items", ...(q ? { q } : {}), page: String(n) })}#items`;
  const productCount = (n: number) => {
    const forms = d as Record<string, string>;
    return t(forms[`products_${new Intl.PluralRules(lang).select(n)}`] ?? d.products_other, { n });
  };
  return (
    <DashboardSection {...section("items")} title={d.items_title} summary={productCount(total)}>
              <p className="text-sm text-muted">{d.items_hint}</p>
              <p className="text-sm text-muted">{d.translation_hint}</p>
              {notice("items")}
              <form method="get" action={`/${lang}/dashboard/translations#items`} className="flex gap-2" role="search">
                <input type="hidden" name="shop" value={shop.slug} />
                <input type="hidden" name="at" value="items" />
                <input type="search" name="q" defaultValue={q} placeholder={d.search} className={`${inputClass} min-w-0 flex-1`} />
                <SubmitButton>{dict.search.button}</SubmitButton>
              </form>
              {items.length === 0 ? (
                <p>{q ? dict.shop.no_items : d.no_items}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-muted">
                        <th className="py-1 pr-2 font-normal">{d.name}</th>
                        <th className="py-1 pr-2 font-normal">{d.code}</th>
                        <th className="py-1 pr-2 text-right font-normal">{d.price}</th>
                        <th className="py-1 pr-2 text-right font-normal">{d.quantity}</th>
                        <th className="py-1 font-normal">{d.stock}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.item_id} className="border-b border-line">
                          <td className="py-2 pr-2">
                            <ItemNames
                              item={item}
                              lang={lang}
                              dict={dict}
                              hidden={hidden({ at: "items", item_id: item.item_id, q, page: String(page) })}
                              detail={`/${lang}/dashboard/items/${item.item_id}?${new URLSearchParams({ shop: shop.slug })}`}
                            />
                          </td>
                          <td className="py-2 pr-2 tabular-nums">{item.source_code}</td>
                          <td className="whitespace-nowrap py-2 pr-2 text-right">{formatPrice(item.price, lang, item.currency)}</td>
                          <td className="py-2 pr-2 text-right tabular-nums">{item.quantity ?? ""}</td>
                          <td className="py-2 font-semibold">{availabilityText(dict, item.availability, item.quantity, lang) ?? "–"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {pages > 1 && (
                <nav className="flex items-center justify-between text-sm">
                  {page > 1 ? <a href={pageUrl(page - 1)} className="underline">{dict.shop.prev}</a> : <span />}
                  <span className="text-muted">{t(dict.shop.page_of, { page, pages })}</span>
                  {page < pages ? <a href={pageUrl(page + 1)} className="underline">{dict.shop.next}</a> : <span />}
                </nav>
              )}
            </DashboardSection>
  );
}

/** The shop's own name, its translation in the page language, and the owner's correction form. */
function ItemNames({
  item,
  lang,
  dict,
  hidden,
  detail,
}: {
  item: OwnerItem;
  lang: Locale;
  dict: Dictionary;
  hidden: React.ReactNode;
  /** The product's page: "Popis" and "Preklady" (update 40). */
  detail: string;
}) {
  const d = dict.dashboard;
  const translated = translatedName(item.item_name, item.name_i18n, lang);
  const renamed = item.name_i18n_by_owner && item.translated_name_source !== null && item.translated_name_source !== item.item_name;
  return (
    <div className="flex min-w-48 flex-col gap-1">
      <span>{item.item_name}</span>
      {translated && <span className="text-muted">{translated}</span>}
      {!item.name_i18n && <span className="text-xs text-muted">{d.translation_waiting}</span>}
      <Link href={detail} className="text-xs underline underline-offset-4" data-item-detail>
        {dict.owner_tr.item_link}
      </Link>
      <details>
        <summary className="cursor-pointer text-xs text-muted underline underline-offset-4">
          {item.name_i18n_by_owner ? d.translation_yours : d.translation_edit}
        </summary>
        <form action={saveTranslation} className="mt-2 flex flex-col gap-2">
          {hidden}
          {NAME_LANGUAGES.map((l) => (
            <label key={l} className="flex flex-col gap-1">
              <span className="text-xs text-muted">{d[`translation_${l}`]}</span>
              <input
                name={`name_${l}`}
                defaultValue={item.name_i18n?.[l] ?? ""}
                maxLength={300}
                className={inputClass}
              />
            </label>
          ))}
          {renamed && <p className="text-xs">{d.translation_name_changed}</p>}
          <div className="flex flex-wrap gap-2">
            <SubmitButton pending={dict.owner.saving}>{d.translation_save}</SubmitButton>
            {item.name_i18n_by_owner && (
              <button type="submit" name="intent" value="auto" className="rounded border border-line px-4 py-2">
                {d.translation_auto}
              </button>
            )}
          </div>
        </form>
      </details>
    </div>
  );
}

function SampleRows({ rows, columns, title }: { rows: Record<string, unknown>[]; columns: string[]; title: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted">{title}</span>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line text-left">
              {columns.map((c) => (
                <th key={c} className="py-1 pr-3 font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-line">
                {columns.map((c) => (
                  <td key={c} className="whitespace-nowrap py-1 pr-3">
                    {String(row[c] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
