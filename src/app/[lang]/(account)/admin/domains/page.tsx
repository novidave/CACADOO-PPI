import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { euros } from "@/lib/domains";
import { formatDate, formatDateTime } from "@/lib/format";
import { missingColumn } from "@/lib/missingColumn";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { deleteDomainPrice, domainAction, refreshCredit, saveDomainPrice, saveDomainSettings, saveSectionLimits } from "./actions";
import { BlogAdmin, type BlogAdminInfo } from "./BlogAdmin";
import { SmsAdmin, type SmsQuotaRow } from "./SmsAdmin";
import { InventoryAdmin, type InventoryOverview } from "./InventoryAdmin";
import { ErrorsAdmin, type ServerErrorRow } from "./ErrorsAdmin";
import { type AdminHoliday, HolidaysAdmin } from "./HolidaysAdmin";
import { ExternalSearchAdmin, type SearchSettings, type SourcesEnv } from "./ExternalSearchAdmin";
import { outsideSearchEnabled, sourcesStatus } from "@/lib/productSources";
import { type PartnerEnv, PartnerFeedsAdmin, type PartnerSettings } from "./PartnerFeedsAdmin";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/domains">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).admin_domains.title };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface Overview {
  shop_id: string;
  shop_name: string;
  shop_slug: string;
  plan_status: string;
  has_plan: boolean;
  period_end: string | null;
  cancel_at: string | null;
  domain_id: string | null;
  kind: "bought" | "connected" | null;
  hostname: string | null;
  site_host: string | null;
  status: string | null;
  test_mode: boolean | null;
  last_error: string | null;
  last_error_at: string | null;
  expires_at: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  stripe_invoice: string | null;
  invoice_url: string | null;
  registrar_order_id: string | null;
  live_email_sent: boolean;
  needs_admin: boolean;
  resolved_at: string | null;
  waiting_credit: boolean;
  renewal_state: string | null;
}

/**
 * "Limity obsahu stránky" per plan: slides, of which PDFs, and files in the library (database update 38), pages and
 * MB per file (update 30; before update 38 only the number of sections, pages and MB).
 */
interface LimitsRow {
  plan: "free" | "pro";
  max_sections: number;
  max_pages: number;
  max_mb: number;
  max_slides?: number;
  max_pdf_slides?: number;
  max_items?: number;
}

interface PriceRow {
  tld: string;
  price_cents: number;
  renewal_cents: number;
  vat_included: boolean;
  sort_order: number;
  active: boolean;
}

const STATUSES = ["checkout", "paid", "registering", "configuring", "securing", "live", "waiting_dns", "verified",
  "taken", "failed", "dns_timeout", "lapsed", "ended", "canceled"];
const input = "rounded border border-line px-2 py-1 outline-none focus:border-foreground";

/**
 * "Predplatné a domény" (admin only): every shop with its plan and domain, filters and the
 * actions, the Websupport credit, the settings and the price table shops see and pay.
 */
