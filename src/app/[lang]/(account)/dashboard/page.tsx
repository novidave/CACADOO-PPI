import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { addressLine, formatDate, formatDateTime, formatPrice, formatTime, localDay } from "@/lib/format";
import { MAPPING_FIELDS, REQUIRED_FIELDS, type MyShop } from "@/lib/myShops";
import { translatedName, type NameI18n } from "@/lib/names";
import { availabilityText, type AvailabilityKey } from "@/lib/stock";
import { folderSyncLabels } from "@/lib/syncLabels";
import { DashboardSection } from "@/components/DashboardSection";
import { DbError } from "@/components/DbError";
import { FolderSync } from "@/components/FolderSync";
import { LogoInput } from "@/components/LogoInput";
import { PendingButton } from "@/components/PendingButton";
import { RecentImports, type ImportView } from "@/components/RecentImports";
import { ShopForm } from "@/components/ShopForm";
import {
  approveColumns,
  deleteShop,
  openBilling,
  saveAssistantTexts,
  saveShop,
  saveTranslation,
  uploadLogo,
} from "./actions";
import { CloudFolder, cloudSummary, loadCloud } from "./CloudFolder";
import { conversationFilter, Conversations, conversationsSummary, loadConversations } from "./Conversations";
import { PrivateFiles, privateFiles } from "./PrivateFiles";
import { loadShopDocs, ShopDocuments } from "./ShopDocuments";

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

/** One stock file report (public.stock_imports, written only by stock-pull). */
interface ImportRow {
  id: number;
  file_name: string | null;
  file_time: string | null;
  received_at: string;
  status: "ok" | "errors" | "waiting";
  total_rows: number;
  imported: number;
  zeroed: number;
  skipped: number;
  error: string | null;
  columns: string[] | null;
  preview: Record<string, unknown>[] | null;
}

