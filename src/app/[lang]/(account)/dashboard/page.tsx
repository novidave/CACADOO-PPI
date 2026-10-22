import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { forwardUrl, movedFrom } from "@/lib/dashboardPages";
import { addressLine, formatPrice } from "@/lib/format";
import { MAPPING_FIELDS, REQUIRED_FIELDS, type MyShop } from "@/lib/myShops";
import { translatedName, type NameI18n } from "@/lib/names";
import { availabilityText, type AvailabilityKey } from "@/lib/stock";
import { DashboardSection } from "@/components/DashboardSection";
import { DbError } from "@/components/DbError";
import { LogoInput } from "@/components/LogoInput";
import { ShopForm } from "@/components/ShopForm";
import { approveColumns, deleteShop, saveShop, saveTranslation, uploadLogo } from "./actions";
import { errorText, hiddenFields, inputClass, messages, SubmitButton } from "./shared";
import { Holidays, holidaysSummary, loadHolidays } from "./Holidays";
import { loadSiteLogo, siteLogoSummary, SiteLogoPanel } from "./SiteLogoPanel";

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

/** The shop's row in subscriptions (written only by the Stripe functions). */
interface PlanRow {
  status: string;
  plan: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The shop owner's own area (self-service): create shops, approve the stock-file columns,
 * edit details and logo, the items and their translations, the plan, delete the shop. The
 * assistant has its own page ("AI asistent", /dashboard/assistant) and so has the export
 * folder ("Priečinok s exportom", /sync). Every main section is a dropdown with a summary
 * line. Nothing here changes the uploaded stock or how it is shown: that comes only from the file.
 */
export default async function DashboardPage({ params, searchParams }: PageProps<"/[lang]/dashboard">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const sp = await searchParams;
  // A section that moved to "Asistent", "Obsah stránky" or "Priečinok s exportom" (old links, e-mails, the cloud
  // sign-in coming back with ?at=cloud, "Sekcie stránky (PDF)" → "Obsah stránky"): the same address on its new page.
  const atParam = first(sp.at) ?? "";
  if (movedFrom("dashboard", atParam)) redirect(forwardUrl(lang, atParam, sp));
  const ok = first(sp.ok);
  const err = first(sp.err);
  const o = dict.owner;
  const d = dict.dashboard;

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];

