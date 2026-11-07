import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { LANGUAGES, languageOf } from "@/i18n/languages";
import { sectionUrl } from "@/lib/dashboardPages";
import { formatDateTime } from "@/lib/format";
import { LANGUAGE_COLUMN_ROWS, MAPPING_FIELDS, REQUIRED_FIELDS, TEXT_FIELDS, type MyShop } from "@/lib/myShops";
import { itemNames, type NameI18n } from "@/lib/names";
import { fileStatus, filterCount, ITEM_FILTERS, shopperView, type ItemCounts, type ItemFilter, type OwnerAvailability } from "@/lib/ownerItems";
import { availabilityText, type AvailabilityKey } from "@/lib/stock";
import { ItemsBulk } from "@/components/ItemsBulk";
import { SelectSubmit } from "@/components/SelectSubmit";
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
  availability: OwnerAvailability | null;
  total_count: number;
  name_lang: string | null;
  name_i18n: NameI18n | null;
  name_i18n_by_owner: boolean;
  translated_name_source: string | null;
  /** Update 41: a description is shown on the product page / its name or description still needs a translation. */
  has_description?: boolean;
  missing_translation?: boolean;
  /** Update 62: "Preklady: X z Y jazykov" (Y = the shop's preferred languages) and the languages still missing. */
  tr_done?: number;
  tr_total?: number;
  missing_langs?: string[];
}

type Messages = ReturnType<typeof messages>;
type Hidden = (extra?: Record<string, string>) => React.ReactNode;

/**
 * One page of the shop's items (search q, filter, the "Jazyk" dropdown, 50 per page), how many each filter has and the
 * languages "Preklady: X z Y" counts (update 62). Before update 62 the language is left out; before update 41 the list
 * has no filters: it is loaded the old way and the filters are not shown.
 */
export async function loadItems(
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> },
  shop: MyShop,
  q: string,
  page: number,
  filter: ItemFilter = "all",
  itemLang: string | null = null,
) {
  const args = { p_shop_id: shop.id, q: q || null, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE };
  const [list, countRows, langRows] = await Promise.all([
    supabase.rpc("owner_items", { ...args, p_filter: filter, p_lang: itemLang }),
    supabase.rpc("owner_item_counts", { p_shop_id: shop.id, p_lang: itemLang }),
    supabase.rpc("owner_item_languages", { p_shop_id: shop.id }),
  ]);
  let { data, error } = list;
  let counts = countRows.error ? null : ((Array.isArray(countRows.data) ? countRows.data[0] : countRows.data) as ItemCounts | null);
  if (error || countRows.error) {
    // before update 62
    const [older, olderCounts] = await Promise.all([
      supabase.rpc("owner_items", { ...args, p_filter: filter }),
      supabase.rpc("owner_item_counts", { p_shop_id: shop.id }),
    ]);
    ({ data, error } = older);
    counts = olderCounts.error ? null : ((Array.isArray(olderCounts.data) ? olderCounts.data[0] : olderCounts.data) as ItemCounts | null);
    if (error && !counts) ({ data, error } = await supabase.rpc("owner_items", args));
  }
  const items = (data ?? []) as OwnerItem[];
  const langs = langRows.error ? null : ((langRows.data ?? []) as string[]);
  return { items, total: Number(items[0]?.total_count ?? 0), counts, langs, error: error?.message ?? null };
}

/** The approval of the stock file's columns (with the language columns of update 40). */
/** The stock file's columns as a summary line ("Schválené", "Treba schváliť", no file yet). */
export function columnsSummary(shop: MyShop, dict: Dictionary): string {
  const columns = shop.file_columns?.length ? shop.file_columns : (shop.sample_rows ?? []).flatMap((row) => Object.keys(row));
  return columns.length === 0 ? dict.dashboard.summary_no_file : shop.mapping_status === "confirmed" ? dict.owner.state_confirmed : dict.owner.state_proposed;
}