/** The shop's row in subscriptions (written only by the Stripe functions). */
interface PlanRow {
  status: string;
  plan: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

/** Subscriptions that still bill or can come back: managed in the Stripe customer portal. */
const LIVE_PLAN = ["trialing", "active", "past_due", "unpaid", "paused"];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const ERRORS = [
  "name",
  "limit",
  "columns",
  "website",
  "email",
  "facebook",
  "logo",
  "translation",
  "plan_active",
  "plan_unavailable",
  "no_plan",
] as const;

function errorText(dict: Dictionary, err: string): string {
  if (err === "logo") return dict.dashboard.logo_bad;
  if (err.startsWith("docs:")) return t(dict.docs.error_failed, { message: err.slice("docs:".length) });
  if (err.startsWith("docs_")) {
    const text = (dict.docs as Record<string, string>)[`error_${err.slice("docs_".length)}`];
    if (text) return text;
  }
  if (err.startsWith("stripe:")) return t(dict.plan.failed, { message: err.slice("stripe:".length) });
  if (err.startsWith("cloud_")) {
    const code = err.slice("cloud_".length);
    if (code === "share_link") return dict.cloud.share_link;
    if (code.startsWith("other:")) return t(dict.cloud.error_other, { message: code.slice("other:".length) });
    return (dict.cloud as Record<string, string>)[`error_${code}`] ?? dict.cloud.error_failed;
  }
  const key = ERRORS.find((e) => e === err);
  if (key && key !== "logo") return key === "website" ? t(dict.account.error, { message: err }) : dict.owner[`error_${key}`];
  return t(dict.account.error, { message: err });
}

/**
 * The shop owner's own area (self-service): create shops, edit details, connect the
 * export folder, see the last stock files, approve the stock-file columns, the plan, the
 * assistant's texts and documents. Every main section is a dropdown with a summary line.
 * Nothing here changes the uploaded stock or how it is shown: that comes only from the file.
 */
export default async function DashboardPage({ params, searchParams }: PageProps<"/[lang]/dashboard">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const sp = await searchParams;
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
  const [{ data: itemRows, error: e3 }, planRow, hasPlan, itemCount, importRows, docsData, conversations, cloud] = await Promise.all([
    supabase.rpc("owner_items", { p_shop_id: shop.id, q: q || null, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE }),
    supabase
      .from("subscriptions")
      .select("status, plan, current_period_end, cancel_at, stripe_customer_id, stripe_subscription_id")
      .eq("shop_id", shop.id)
      .maybeSingle(),
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    supabase.from("shop_items").select("id", { count: "exact", head: true }).eq("shop_id", shop.id),
    // The last 10 stock files: written only by stock-pull, read only by the shop's owners (RLS).
    supabase
      .from("stock_imports")
      .select("id, file_name, file_time, received_at, status, total_rows, imported, zeroed, skipped, error, columns, preview")
      .eq("shop_id", shop.id)
      .order("received_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(10),
    loadShopDocs(supabase, shop.id),
    // The assistant's conversations (database update 22): owners only.
    loadConversations(supabase, shop.id, conversationFilter(sp)),
    // The shop's cloud folder (database update 23): owners only, never the tokens.
    loadCloud(supabase, shop.id),
  ]);
  // The database decides whether the shop has the paid plan; before database update 18
  // the Plan section only says that paid plans are not available yet.
  const plan = planRow.error || hasPlan.error ? null : { row: planRow.data as PlanRow | null, active: hasPlan.data === true };
  if (e3) return <DbError message={e3.message} dict={dict} />;
  const items = (itemRows ?? []) as OwnerItem[];
  const total = Number(items[0]?.total_count ?? 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const products = itemCount.count ?? total;
  // Before database update 21 there are no stock file reports yet: the slideshow is left out.
  const importList = importRows.error ? null : ((importRows.data ?? []) as ImportRow[]);
  const files = privateFiles(docsData);

  const hidden = (extra: Record<string, string> = {}) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="shop_id" value={shop.id} />
      <input type="hidden" name="shop_slug" value={shop.slug} />
      {Object.entries(extra).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
  const pageUrl = (n: number) =>
    `/${lang}/dashboard?${new URLSearchParams({ shop: shop.slug, ...(q ? { q } : {}), page: String(n) })}#items`;
  const when = (iso: string | null) => (iso ? formatDateTime(iso, lang, shop.timezone) : dict.account.never);
  // "today 14:20" / "yesterday 14:20" / the date, in the shop's time zone.
  const now = new Date();
  const recently = (iso: string) => {
    const date = new Date(iso);
    const day = localDay(date, shop.timezone);
    const time = formatTime(date, shop.timezone);
    if (day === localDay(now, shop.timezone)) return t(d.today_at, { time });
    if (day === localDay(new Date(now.getTime() - 86_400_000), shop.timezone)) return t(d.yesterday_at, { time });
    return formatDateTime(iso, lang, shop.timezone);
  };
  const productCount = (n: number) => {
    const forms = d as Record<string, string>;
    return t(forms[`products_${new Intl.PluralRules(lang).select(n)}`] ?? d.products_other, { n });
  };
  const okTexts: Record<string, string> = {
    columns: o.columns_saved,
    translation: d.translation_saved,
    translation_auto: d.translation_auto_done,
    docs_terms: dict.docs.ok_terms,
    docs_deleted: dict.docs.ok_deleted,
    docs_revoked: dict.docs.ok_revoked,
    assistant_cleaned: d.assistant_cleaned,
    retention: t(dict.conversations.retention_saved, { n: conversations?.retention ?? 90 }),
    conversation_deleted: dict.conversations.deleted,
    cloud_connected: dict.cloud.ok_connected,
    cloud_disconnected: dict.cloud.ok_disconnected,
    cloud_folder: dict.cloud.ok_folder,
    cloud_backfill: t(dict.cloud.ok_backfill, { n: Math.max(0, Math.floor(Number(first(sp.n)) || 0)) }),
    cloud_retry: dict.cloud.ok_retry,
  };
  const okText = (ok && okTexts[ok]) || dict.account.saved;
  // The message of a form is shown inside that form's section (the page jumps there and opens it).
  const at = first(sp.at);
  const notice = (section: string) =>
    at === section && (ok || err) ? (
      <p role="status" className={ok ? "border border-foreground p-3 font-medium" : "border border-line p-3"}>
        {ok ? okText : errorText(dict, err!)}
      </p>
    ) : null;
  const section = (id: string) => ({ id, forceOpen: at === id });

  // Columns of the stock file: every column name of the last file (values only of the approved ones).
  const columns = shop.file_columns?.length
    ? shop.file_columns
    : [...new Set((shop.sample_rows ?? []).flatMap((row) => Object.keys(row)))];
  const sampleColumns = [...new Set((shop.sample_rows ?? []).flatMap((row) => Object.keys(row)))];

  // One line per section while it is closed.
  const latestImport = importList?.[0] ?? null;
  const lastUpload = latestImport?.received_at ?? shop.latest_file_time;
  const summaries = {
    export: lastUpload ? t(d.summary_export, { when: recently(lastUpload), products: productCount(products) }) : d.summary_no_file,
    private: t(dict.docs.folder_count, { n: files.length }),
    imports: latestImport
      ? t(dict.imports.summary, { status: dict.imports[`status_${latestImport.status}`], when: recently(latestImport.received_at) })
      : d.summary_no_file,
    columns: columns.length === 0 ? d.summary_no_file : shop.mapping_status === "confirmed" ? o.state_confirmed : o.state_proposed,
    details: addressLine(shop.address, shop.city) || shop.name,
    logo: shop.logo_url ? d.summary_logo : d.summary_no_logo,
    items: productCount(products),
    assistant: plan?.active ? t(d.summary_assistant, { label: shop.assistant_label || dict.chat.title }) : d.assistant_plan_only,
    plan: plan ? (plan.active ? dict.plan.pro : dict.plan.free) : dict.plan.unavailable,
    docs: docsData
      ? t(d.summary_docs, { documents: docsData.docs.length, pictures: docsData.pictures.length })
      : dict.docs.unavailable,
    conversations: conversationsSummary(conversations, dict, lang),
    cloud: cloudSummary(cloud, dict),
  };
  const imports: ImportView[] | null =
    importList?.map((row) => ({
      id: row.id,
      fileName: row.file_name ?? "",
      received: formatDateTime(row.received_at, lang, shop.timezone),
      fileTime: row.file_time ? formatDateTime(row.file_time, lang, shop.timezone) : null,
      status: row.status,
      total: row.total_rows,
      imported: row.imported,
      zeroed: row.zeroed,
      skipped: row.skipped,
      error: row.error,
      columns: row.columns ?? [],
      preview: Array.isArray(row.preview) ? row.preview : [],
    })) ?? null;

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
              <li>{o.step_folder}</li>
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
        <DashboardSection {...section("export")} first title={o.export_title} summary={summaries.export}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted">{d.latest_file}</dt>
            <dd>{when(shop.latest_file_time)}</dd>
            <dt className="text-muted">{d.state}</dt>
            <dd className="font-semibold">{dict.account[`state_${shop.freshness_state}`]}</dd>
            <dt className="text-muted">{o.folder_seen}</dt>
            <dd>{when(shop.folder_seen_at)}</dd>
            <dt className="text-muted">{o.last_file_name}</dt>
            <dd className="break-all">{shop.last_file_name || "–"}</dd>
            <dt className="text-muted">{d.last_error}</dt>
            <dd>{shop.last_error || dict.account.none}</dd>
          </dl>
          <FolderSync
            shopId={shop.id}
            shopName={shop.name}
            showName={false}
            lang={lang}
            timeZone={shop.timezone}
            loginHref={`/${lang}/login`}
            labels={folderSyncLabels(dict)}
          />
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{o.export_rules_title}</span>
            <ul className="list-disc pl-6">
              <li>{o.rule_folder}</li>
              <li>{o.rule_format}</li>
              <li>{o.rule_columns}</li>
              <li>{o.rule_all}</li>
              <li>{o.rule_schedule}</li>
              <li>{o.rule_public}</li>
              <li>{o.rule_pc}</li>
            </ul>
          </div>
          <Link href={`/${lang}/sync`} className="self-start text-sm underline underline-offset-4">
            {o.open_sync}
          </Link>
        </DashboardSection>

        {docsData && (plan?.active || files.length > 0) && (
          <DashboardSection {...section("private")} title={d.private_title} summary={summaries.private}>
            <PrivateFiles files={files} shop={shop} lang={lang} dict={dict} notice={notice("private")} />
          </DashboardSection>
        )}

        {imports && (
          <DashboardSection {...section("imports")} title={dict.imports.title} summary={summaries.imports}>
            <p className="text-sm text-muted">{dict.imports.intro}</p>
            <RecentImports imports={imports} labels={dict.imports} />
          </DashboardSection>
        )}

        <DashboardSection {...section("columns")} title={o.columns_title} summary={summaries.columns}>
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
                        <ItemNames item={item} lang={lang} dict={dict} hidden={hidden({ at: "items", item_id: item.item_id, q, page: String(page) })} />
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

        <DashboardSection {...section("assistant")} title={d.assistant_title} summary={summaries.assistant}>
          {notice("assistant")}
          <p className="text-sm">{d.assistant_intro}</p>
          {plan?.active ? (
            <form action={saveAssistantTexts} className="flex flex-col gap-3">
              {hidden({ at: "assistant" })}
              <Field label={d.assistant_label}>
                <input
                  name="assistant_label"
                  maxLength={40}
                  defaultValue={shop.assistant_label ?? ""}
                  placeholder={dict.chat.title}
                  className={inputClass}
                />
              </Field>
              <Field label={d.assistant_welcome}>
                <textarea
                  name="assistant_welcome"
                  maxLength={300}
                  rows={3}
                  defaultValue={shop.assistant_welcome ?? ""}
                  placeholder={dict.chat.intro}
                  className={inputClass}
                />
              </Field>
              <p className="text-sm text-muted">{d.assistant_hint}</p>
              <SubmitButton pending={o.saving}>{dict.account.save}</SubmitButton>
            </form>
          ) : (
            <p className="border border-line p-3 text-sm">{d.assistant_needs_plan}</p>
          )}
        </DashboardSection>

        {(plan?.active || (conversations?.all ?? 0) > 0) && (
          <DashboardSection {...section("conversations")} title={dict.conversations.title} summary={summaries.conversations}>
            <Conversations
              data={conversations}
              shop={shop}
              lang={lang}
              dict={dict}
              hasPlan={plan?.active === true}
              cloudConnected={Boolean(cloud?.connection)}
              hidden={hidden}
              notice={notice("conversations")}
            />
          </DashboardSection>
        )}

        {cloud && (plan?.active || cloud.connection) && (
          <DashboardSection {...section("cloud")} title={dict.cloud.title} summary={summaries.cloud}>
            <CloudFolder
              cloud={cloud}
              shop={shop}
              lang={lang}
              dict={dict}
              hasPlan={plan?.active === true}
              hidden={hidden}
              notice={notice("cloud")}
            />
          </DashboardSection>
        )}

        <DashboardSection {...section("plan")} title={dict.plan.title} summary={summaries.plan}>
          {notice("plan")}
          {first(sp.plan) === "done" && (
            <p role="status" className="border border-foreground p-3 font-medium">
              {plan?.active ? dict.plan.thanks : dict.plan.done}
            </p>
          )}
          {first(sp.plan) === "canceled" && <p role="status" className="border border-line p-3">{dict.plan.canceled}</p>}
          {plan ? (
            <PlanDetails plan={plan} shop={shop} lang={lang} dict={dict} hidden={hidden} />
          ) : (
            <p className="text-sm text-muted">{dict.plan.unavailable}</p>
          )}
        </DashboardSection>

        <DashboardSection {...section("docs")} title={dict.docs.title} summary={summaries.docs}>
          <ShopDocuments
            supabase={supabase}
            data={docsData}
            shop={shop}
            lang={lang}
            dict={dict}
            hasPlan={plan?.active === true}
            notice={notice("docs")}
          />
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

const inputClass = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm">{label}</span>
      {children}
    </label>
  );
}

/** The shop's own name, its translation in the page language, and the owner's correction form. */
function ItemNames({
  item,
  lang,
  dict,
  hidden,
}: {
  item: OwnerItem;
  lang: Locale;
  dict: Dictionary;
  hidden: React.ReactNode;
}) {
  const d = dict.dashboard;
  const translated = translatedName(item.item_name, item.name_i18n, lang);
  const renamed = item.name_i18n_by_owner && item.translated_name_source !== null && item.translated_name_source !== item.item_name;
  return (
    <div className="flex min-w-48 flex-col gap-1">
      <span>{item.item_name}</span>
      {translated && <span className="text-muted">{translated}</span>}
      {!item.name_i18n && <span className="text-xs text-muted">{d.translation_waiting}</span>}
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

/** Current plan, the subscription's state and date, "Upgrade" and "Manage subscription". */
function PlanDetails({
  plan,
  shop,
  lang,
  dict,
  hidden,
}: {
  plan: { row: PlanRow | null; active: boolean };
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
}) {
  const p = dict.plan;
  const row = plan.row;
  const subscribed = Boolean(row?.stripe_subscription_id) && row?.status !== "none";
  const live = subscribed && LIVE_PLAN.includes(row?.status ?? "");
  const until = row?.cancel_at ?? row?.current_period_end ?? null;
  const statusText = row ? ((p as Record<string, string>)[`status_${row.status}`] ?? row.status) : "";
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted">{p.current}</dt>
        <dd className="font-semibold">{plan.active ? p.pro : p.free}</dd>
        {subscribed && (
          <>
            <dt className="text-muted">{p.status}</dt>
            <dd>{statusText}</dd>
          </>
        )}
        {plan.active && until && (
          <>
            <dt className="text-muted">{row?.cancel_at ? p.ends : p.renews}</dt>
            <dd>{formatDate(until, lang, shop.timezone)}</dd>
          </>
        )}
      </dl>
      {(row?.status === "past_due" || row?.status === "unpaid") && <p className="text-sm font-medium">{p.payment_problem}</p>}
      <p className="text-sm text-muted">{p.intro}</p>
      <div className="flex flex-wrap gap-2">
        {!live && (
          <form action={openBilling}>
            {hidden({ at: "plan", intent: "checkout" })}
            <PendingButton pending={p.opening}>{p.upgrade}</PendingButton>
          </form>
        )}
        {subscribed && (
          <form action={openBilling}>
            {hidden({ at: "plan", intent: "portal" })}
            <PendingButton pending={p.opening}>{p.manage}</PendingButton>
          </form>
        )}
      </div>
      {!live && !shop.ico && <p className="text-sm text-muted">{p.company_tip}</p>}
    </>
  );
}

function SubmitButton({ children, pending }: { children: React.ReactNode; pending?: string }) {
  if (pending) return <PendingButton pending={pending}>{children}</PendingButton>;
  return (
    <button type="submit" className="self-start rounded border border-foreground px-4 py-2 font-medium">
      {children}
    </button>
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