  // No shop yet (or "+ Add another shop"): the create form.
  if (shops.length === 0 || first(sp.new) === "1") {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          {shops.length > 0 && (
            <Link href={`/${lang}/dashboard`} className="text-sm underline underline-offset-4">
              ← {dict.account.dashboard}
            </Link>
          )}
          <h1 className="text-2xl font-semibold tracking-tight">{o.create_title}</h1>
          <p className="text-muted">{o.create_intro}</p>
          {ok === "deleted" && <p className="border border-foreground p-3 font-medium">{o.deleted}</p>}
          {err && <p className="border border-line p-3">{errorText(dict, err)}</p>}
        </header>
        <ShopForm
          dict={dict}
          lang={lang}
          shop={null}
          defaults={{ country: "", timezone: "" }}
          action={saveShop}
          submitLabel={o.create_button}
        />
      </div>
    );
  }

  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];
  const q = (first(sp.q) ?? "").trim();
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  const [{ data: itemRows, error: e3 }, planRow, hasPlan, itemCount, holidays, header] = await Promise.all([
    supabase.rpc("owner_items", { p_shop_id: shop.id, q: q || null, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE }),
    supabase
      .from("subscriptions")
      .select("status, plan, current_period_end, cancel_at, stripe_customer_id, stripe_subscription_id")
      .eq("shop_id", shop.id)
      .maybeSingle(),
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    supabase.from("shop_items").select("id", { count: "exact", head: true }).eq("shop_id", shop.id),
    // "Sviatky a mimoriadne zatvorenie" (database update 27; null before it).
    loadHolidays(supabase, shop),
    // "Logo v hlavičke webu" (database update 31; null before it).
    loadSiteLogo(supabase, shop),
  ]);
  // The database decides whether the shop has the paid plan; before database update 18
  // the Plan section only says that paid plans are not available yet.
  const plan = planRow.error || hasPlan.error ? null : { row: planRow.data as PlanRow | null, active: hasPlan.data === true };
  if (e3) return <DbError message={e3.message} dict={dict} />;
  const items = (itemRows ?? []) as OwnerItem[];
  const total = Number(items[0]?.total_count ?? 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const products = itemCount.count ?? total;
  const hidden = hiddenFields(lang, shop);
  const pageUrl = (n: number) =>
    `/${lang}/dashboard?${new URLSearchParams({ shop: shop.slug, ...(q ? { q } : {}), page: String(n) })}#items`;
  const productCount = (n: number) => {
    const forms = d as Record<string, string>;
    return t(forms[`products_${new Intl.PluralRules(lang).select(n)}`] ?? d.products_other, { n });
  };
  const m = messages(dict, sp);
  const { at, okText, notice, section } = m;

  // Columns of the stock file: every column name of the last file (values only of the approved ones).
  const columns = shop.file_columns?.length
    ? shop.file_columns
    : [...new Set((shop.sample_rows ?? []).flatMap((row) => Object.keys(row)))];
  const sampleColumns = [...new Set((shop.sample_rows ?? []).flatMap((row) => Object.keys(row)))];

  // One line per section while it is closed.
  const summaries = {
    columns: columns.length === 0 ? d.summary_no_file : shop.mapping_status === "confirmed" ? o.state_confirmed : o.state_proposed,
    details: addressLine(shop.address, shop.city) || shop.name,
    holidays: holidaysSummary(holidays, dict),
    logo: shop.logo_url ? d.summary_logo : d.summary_no_logo,
    header: siteLogoSummary(header, dict),
    items: productCount(products),
    plan: plan ? (plan.active ? dict.plan.pro : dict.plan.free) : dict.plan.unavailable,
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <nav className="flex flex-wrap gap-3 text-sm" aria-label={d.shop}>
          {shops.length > 1 &&
            shops.map((s) => (
              <Link
                key={s.id}
                href={`/${lang}/dashboard?shop=${s.slug}`}
                className={s.id === shop.id ? "font-semibold underline underline-offset-4" : "text-muted hover:underline"}
              >
                {s.name}
              </Link>
            ))}
          <Link href={`/${lang}/dashboard?new=1`} className="text-muted hover:underline">
            {o.add_shop}
          </Link>
        </nav>
        <h1 className="text-2xl font-semibold tracking-tight">{shop.name}</h1>
        {shop.is_active && (
          <Link href={`/${lang}/shops/${shop.slug}`} className="text-sm underline underline-offset-4">
            {d.view_public}
          </Link>
        )}
        {ok === "created" ? (
          <div className="flex flex-col gap-2 border border-foreground p-3">
            <p className="font-semibold">{o.created}</p>
            <ol className="list-decimal pl-6 text-sm">
              <li>
                <Link href={`/${lang}/sync?${new URLSearchParams({ shop: shop.slug })}`} className="underline underline-offset-4">
                  {o.step_folder}
                </Link>
              </li>
              <li>{o.step_columns}</li>
              <li>{o.step_visible}</li>
            </ol>
          </div>
        ) : (
          ok && !at && <p className="border border-foreground p-3 font-medium">{okText}</p>
        )}
        {err && !at && <p className="border border-line p-3">{errorText(dict, err)}</p>}
      </header>

      <div className="flex flex-col border-t border-line">
        <DashboardSection {...section("columns")} first title={o.columns_title} summary={summaries.columns}>
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
              <SampleRows rows={(shop.sample_rows ?? []).slice(0, 5)} columns={sampleColumns} title={o.sample_rows} />
              <p className="text-xs text-muted">{o.private_columns_note}</p>
              <SubmitButton pending={o.saving}>{o.approve}</SubmitButton>
            </form>
          )}
        </DashboardSection>

        <DashboardSection {...section("details")} title={d.details_title} summary={summaries.details}>
          {notice("details")}
          <ShopForm
            dict={dict}
            lang={lang}
            shop={shop}
            defaults={{ country: "", timezone: "" }}
            action={saveShop}
            submitLabel={dict.account.save}
          />
        </DashboardSection>

        <DashboardSection {...section("holidays")} title={dict.holidays.title} summary={summaries.holidays}>
          <Holidays
            data={holidays}
            shop={shop}
            lang={lang}
            dict={dict}
            hidden={hidden}
            notice={notice("holidays")}
            editDate={/^\d{4}-\d{2}-\d{2}$/.test(first(sp.date) ?? "") ? first(sp.date)! : null}
          />
        </DashboardSection>

        <DashboardSection {...section("logo")} title={d.logo_title} summary={summaries.logo}>
          <form action={uploadLogo} className="flex flex-col gap-3">
            {hidden({ at: "logo" })}
            {notice("logo")}
            {shop.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element -- logo from Supabase Storage
              <img src={shop.logo_url} alt="" width={64} height={64} className="h-16 w-16 border border-line object-contain" />
            )}
            <LogoInput label={d.upload} busy={o.uploading} />
            <p className="text-sm text-muted">{d.logo_hint}</p>
          </form>
        </DashboardSection>

        <DashboardSection {...section("header")} title={dict.sections.site_logo_title} summary={summaries.header}>
          <SiteLogoPanel data={header} shopName={shop.name} dict={dict} hidden={hidden} notice={notice("header")} />
        </DashboardSection>

        <DashboardSection {...section("items")} title={d.items_title} summary={summaries.items}>
          <p className="text-sm text-muted">{d.items_hint}</p>
          <p className="text-sm text-muted">{d.translation_hint}</p>
          {notice("items")}
          <form method="get" action={`/${lang}/dashboard#items`} className="flex gap-2" role="search">
            <input type="hidden" name="shop" value={shop.slug} />
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

        <DashboardSection {...section("plan")} title={dict.domains.title} summary={summaries.plan}>
          {notice("plan")}
          <p className="text-sm">{plan ? (plan.active ? dict.plan.pro : dict.plan.free) : dict.plan.unavailable}</p>
          <Link href={`/${lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`} className="self-start rounded border border-foreground px-4 py-2 font-medium" data-plan-page>
            {dict.domains.open_page}
          </Link>
        </DashboardSection>

        <DashboardSection {...section("delete")} title={o.delete_title} summary={o.delete_summary}>
          <form action={deleteShop} className="flex flex-col gap-3">
            {hidden({ at: "delete" })}
            {notice("delete")}
            <p className="text-sm">{o.delete_intro}</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="confirm" required />
              {o.delete_confirm}
            </label>
            <SubmitButton pending={o.saving}>{o.delete_button}</SubmitButton>
          </form>
        </DashboardSection>
      </div>
    </div>
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