/**
 * "Stĺpce súboru so skladom": the approval form of the stock file's columns (on "Priečinok s exportom" → "Po nahratí
 * súboru" since update 45; its old addresses are forwarded there).
 */
export function ColumnsForm({ shop, dict, hidden }: { shop: MyShop; dict: Dictionary; hidden: Hidden }) {
  const o = dict.owner;
  // Columns of the stock file: every column name of the last file (values only of the approved ones).
  const columns = shop.file_columns?.length ? shop.file_columns : [...new Set((shop.sample_rows ?? []).flatMap((row) => Object.keys(row)))];
  const sampleColumns = [...new Set((shop.sample_rows ?? []).flatMap((row) => Object.keys(row)))];
  return (
    <div className="flex flex-col gap-3" id="columns" data-columns-form>
              <p className="text-sm">{o.columns_intro}</p>
              {columns.length === 0 ? (
                <p className="text-muted">{o.columns_waiting}</p>
              ) : (
                <form action={approveColumns} className="flex flex-col gap-3">
                  {hidden({ at: "columns" })}
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
    </div>
  );
}

/**
 * "Tovar" (artboard 13, 2026-11-07): the shop's items as its file has them and, since update 62, the one place for the
 * products' translations. From the top: the status strip (the last file, its freshness dot + word; "Množstvá ukazujeme
 * presne podľa vášho súboru."), the search (52 px), the filter chips with their counts and "Jazyk", the tools in ONE
 * toolbar row (`ItemsBulk`: "Vybrať" shows the round ticks, the descriptions, the translation files), then one 76 px row
 * per product — the name in the page language (bold), the shop's own name + code and the notes ("Bez popisu",
 * "Chýba preklad HU"), "Čo vidí zákazník" (220 px) and a chevron; the whole row is the link to the product's page.
 * Everything the artboard does not show (the intro, the photos link, the pages) keeps its place under the list.
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
  filesCleared = false,
  itemLang = null,
  langs = null,
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
  /** The uploaded files were deleted and no file came since (update 43). */
  filesCleared?: boolean;
  /** The "Jazyk" dropdown (update 62; null = every preferred language). */
  itemLang?: string | null;
  /** The shop's preferred languages (update 62; null = before it). */
  langs?: string[] | null;
}) {
  const d = dict.dashboard;
  const b = dict.items_bulk;
  const { notice } = m;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const listUrl = (query: { page?: number; filter?: ItemFilter }) => {
    const f = query.filter ?? filter;
    return `/${lang}/dashboard/translations?${new URLSearchParams({
      shop: shop.slug,
      at: "items",
      ...(q ? { q } : {}),
      ...(f !== "all" ? { filter: f } : {}),
      ...(itemLang ? { tr: itemLang } : {}),
      ...(query.page && query.page > 1 ? { page: String(query.page) } : {}),
    })}#items`;
  };
  const upload = sectionUrl(lang, "export", { shop: shop.slug });
  const file = fileStatus(shop.latest_file_time, shop.freshness_state, filesCleared);
  const native = (code: string) => languageOf(code)?.native ?? code.toUpperCase();
  const langList = (langs ?? []).map((code) => ({ code, native: native(code) }));
  const detail = (id: string) => `/${lang}/dashboard/items/${id}?${new URLSearchParams({ shop: shop.slug })}`;
  const table = (
    <div className="flex flex-col border-t border-[#E4E4E4]" data-items-table>
      <div
        aria-hidden="true"
        className="grid min-h-10 grid-cols-[minmax(0,1fr)_44px] items-center gap-x-3.5 border-b border-[#E4E4E4] px-1.5 text-[13px] font-bold uppercase text-[#5C5C5C] md:grid-cols-[minmax(0,1fr)_220px_44px]"
      >
        <span>{d.items_title}</span>
        <span className="hidden md:block">{d.shopper_sees}</span>
        <span />
      </div>
      {items.map((item) => (
        <ItemRow key={item.item_id} item={item} lang={lang} dict={dict} native={native} detail={detail(item.item_id)} upload={upload} pick={langs !== null} />
      ))}
    </div>
  );
  const empty = <p className="py-4">{q ? dict.shop.no_items : filter !== "all" ? d.filter_empty : d.no_items}</p>;
  const dot = (state: string) => (state === "stale" ? "#D64545" : state === "recent" ? "#F2B705" : "#1E9E5A");
  return (
    <section id="items" className="flex w-full max-w-5xl flex-col gap-3 scroll-mt-4" aria-label={d.items_title} data-items-section>
      {notice("items")}
      {/* the status strip: the last file and how fresh it is (a restaurant: the last change, never stale) */}
      <div
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[14px] border border-[#E4E4E4] px-4 py-3 text-[15px]"
        data-file-status={file.kind === "file" ? file.state : file.kind}
      >
        <span>
          {file.kind === "none" ? (
            d.file_status_none
          ) : file.kind === "cleared" ? (
            <Link href={upload} className="underline underline-offset-4">
              {d.file_status_cleared}
            </Link>
          ) : file.state === "never_expires" ? (
            // update 86: a restaurant's stock never goes stale — no "aktuálny / starší / zastaraný"
            t(d.file_status_food, { time: formatDateTime(file.at, lang, shop.timezone) })
          ) : (
            <>
              {t(d.file_status, { time: "" }).trim()} <strong>{formatDateTime(file.at, lang, shop.timezone)}</strong> ·{" "}
              <span aria-hidden="true" className="mx-1 inline-block size-2.5 rounded-full align-middle" style={{ background: dot(file.state) }} />
              <strong>{d[`file_state_${file.state}`]}</strong>
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
        </span>
        <span className="text-[#5C5C5C]" data-items-exact>
          {d.items_exact}
        </span>
      </div>
      <form method="get" action={`/${lang}/dashboard/translations#items`} role="search" data-items-search>
        <input type="hidden" name="shop" value={shop.slug} />
        <input type="hidden" name="at" value="items" />
        {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
        {itemLang && <input type="hidden" name="tr" value={itemLang} />}
        <label className="flex min-h-[52px] items-center gap-2.5 rounded-xl border border-[#D6D6D6] px-3.5 focus-within:border-[#111]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5C5C5C" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <span className="sr-only">{d.items_search_label}</span>
          <input type="search" name="q" defaultValue={q} placeholder={d.search} className="min-w-0 flex-1 border-0 bg-transparent text-base font-medium outline-none" />
        </label>
        <button type="submit" className="sr-only">
          {dict.search.button}
        </button>
      </form>
      {counts && (
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label={d.filters_label} className="-mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0" data-item-filters>
            {ITEM_FILTERS.map((f) => (
              <Link
                key={f}
                href={listUrl({ filter: f })}
                aria-current={f === filter ? "true" : undefined}
                className={`inline-flex min-h-12 flex-none items-center gap-1.5 rounded-3xl border px-4 text-[15px] font-bold ${
                  f === filter ? "border-[#111] bg-[#111] text-white" : "border-[#D6D6D6] bg-white text-[#111]"
                }`}
                data-filter={f}
              >
                {d[`filter_${f}`]} <span className="tabular-nums">{filterCount(counts, f)}</span>
              </Link>
            ))}
          </nav>
          {langs && langs.length > 0 && (
            <form method="get" action={`/${lang}/dashboard/translations#items`} className="flex items-center gap-2 text-[15px]" data-item-lang>
              <input type="hidden" name="shop" value={shop.slug} />
              <input type="hidden" name="at" value="items" />
              {q && <input type="hidden" name="q" value={q} />}
              {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
              <span className="font-semibold">{b.lang_label}</span>
              <SelectSubmit
                name="tr"
                value={itemLang ?? ""}
                label={b.lang_label}
                data="item-lang"
                className="min-h-12 rounded-xl border border-[#D6D6D6] bg-white px-3 font-semibold"
                options={[{ value: "", label: b.lang_all }, ...langList.map((l) => ({ value: l.code, label: l.native }))]}
              />
              <noscript>
                <button type="submit" className="underline underline-offset-4">
                  {b.lang_apply}
                </button>
              </noscript>
            </form>
          )}
        </div>
      )}
      {langs && langs.length === 0 && (
        <p className="text-sm text-[#5C5C5C]" data-items-no-langs>
          {b.no_langs}{" "}
          <Link href={sectionUrl(lang, "review", { shop: shop.slug })} className="underline underline-offset-4">
            {b.no_langs_link}
          </Link>
        </p>
      )}
      {langs ? (
        <ItemsBulk
          shopId={shop.id}
          slug={shop.slug}
          pageLang={lang}
          q={q}
          filter={filter}
          itemLang={itemLang}
          langs={langList}
          labels={{ ...b, delete_again: dict.owner_tr.table.delete_again, delete_never: dict.owner_tr.table.delete_never }}
          fileLabels={dict.export_folder}
        >
          {items.length === 0 ? empty : table}
        </ItemsBulk>
      ) : items.length === 0 ? (
        empty
      ) : (
        table
      )}
      <p className="text-sm text-[#5C5C5C]" data-items-hint>
        {d.items_tap_hint}
      </p>
      {pages > 1 && (
        <nav className="flex items-center justify-between text-[15px]">
          {page > 1 ? (
            <a href={listUrl({ page: page - 1 })} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
              {dict.shop.prev}
            </a>
          ) : (
            <span />
          )}
          <span className="text-[#5C5C5C]">{t(dict.shop.page_of, { page, pages })}</span>
          {page < pages ? (
            <a href={listUrl({ page: page + 1 })} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
              {dict.shop.next}
            </a>
          ) : (
            <span />
          )}
        </nav>
      )}
      {/* what the artboard does not show, as before: the intro + "Viac" and the photos for many products at once (update 78) */}
      {/* div (not p): details may not sit inside p; that broke hydration. */}
      <div className="text-sm text-[#5C5C5C]" data-items-intro>
        {d.items_intro}{" "}
        <details className="inline">
          <summary className="inline cursor-pointer underline underline-offset-4">{d.items_more}</summary>
          <span className="mt-1 block">{d.items_more_text}</span>
        </details>
      </div>
      <p className="text-sm">
        <Link href={`/${lang}/dashboard/items/photos?${new URLSearchParams({ shop: shop.slug })}`} className="font-semibold underline underline-offset-4" data-photo-bulk-link>
          {dict.product_photos.bulk_link}
        </Link>
      </p>
    </section>
  );
}

/** "Čo vidí zákazník": the shopper's exact text, "Vypredané", or why nothing is shown (stale data) with the way out. */
function ShopperSees({ item, lang, dict, upload }: { item: OwnerItem; lang: Locale; dict: Dictionary; upload: string }) {
  const view = shopperView(item.availability);
  if (view === "hidden_stale") {
    return (
      <span className="text-[#5C5C5C]" data-shopper-sees="hidden_stale">
        {dict.dashboard.shopper_hidden_stale} ·{" "}
        {/* above the row's own link (the whole row opens the product) */}
        <Link href={upload} className="relative z-10 underline underline-offset-4">
          {dict.dashboard.upload_new_file}
        </Link>
      </span>
    );
  }
  if (view === "in_menu") {
    // update 86: a restaurant's dish without "Sledovať zásobu" is on the Menu, not stock
    return (
      <span className="font-bold" data-shopper-sees="in_menu">
        {dict.dashboard.shopper_in_menu}
      </span>
    );
  }
  return (
    <span className="font-bold" data-shopper-sees={view}>
      {availabilityText(dict, item.availability as AvailabilityKey, item.quantity, lang)}
    </span>
  );
}

/**
 * One product (76 px): the name in the page language (bold 16), under it the shop's own name + code and the notes
 * (24 px tags: "Bez popisu", "Chýba preklad HU"; update 62's X z Y stays on the row as `data-item-tr` and in the
 * tag), "Čo vidí zákazník" (220 px; on a phone under the names) and a chevron. The whole row is the link to the
 * product's page ("Popis" and "Preklady" tabs); with "Vybrať" (ItemsBulk) a round tick covers it and the row ticks.
 */
function ItemRow({
  item,
  lang,
  dict,
  native,
  detail,
  upload,
  pick,
}: {
  item: OwnerItem;
  lang: Locale;
  dict: Dictionary;
  native: (code: string) => string;
  detail: string;
  upload: string;
  pick: boolean;
}) {
  const d = dict.dashboard;
  const b = dict.items_bulk;
  const names = itemNames(item.item_name, item.name_i18n, lang);
  const counted = typeof item.tr_total === "number";
  const missing = item.missing_langs ?? [];
  const notes: { key: string; text: string }[] = [];
  if (item.has_description === false) notes.push({ key: "description", text: d.items_note_no_description });
  if (counted && missing.length > 0) notes.push({ key: "translation", text: t(d.items_note_missing, { langs: missing.map((c) => c.toUpperCase()).join(", ") }) });
  else if (!counted && item.missing_translation) notes.push({ key: "translation", text: d.items_note_missing_any });
  const sub = [names.secondary, item.source_code].filter(Boolean).join(" · ");
  return (
    <div
      className="relative grid min-h-[76px] grid-cols-[minmax(0,1fr)_44px] items-center gap-x-3.5 border-b border-[#E4E4E4] px-1.5 py-2 hover:bg-[#FAFAFA] md:grid-cols-[minmax(0,1fr)_220px_44px]"
      data-item-row={item.source_code}
      data-item-tr={counted && (item.tr_total ?? 0) > 0 ? `${item.tr_done}/${item.tr_total}` : undefined}
    >
      {pick && (
        // "Vybrať" (ItemsBulk): the round tick of the Sklad design covers the row, so a tap anywhere ticks it
        <label className="absolute inset-0 z-20 hidden cursor-pointer items-center pl-1.5 group-data-[picking=on]/items:flex">
          <input type="checkbox" value={item.item_id} className="peer sr-only" aria-label={t(b.pick_one, { name: item.item_name })} data-item-pick />
          <span
            aria-hidden="true"
            className="flex size-6 items-center justify-center rounded-full border-2 border-[#2563EB] bg-white text-transparent peer-checked:bg-[#2563EB] peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#2563EB]"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 8.5l3 3 6-7" />
            </svg>
          </span>
        </label>
      )}
      <div className="flex min-w-0 flex-col gap-[3px] transition-[padding] duration-200 motion-reduce:transition-none group-data-[picking=on]/items:pl-11">
        <Link
          href={detail}
          className="text-base font-bold after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-[#2563EB]"
          aria-label={t(d.items_open, { name: names.primary })}
          data-item-detail
        >
          {names.primary}
        </Link>
        {(sub || notes.length > 0) && (
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {sub && <span className="text-sm text-[#5C5C5C]">{sub}</span>}
            {notes.map((n) => (
              <span
                key={n.key}
                className="inline-flex h-6 items-center rounded-md border border-[#D6D6D6] px-2 text-xs font-bold"
                data-item-note={n.key}
                title={n.key === "translation" && missing.length ? t(b.tr_missing, { langs: missing.map(native).join(", ") }) : undefined}
              >
                {n.text}
              </span>
            ))}
          </span>
        )}
        <span className="text-[15px] md:hidden">
          <ShopperSees item={item} lang={lang} dict={dict} upload={upload} />
        </span>
      </div>
      <span className="hidden text-base md:block">
        <ShopperSees item={item} lang={lang} dict={dict} upload={upload} />
      </span>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" aria-hidden="true" className="justify-self-center">
        <path d="M9 6l6 6-6 6" />
      </svg>
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