export default async function AdminDomainsPage({ params, searchParams }: PageProps<"/[lang]/admin/domains">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  if (!session.isAdmin) notFound();
  const a = dict.admin_domains;
  const statusLabel = dict.domains.status as Record<string, string>;
  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim().slice(0, 100);
  const status = first(sp.status) ?? "";
  const kind = first(sp.kind) ?? "";
  // "Sviatky": one country and year at a time (default: Slovakia, this year).
  const hcountry = /^[A-Za-z]{2}$/.test(first(sp.hcountry) ?? "") ? first(sp.hcountry)!.toUpperCase() : "SK";
  const hyearValue = Number(first(sp.hyear));
  const hyear = Number.isInteger(hyearValue) && hyearValue >= 2000 && hyearValue < 2100 ? hyearValue : new Date().getUTCFullYear();
  const keep = `?${new URLSearchParams({
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    hcountry,
    hyear: String(hyear),
  })}`;

  const [overview, stats, prices, holidays, sectionLimits, searchSettings, sourcesEnv, partnerSettings, partnerEnv, blogLimits, blogInfo, serverErrors, inventory, smsQuotas, smsProvider] = await Promise.all([
    session.supabase.rpc("admin_domain_overview", { p_q: q || null, p_status: status || null, p_kind: kind || null }),
    session.supabase.rpc("admin_domain_stats"),
    session.supabase.from("domain_prices").select("tld, price_cents, renewal_cents, vat_included, sort_order, active").order("sort_order"),
    session.supabase.rpc("admin_holidays", { p_country: hcountry, p_year: hyear }),
    session.supabase
      .from("section_limits")
      .select("plan, max_sections, max_pages, max_mb, max_slides, max_pdf_slides, max_items")
      .then(async (r) => (missingColumn(r.error, "max_slides") ? await session.supabase.from("section_limits").select("plan, max_sections, max_pages, max_mb") : r)),
    // "Vyhľadávanie mimo Cacaduu" (database update 34) and the product-sources function's switches.
    session.supabase.rpc("admin_search_settings"),
    sourcesStatus(session.supabase),
    // "Partnerské feedy" (database update 35) and the partner-feeds function's size limit.
    session.supabase.rpc("admin_partner_settings"),
    session.supabase.functions
      .invoke<{ env: PartnerEnv }>("partner-feeds", { body: { action: "admin_status" } })
      .then(({ data, error }) => (error || !data ? null : data.env))
      .catch(() => null),
    // "Novinky / Blog" (database update 37): the limits and the Meta app's settings from the shop-blog function.
    session.supabase.from("blog_limits").select("plan, max_posts"),
    session.supabase.functions
      .invoke<BlogAdminInfo>("shop-blog", { body: { action: "admin_info" } })
      .then(({ data, error }) => (error || !data ? null : data))
      .catch(() => null),
    // "Chyby za posledných 7 dní" (database update 42).
    session.supabase.rpc("admin_server_errors", { p_days: 7 }),
    // "Skladové programy (API)" (database update 49).
    session.supabase.rpc("admin_inventory_overview"),
    // "SMS" (database update 58): the quotas and which provider the crm-messages function sends with.
    session.supabase.rpc("admin_sms_quotas"),
    session.supabase.functions
      .invoke<{ sms?: string; sms_live?: boolean }>("crm-messages", { body: { action: "config" } })
      .then(({ data, error }) => (error || !data?.sms ? null : { name: data.sms, live: data.sms_live === true }))
      .catch(() => null),
  ]);
  const limitRows = sectionLimits.error ? null : ((sectionLimits.data ?? []) as LimitsRow[]);
  if (overview.error) return <DbError message={overview.error.message} dict={dict} />;
  const rows = (overview.data ?? []) as Overview[];
  const s = (stats.data ?? {}) as Record<string, unknown>;
  const priceRows = (prices.data ?? []) as PriceRow[];
  const codeFor = first(sp.code_for);
  const shownCode = codeFor
    ? ((await session.supabase.from("domain_orders").select("auth_code").eq("id", codeFor).maybeSingle()).data as { auth_code: string | null } | null)?.auth_code
    : null;
  const ok = first(sp.ok);
  const err = first(sp.err);
  const searchErr = err?.startsWith("search_")
    ? (dict.admin_search as Record<string, string>)[`err_${err.slice(7)}`]
    : err?.startsWith("partner_")
      ? t((dict.admin_partners as Record<string, string>)[`err_${err.slice(8)}`] ?? err, { line: first(sp.line) ?? "?" })
      : undefined;
  const credit = s.credit_eur === null || s.credit_eur === undefined ? null : Number(s.credit_eur);
  const low = Number(s.low_credit_eur ?? 0);
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="keep" value={keep} />
    </>
  );
  const when = (iso: string | null) => (iso ? formatDateTime(iso, lang as Locale, "UTC") : "");

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{a.title}</h1>
        {ok && (
          <p role="status" className="border border-foreground p-3 font-medium">
            {ok === "partner_queued"
              ? dict.admin_partners.queued
              : ok === "blog_limits"
                ? dict.admin_blog.saved
                : ok === "inventory"
                  ? dict.admin_inventory.saved
                  : ok === "sms"
                    ? dict.admin_sms.saved
                    : a.done}
          </p>
        )}
        {err && (
          <p role="alert" className="border border-line p-3">
            {searchErr ??
              (err === "blog_limits"
                ? dict.admin_blog.error
                : err === "inventory"
                  ? dict.admin_inventory.error
                  : err === "sms"
                    ? dict.admin_sms.error
                    : t(a.failed, { message: err }))}
          </p>
        )}
      </header>

      <section id="credit" className="flex flex-col gap-2" aria-label={a.credit_refresh}>
        <p data-credit>{credit === null ? a.credit_unknown : t(a.credit, { credit: credit.toFixed(2), time: when(s.credit_checked_at as string | null) })}</p>
        {credit !== null && credit < low && <p className="font-semibold">{t(a.credit_low, { limit: low.toFixed(2) })}</p>}
        <p className="text-sm">{t(a.stats, { bought: Number(s.bought ?? 0), connected: Number(s.connected ?? 0), live: Number(s.live ?? 0) })}</p>
        <p className="text-sm text-muted">{a.volume}</p>
        <form action={refreshCredit}>
          {hidden}
          <PendingButton pending={a.done}>{a.credit_refresh}</PendingButton>
        </form>
      </section>

      <section id="shops" className="flex flex-col gap-3" aria-label={a.title}>
        <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span>{a.filter_q}</span>
            <input name="q" defaultValue={q} className={input} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{a.filter_status}</span>
            <select name="status" defaultValue={status} className={input}>
              <option value="">{a.filter_all}</option>
              <option value="problem">{a.filter_problem}</option>
              <option value="none">{a.filter_none}</option>
              {STATUSES.map((st) => (
                <option key={st} value={st}>
                  {statusLabel[st] ?? st}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{a.filter_kind}</span>
            <select name="kind" defaultValue={kind} className={input}>
              <option value="">{a.filter_all}</option>
              <option value="bought">{a.kind_bought}</option>
              <option value="connected">{a.kind_connected}</option>
            </select>
          </label>
          <button type="submit" className="rounded border border-foreground px-3 py-1 font-medium">
            {a.filter_button}
          </button>
        </form>

        {rows.length === 0 ? (
          <p className="text-sm text-muted">{a.none}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[60rem] text-sm" data-admin-domains>
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  {[a.col_shop, a.col_plan, a.col_next, a.col_domain, a.col_status, a.col_error, a.col_expires, a.col_stripe, a.col_order, a.col_email, a.col_actions].map((h) => (
                    <th key={h} className="py-2 pr-3 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.shop_id} className="border-b border-line align-top" data-shop={r.shop_slug}>
                    <td className="py-2 pr-3">{r.shop_name}</td>
                    <td className="py-2 pr-3">
                      {r.has_plan ? a.plan_pro : a.plan_free}
                      <span className="block text-xs text-muted">{(dict.plan as Record<string, string>)[`status_${r.plan_status}`] ?? r.plan_status}</span>
                    </td>
                    <td className="py-2 pr-3">
                      {r.cancel_at ? t(a.ends, { date: formatDate(r.cancel_at, lang as Locale, "UTC") }) : r.period_end ? formatDate(r.period_end, lang as Locale, "UTC") : ""}
                    </td>
                    <td className="py-2 pr-3">
                      {r.hostname ?? "–"}
                      {r.kind && <span className="block text-xs text-muted">{r.kind === "bought" ? a.kind_bought : a.kind_connected}{r.test_mode ? ` · ${a.test}` : ""}</span>}
                    </td>
                    <td className="py-2 pr-3" data-status={r.status ?? ""}>
                      {r.status ? (statusLabel[r.status] ?? r.status) : ""}
                      {r.waiting_credit && <span className="block text-xs font-semibold">{a.waiting_credit}</span>}
                      {r.needs_admin && <span className="block text-xs font-semibold">{a.needs_admin}</span>}
                    </td>
                    <td className="max-w-56 break-words py-2 pr-3 text-xs">
                      {r.last_error}
                      {r.last_error_at && <span className="block text-muted">{when(r.last_error_at)}</span>}
                    </td>
                    <td className="py-2 pr-3">{r.expires_at ? formatDate(r.expires_at, lang as Locale, "UTC") : ""}</td>
                    <td className="py-2 pr-3">
                      {r.refunded_at ? a.stripe_refunded : r.paid_at ? a.stripe_paid : r.domain_id ? "–" : ""}
                      {r.invoice_url && (
                        <a href={r.invoice_url} target="_blank" rel="noopener" className="block text-xs underline underline-offset-4">
                          {r.stripe_invoice}
                        </a>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{r.registrar_order_id}</td>
                    <td className="py-2 pr-3">{r.domain_id ? (r.live_email_sent ? a.yes : a.no) : ""}</td>
                    <td className="py-2">
                      {r.domain_id && (
                        <div className="flex flex-col gap-1">
                          {[
                            ["retry", a.action_retry, r.status !== "live"],
                            ["dns", a.action_dns, r.kind === "connected" && r.status !== "live"],
                            ["email", a.action_email, r.status === "live"],
                            ["resolve", a.action_resolve, r.needs_admin],
                            ["auth", a.action_auth, r.kind === "bought" && !r.test_mode],
                          ]
                            .filter(([, , show]) => show)
                            .map(([value, label]) => (
                              <form key={String(value)} action={domainAction}>
                                {hidden}
                                <input type="hidden" name="order_id" value={r.domain_id!} />
                                <button type="submit" name="do" value={String(value)} className="text-left underline underline-offset-4">
                                  {String(label)}
                                </button>
                              </form>
                            ))}
                          {codeFor === r.domain_id && <span className="font-mono text-xs" data-auth-code>{shownCode ?? "—"}</span>}
                          {r.kind === "bought" && !r.test_mode && (
                            <form action={domainAction} className="flex gap-1">
                              {hidden}
                              <input type="hidden" name="order_id" value={r.domain_id} />
                              <input name="auth_code" placeholder={a.auth_placeholder} className={`${input} w-28 text-xs`} />
                              <button type="submit" name="do" value="save_auth" className="text-xs underline underline-offset-4">
                                {a.action_save_auth}
                              </button>
                            </form>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section id="settings" className="flex flex-col gap-3" aria-labelledby="settings-heading">
        <h2 id="settings-heading" className="text-lg font-semibold">
          {a.settings_title}
        </h2>
        <form action={saveDomainSettings} className="flex max-w-xl flex-col gap-3 text-sm">
          {hidden}
          <label className="flex flex-col gap-1">
            <span>{a.search_url}</span>
            <input name="search_url" type="url" required defaultValue={String(s.search_url ?? "https://www.websupport.sk")} className={input} />
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" name="same_price" defaultChecked={s.same_price_as_registrar === true} className="mt-1" />
            <span>{a.same_price}</span>
          </label>
          <label className="flex flex-col gap-1">
            <span>{a.low_credit}</span>
            <input name="low_credit" inputMode="decimal" defaultValue={String(s.low_credit_eur ?? 50)} className={`${input} w-32`} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{a.test_domain}</span>
            <input name="test_domain" defaultValue={String(s.test_domain ?? "")} className={input} />
          </label>
          <PendingButton pending={a.done}>{a.save_settings}</PendingButton>
        </form>
      </section>

      <section id="prices" className="flex flex-col gap-3" aria-labelledby="prices-heading">
        <h2 id="prices-heading" className="text-lg font-semibold">
          {a.prices_title}
        </h2>
        <p className="text-sm text-muted">{a.prices_note}</p>
        <div className="flex flex-col gap-2 text-sm" data-prices>
          {[...priceRows, null].map((p) => (
            <div key={p?.tld ?? "new"} className="flex flex-wrap items-end gap-2 border-b border-line pb-2">
              <form action={saveDomainPrice} className="flex flex-wrap items-end gap-2">
                {hidden}
                <label className="flex flex-col gap-1">
                  <span>{a.tld}</span>
                  <input name="tld" required defaultValue={p?.tld ?? ""} readOnly={Boolean(p)} placeholder={p ? undefined : "sk"} className={`${input} w-24`} />
                </label>
                <label className="flex flex-col gap-1">
                  <span>{a.price}</span>
                  <input name="price" required inputMode="decimal" defaultValue={p ? (p.price_cents / 100).toFixed(2) : ""} className={`${input} w-24`} />
                </label>
                <label className="flex flex-col gap-1">
                  <span>{a.renewal}</span>
                  <input name="renewal" required inputMode="decimal" defaultValue={p ? (p.renewal_cents / 100).toFixed(2) : ""} className={`${input} w-24`} />
                </label>
                <label className="flex items-center gap-1 pb-1">
                  <input type="checkbox" name="vat_included" defaultChecked={p ? p.vat_included : true} />
                  {a.vat_included}
                </label>
                <label className="flex flex-col gap-1">
                  <span>{a.sort}</span>
                  <input name="sort" inputMode="numeric" defaultValue={String(p?.sort_order ?? 100)} className={`${input} w-16`} />
                </label>
                <label className="flex items-center gap-1 pb-1">
                  <input type="checkbox" name="active" defaultChecked={p ? p.active : true} />
                  {a.active}
                </label>
                <button type="submit" className="rounded border border-foreground px-3 py-1 font-medium">
                  {p ? a.save_price : a.add_price}
                </button>
              </form>
              {p && (
                <form action={deleteDomainPrice}>
                  {hidden}
                  <input type="hidden" name="tld" value={p.tld} />
                  <button type="submit" className="px-1 py-1 underline underline-offset-4">
                    {a.delete_price}
                  </button>
                </form>
              )}
              {p && <span className="pb-1 text-xs text-muted">{euros(p.price_cents, lang)}</span>}
            </div>
          ))}
        </div>
      </section>

      <section id="section-limits" className="flex flex-col gap-3" aria-labelledby="section-limits-heading">
        <h2 id="section-limits-heading" className="text-lg font-semibold">
          {a.limits_title}
        </h2>
        <p className="text-sm text-muted">{a.limits_hint}</p>
        {!limitRows ? (
          <p className="text-sm text-muted">{a.limits_unavailable}</p>
        ) : (
          <div className="flex flex-col gap-2 text-sm" data-section-limits>
            {(["free", "pro"] as const).map((plan) => {
              const row = limitRows.find((r) => r.plan === plan);
              return (
                <form key={plan} action={saveSectionLimits} className="flex flex-wrap items-end gap-2 border-b border-line pb-2" data-limits-plan={plan}>
                  {hidden}
                  <input type="hidden" name="plan" value={plan} />
                  <span className="w-24 pb-1 font-medium">{plan === "pro" ? a.plan_pro : a.plan_free}</span>
                  {row?.max_slides === undefined ? (
                    <label className="flex flex-col gap-1">
                      <span>{a.limits_sections}</span>
                      <input name="max_sections" type="number" min={0} max={50} required defaultValue={row?.max_sections ?? ""} className={`${input} w-20`} />
                    </label>
                  ) : (
                    <>
                      {/* The number of sections of update 30 stays as it is (the slider decides what is shown). */}
                      <input type="hidden" name="max_sections" value={row.max_sections} />
                      <label className="flex flex-col gap-1">
                        <span>{a.limits_slides}</span>
                        <input name="max_slides" type="number" min={0} max={10} required defaultValue={row.max_slides} className={`${input} w-20`} />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span>{a.limits_pdf_slides}</span>
                        <input name="max_pdf_slides" type="number" min={0} max={10} required defaultValue={row.max_pdf_slides} className={`${input} w-20`} />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span>{a.limits_items}</span>
                        <input name="max_items" type="number" min={0} max={100} required defaultValue={row.max_items} className={`${input} w-20`} />
                      </label>
                    </>
                  )}
                  <label className="flex flex-col gap-1">
                    <span>{a.limits_pages}</span>
                    <input name="max_pages" type="number" min={1} max={50} required defaultValue={row?.max_pages ?? ""} className={`${input} w-20`} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span>{a.limits_mb}</span>
                    <input name="max_mb" type="number" min={1} max={20} required defaultValue={row?.max_mb ?? ""} className={`${input} w-20`} />
                  </label>
                  <button type="submit" className="rounded border border-foreground px-3 py-1 font-medium">
                    {a.limits_save}
                  </button>
                </form>
              );
            })}
          </div>
        )}
      </section>

      <ErrorsAdmin rows={serverErrors.error ? null : ((serverErrors.data ?? []) as ServerErrorRow[])} lang={lang} dict={dict} />

      <InventoryAdmin overview={inventory.error ? null : (inventory.data as InventoryOverview)} lang={lang} dict={dict} hidden={hidden} />

      <SmsAdmin rows={smsQuotas.error ? null : ((smsQuotas.data ?? []) as SmsQuotaRow[])} provider={smsProvider} dict={dict} hidden={hidden} />

      <BlogAdmin
        limits={blogLimits.error ? null : ((blogLimits.data ?? []) as { plan: "free" | "pro"; max_posts: number | null }[])}
        info={blogInfo}
        dict={dict}
        hidden={hidden}
      />

      <ExternalSearchAdmin
        settings={searchSettings.error ? null : (searchSettings.data as SearchSettings)}
        env={sourcesEnv as SourcesEnv | null}
        websiteSecret={outsideSearchEnabled()}
        dict={dict}
        hidden={hidden}
      />

      <PartnerFeedsAdmin
        settings={partnerSettings.error ? null : (partnerSettings.data as PartnerSettings)}
        env={partnerEnv}
        lang={lang}
        dict={dict}
        hidden={hidden}
      />

      <HolidaysAdmin
        rows={holidays.error ? null : ((holidays.data ?? []) as AdminHoliday[])}
        country={hcountry}
        year={hyear}
        lang={lang}
        dict={dict}
        hidden={hidden}
        keep={keep}
      />
    </div>
  );
}
