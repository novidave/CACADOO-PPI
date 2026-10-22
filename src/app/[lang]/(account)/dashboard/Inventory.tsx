import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { LANGUAGES } from "@/i18n/languages";
import { sectionUrl } from "@/lib/dashboardPages";
import { formatDateTime, formatPrice } from "@/lib/format";
import { LANGUAGE_COLUMN_ROWS, MAPPING_FIELDS, REQUIRED_FIELDS, TEXT_FIELDS, type MyShop } from "@/lib/myShops";
import { translatedName, type NameI18n } from "@/lib/names";
import { fileStatus, filterCount, ITEM_FILTERS, shopperView, type ItemCounts, type ItemFilter } from "@/lib/ownerItems";
import { availabilityText, type AvailabilityKey } from "@/lib/stock";
import { DashboardSection } from "@/components/DashboardSection";
import { approveColumns } from "./actions";
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
  /** Update 41: a description is shown on the product page / its name or description still needs a translation. */
  has_description?: boolean;
  missing_translation?: boolean;
}

type Messages = ReturnType<typeof messages>;
type Hidden = (extra?: Record<string, string>) => React.ReactNode;

/**
 * One page of the shop's items (search q, filter, 50 per page) and how many each filter has. Before database update 41
 * the list has no filters: it is loaded the old way and the filters are not shown.
 */
export async function loadItems(
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> },
  shop: MyShop,
  q: string,
  page: number,
  filter: ItemFilter = "all",
) {
  const args = { p_shop_id: shop.id, q: q || null, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE };
  const [list, countRows] = await Promise.all([
    supabase.rpc("owner_items", { ...args, p_filter: filter }),
    supabase.rpc("owner_item_counts", { p_shop_id: shop.id }),
  ]);
  let { data, error } = list;
  const counts = countRows.error ? null : ((Array.isArray(countRows.data) ? countRows.data[0] : countRows.data) as ItemCounts | null);
  if (error && !counts) ({ data, error } = await supabase.rpc("owner_items", args));
  const items = (data ?? []) as OwnerItem[];
  return { items, total: Number(items[0]?.total_count ?? 0), counts, error: error?.message ?? null };
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

/**
 * "Tovar": the shop's items as its file has them. Above the list the last file and how fresh it is, the filters; per
 * item the name as written (+ its translation in the page language), one link "Popis a preklady" to the product's page
 * (description and the "Preklady" tab — every correction of a translation is made there) and "Čo vidí zákazník".
 */
export function ItemsSection({
  shop,
  lang,
  dict,
  m,
  items,
  total,
  counts,
  q,
  page,
  filter,
}: {
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  m: Messages;
  items: OwnerItem[];
  total: number;
  counts: ItemCounts | null;
  q: string;
  page: number;
  filter: ItemFilter;
}) {
  const d = dict.dashboard;
  const { notice, section } = m;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const listUrl = (query: { page?: number; filter?: ItemFilter }) => {
    const f = query.filter ?? filter;
    return `/${lang}/dashboard/translations?${new URLSearchParams({
      shop: shop.slug,
      at: "items",
      ...(q ? { q } : {}),
      ...(f !== "all" ? { filter: f } : {}),
      ...(query.page && query.page > 1 ? { page: String(query.page) } : {}),
    })}#items`;
  };
  const productCount = (n: number) => {
    const forms = d as Record<string, string>;
    return t(forms[`products_${new Intl.PluralRules(lang).select(n)}`] ?? d.products_other, { n });
  };
  const upload = sectionUrl(lang, "export", { shop: shop.slug });
  const file = fileStatus(shop.latest_file_time, shop.freshness_state);
  return (
    <DashboardSection {...section("items")} title={d.items_title} summary={productCount(counts ? Number(counts.all_items) : total)}>
              {/* div (not p): details may not sit inside p; that broke hydration. */}
              <div className="text-sm text-muted" data-items-intro>
                {d.items_intro}{" "}
                <details className="inline">
                  <summary className="inline cursor-pointer underline underline-offset-4">{d.items_more}</summary>
                  <span className="mt-1 block">{d.items_more_text}</span>
                </details>
              </div>
              <p className="text-sm" data-file-status={file.kind === "none" ? "none" : file.state}>
                {file.kind === "none" ? (
                  d.file_status_none
                ) : (
                  <>
                    {t(d.file_status, { time: formatDateTime(file.at, lang, shop.timezone) })} ·{" "}
                    <span className={file.state === "stale" ? "font-semibold" : undefined}>{d[`file_state_${file.state}`]}</span>
                    {file.state === "stale" && (
                      <>
                        {" · "}
                        <Link href={upload} className="underline underline-offset-4">
                          {d.upload_new_file}
                        </Link>
                      </>
                    )}
                  </>
                )}
              </p>
              {notice("items")}
              <form method="get" action={`/${lang}/dashboard/translations#items`} className="flex gap-2" role="search">
                <input type="hidden" name="shop" value={shop.slug} />
                <input type="hidden" name="at" value="items" />
                {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
                <input type="search" name="q" defaultValue={q} placeholder={d.search} className={`${inputClass} min-w-0 flex-1`} />
                <SubmitButton>{dict.search.button}</SubmitButton>
              </form>
              {counts && (
                <nav aria-label={d.filters_label} className="flex flex-wrap gap-2 text-sm" data-item-filters>
                  {ITEM_FILTERS.map((f) => (
                    <Link
                      key={f}
                      href={listUrl({ filter: f })}
                      aria-current={f === filter ? "true" : undefined}
                      className={`rounded-full border px-3 py-1 ${f === filter ? "border-foreground font-semibold" : "border-line"}`}
                      data-filter={f}
                    >
                      {d[`filter_${f}`]} <span className="text-muted">{filterCount(counts, f)}</span>
                    </Link>
                  ))}
                </nav>
              )}
              {items.length === 0 ? (
                <p>{q ? dict.shop.no_items : filter !== "all" ? d.filter_empty : d.no_items}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-muted">
                        <th className="py-1 pr-2 font-normal">{d.name}</th>
                        <th className="py-1 pr-2 font-normal">{d.code}</th>
                        <th className="py-1 pr-2 text-right font-normal">{d.price}</th>
                        <th className="py-1 pr-2 text-right font-normal">{d.quantity}</th>
                        <th className="min-w-36 py-1 font-normal">{d.shopper_sees}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.item_id} className="border-b border-line" data-item-row={item.source_code}>
                          <td className="py-2 pr-2">
                            <ItemNames
                              item={item}
                              lang={lang}
                              dict={dict}
                              detail={`/${lang}/dashboard/items/${item.item_id}?${new URLSearchParams({ shop: shop.slug })}`}
                            />
                          </td>
                          <td className="py-2 pr-2 tabular-nums">{item.source_code}</td>
                          <td className="whitespace-nowrap py-2 pr-2 text-right">{formatPrice(item.price, lang, item.currency)}</td>
                          <td className="py-2 pr-2 text-right tabular-nums">{item.quantity ?? ""}</td>
                          <td className="min-w-36 py-2">
                            <ShopperSees item={item} lang={lang} dict={dict} upload={upload} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {pages > 1 && (
                <nav className="flex items-center justify-between text-sm">
                  {page > 1 ? <a href={listUrl({ page: page - 1 })} className="underline">{dict.shop.prev}</a> : <span />}
                  <span className="text-muted">{t(dict.shop.page_of, { page, pages })}</span>
                  {page < pages ? <a href={listUrl({ page: page + 1 })} className="underline">{dict.shop.next}</a> : <span />}
                </nav>
              )}
            </DashboardSection>
  );
}

/** "Čo vidí zákazník": the shopper's exact text, "Vypredané", or why nothing is shown (stale data) with the way out. */
function ShopperSees({ item, lang, dict, upload }: { item: OwnerItem; lang: Locale; dict: Dictionary; upload: string }) {
  const view = shopperView(item.availability);
  if (view === "hidden_stale") {
    return (
      <span className="text-muted" data-shopper-sees="hidden_stale">
        {dict.dashboard.shopper_hidden_stale} ·{" "}
        <Link href={upload} className="underline underline-offset-4">
          {dict.dashboard.upload_new_file}
        </Link>
      </span>
    );
  }
  return (
    <span className="font-semibold" data-shopper-sees={view}>
      {availabilityText(dict, item.availability, item.quantity, lang)}
    </span>
  );
}

/** The shop's own name, its translation in the page language, what it still lacks, and the one link to its page. */
function ItemNames({ item, lang, dict, detail }: { item: OwnerItem; lang: Locale; dict: Dictionary; detail: string }) {
  const d = dict.dashboard;
  const translated = translatedName(item.item_name, item.name_i18n, lang);
  const lacks = [item.has_description === false ? d.filter_no_description : null, item.missing_translation ? d.filter_missing_translation : null].filter(Boolean);
  return (
    <div className="flex min-w-40 flex-col gap-1">
      <span>{item.item_name}</span>
      {translated && <span className="text-muted">{translated}</span>}
      {lacks.length > 0 && <span className="text-xs text-muted" data-item-lacks>{lacks.join(" · ")}</span>}
      <Link href={detail} className="text-xs underline underline-offset-4" data-item-detail>
        {dict.owner_tr.item_link}
      </Link>
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
