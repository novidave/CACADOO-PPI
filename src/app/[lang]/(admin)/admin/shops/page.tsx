import type { Metadata } from "next";
import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { t } from "@/i18n/dictionaries";
import { formatDate, formatDateTime } from "@/lib/format";
import { adminHref } from "@/lib/adminPages";
import { HEALTH_COLORS, isDomainProblem, problemsFirst, shopState } from "@/lib/adminOverview";
import { DbError } from "@/components/DbError";
import { ExpandRow } from "@/components/admin/ExpandRow";
import { SelectSubmit } from "@/components/SelectSubmit";
import { fieldClass, ghostClass, buttonClass, StatusDot } from "@/components/owner/ui";
import { domainAction, refreshCredit } from "../_parts/actions";
import { AdminHead, AdminNotice, adminStart, adminTitle, first, Hidden, keepOf } from "../_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/shops">): Promise<Metadata> {
  return adminTitle(params, "shops");
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

/** The Stav filter's choices (the database also takes every single status by address). */
const SEGMENTS = ["", "problem", "live", "none"] as const;
/**
 * The table's columns (Obchod · Predplatné · Doména · Stav · Posledná chyba · Otvoriť) from 1024 px, scrolling inside
 * its own box when narrower than 800 px; below 1024 px each shop is a card of two columns with "Otvoriť" next to its
 * name (the button is the row's last child, so it is placed in the first row's second column).
 */
const ROW =
  "grid min-h-16 grid-cols-2 items-center gap-x-3 gap-y-2 border-t border-[#E4E4E4] py-3 text-[15px] [&>[data-row-toggle]]:col-start-2 [&>[data-row-toggle]]:row-start-1 [&>[data-row-toggle]]:justify-self-end lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1.1fr)_minmax(0,1.05fr)_104px] lg:gap-y-3 lg:py-2 lg:[&>[data-row-toggle]]:col-start-auto lg:[&>[data-row-toggle]]:row-start-auto lg:[&>[data-row-toggle]]:justify-self-stretch";

/**
 * Admin → Obchody a domény (2026-11-05, canvas "Cacaduu – Admin", artboard 2): the Websupport credit (a yellow strip
 * below its limit) with "Overiť kredit"; the filters — search, Stav (Všetky · S problémom n · Beží · Bez domény), Druh;
 * every shop with its plan and domain, the ones with a problem first; "Otvoriť" opens a row in place: Platba (paid /
 * refunded + invoice), the Websupport order, Platí do, the e-mail about going live and the domain actions. Reads
 * admin_domain_overview / admin_domain_stats; every action goes through the domains function or admin_resolve_domain —
 * is_admin() decides each.
 */
export default async function AdminShopsPage({ params, searchParams }: PageProps<"/[lang]/admin/shops">) {
  const { lang, dict, session } = await adminStart(params);
  const a = dict.admin_domains;
  const h = dict.admin_home as Record<string, string>;
  const statusLabel = dict.domains.status as Record<string, string>;
  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim().slice(0, 100);
  const status = first(sp.status) ?? "";
  const kind = first(sp.kind) ?? "";
  const keep = keepOf({ q, status, kind });
  const [overview, stats, problems] = await Promise.all([
    session.supabase.rpc("admin_domain_overview", { p_q: q || null, p_status: status || null, p_kind: kind || null }),
    session.supabase.rpc("admin_domain_stats"),
    // "S problémom n" counts every shop, whatever the filter shows now
    session.supabase.rpc("admin_domain_overview", { p_q: null, p_status: "problem", p_kind: null }),
  ]);
  if (overview.error) return <DbError message={overview.error.message} dict={dict} />;
  const rows = problemsFirst((overview.data ?? []) as Overview[]);
  const problemCount = problems.error ? rows.filter(isDomainProblem).length : ((problems.data ?? []) as unknown[]).length;
  const s = (stats.data ?? {}) as Record<string, unknown>;
  const codeFor = first(sp.code_for);
  const shownCode = codeFor
    ? ((await session.supabase.from("domain_orders").select("auth_code").eq("id", codeFor).maybeSingle()).data as { auth_code: string | null } | null)?.auth_code
    : null;
  const credit = s.credit_eur === null || s.credit_eur === undefined ? null : Number(s.credit_eur);
  const low = Number(s.low_credit_eur ?? 0);
  const below = credit !== null && credit < low;
  const hidden = <Hidden lang={lang} keep={keep} />;
  const when = (iso: string | null) => (iso ? formatDateTime(iso, lang as Locale, "UTC") : "");
  const day = (iso: string) => formatDate(iso, lang as Locale, "UTC");
  const filterHref = (next: Record<string, string>) => adminHref(lang, "shops", Object.fromEntries(Object.entries({ q, status, kind, ...next }).filter(([, v]) => v)));
  const segmentLabel = (v: (typeof SEGMENTS)[number]) =>
    v === "" ? a.filter_all : v === "problem" ? `${a.filter_problem} ${problemCount}` : v === "live" ? statusLabel.live : a.filter_none;
  const kv = "flex min-w-0 flex-col gap-0.5 text-sm";
  const kvHead = "text-xs font-bold uppercase tracking-[.04em] text-[#5C5C5C]";

  return (
    <div className="flex flex-col gap-3">
      <div>
        <AdminHead dict={dict} page="shops" />
        <AdminNotice dict={dict} sp={sp} />
      </div>

      <section
        id="credit"
        aria-label={a.credit_refresh}
        className={`flex flex-wrap items-center justify-between gap-3.5 rounded-[14px] px-4 py-3 ${below ? "border-2 border-[#F2B705] bg-[#FFFBEA]" : "border border-[#E4E4E4]"}`}
        data-credit-strip={below ? "low" : "ok"}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <strong className="text-base" data-credit>
            {credit === null ? a.credit_unknown : t(a.credit, { credit: credit.toFixed(2), time: when(s.credit_checked_at as string | null) })}
          </strong>
          <span className="text-sm">
            {below ? `${t(a.credit_low, { limit: low.toFixed(2) })} ` : ""}
            {t(a.stats, { bought: Number(s.bought ?? 0), connected: Number(s.connected ?? 0), live: Number(s.live ?? 0) })}
          </span>
          <span className="text-[13px] text-[#5C5C5C]">{a.volume}</span>
        </span>
        <form action={refreshCredit} className="flex-none">
          {hidden}
          <button type="submit" className={`${ghostClass} !min-h-11 !px-4 !text-[15px]`}>
            {a.credit_refresh}
          </button>
        </form>
      </section>

      <section id="shops" aria-label={dict.admin_nav.shops} className="flex flex-col gap-3">
        <form method="get" role="search" className="flex flex-wrap items-center gap-2.5">
          {status && <input type="hidden" name="status" value={status} />}
          <label className="flex min-w-0 flex-1 basis-64 items-center gap-2.5 rounded-xl border border-[#D6D6D6] px-3.5 focus-within:border-[#111]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5C5C5C" strokeWidth="2" aria-hidden="true" className="flex-none">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <span className="sr-only">{h.search_placeholder}</span>
            <input type="search" name="q" defaultValue={q} placeholder={h.search_placeholder} className="min-h-[50px] min-w-0 flex-1 bg-transparent text-base font-medium outline-none" />
          </label>
          <nav aria-label={h.status_label} className="flex max-w-full flex-none gap-1 overflow-x-auto rounded-xl border border-[#D6D6D6] p-1 [scrollbar-width:none]" data-status-filter>
            {SEGMENTS.map((v) => {
              const on = status === v;
              return (
                <Link
                  key={v || "all"}
                  href={filterHref({ status: v })}
                  aria-current={on ? "true" : undefined}
                  className={`flex min-h-11 flex-none items-center whitespace-nowrap rounded-[10px] px-3.5 text-[15px] font-bold no-underline ${on ? "bg-[#111] text-white" : "text-[#3D3D3D] hover:bg-[#F4F4F4]"}`}
                  data-status={v || "all"}
                >
                  {segmentLabel(v)}
                </Link>
              );
            })}
          </nav>
          <SelectSubmit
            name="kind"
            value={kind}
            label={a.filter_kind}
            options={[
              { value: "", label: h.kind_all },
              { value: "bought", label: h.kind_bought },
              { value: "connected", label: h.kind_connected },
            ]}
            className={`${fieldClass} !w-auto flex-none !py-0 !text-[15px] font-bold`}
            data="kind"
          />
          <noscript>
            <button type="submit" className={`${ghostClass} !min-h-[52px] !px-4 !text-[15px]`}>
              {a.filter_button}
            </button>
          </noscript>
        </form>

        {rows.length === 0 ? (
          <p className="text-sm text-[#5C5C5C]">{a.none}</p>
        ) : (
          <div className="lg:overflow-x-auto" data-admin-domains>
            <div className="lg:min-w-[50rem]">
              <div className={`${ROW} !hidden !min-h-9 border-t-0 text-xs font-bold uppercase tracking-[.04em] text-[#5C5C5C] lg:!grid`} aria-hidden="true">
                <span>{a.col_shop}</span>
                <span>{a.col_plan}</span>
                <span>{a.col_domain}</span>
                <span>{a.col_status}</span>
                <span>{a.col_error}</span>
                <span />
              </div>
              {rows.map((r) => {
                const state = shopState(r);
                const cells = (
                  <>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <strong className="break-words">{r.shop_name}</strong>
                      <span className="break-all text-[13px] text-[#5C5C5C]">{r.shop_slug}</span>
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <strong>{r.has_plan ? a.plan_pro : a.plan_free}</strong>
                      {r.cancel_at ? (
                        <span className="text-[13px] text-[#5C5C5C]">{t(a.ends, { date: day(r.cancel_at) })}</span>
                      ) : r.period_end ? (
                        <span className="text-[13px] text-[#5C5C5C]">{t(h.next_payment, { date: day(r.period_end) })}</span>
                      ) : null}
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      {r.hostname ? <span className="break-all">{r.hostname}</span> : <span className="text-[13px] text-[#5C5C5C]">{h.no_domain}</span>}
                      {r.kind && (
                        <span className="text-[13px] text-[#5C5C5C]">
                          {r.kind === "bought" ? a.kind_bought : a.kind_connected}
                          {r.test_mode ? ` · ${a.test}` : ""}
                        </span>
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5" data-status={r.status ?? ""}>
                      {r.status ? (
                        <span className="flex items-center gap-[7px] font-bold">
                          <StatusDot color={HEALTH_COLORS[state.health]} />
                          {statusLabel[r.status] ?? r.status}
                        </span>
                      ) : (
                        <span className="text-[13px] text-[#5C5C5C]">–</span>
                      )}
                      {state.note === "needs_admin" && <span className="text-[13px] font-bold">{a.needs_admin}</span>}
                      {state.note === "waiting_credit" && <span className="text-[13px] font-bold">{a.waiting_credit}</span>}
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      {r.last_error ? <span className="break-words text-sm">{r.last_error}</span> : <span className="text-[13px] text-[#5C5C5C]">–</span>}
                      {r.last_error_at && <span className="text-[13px] text-[#5C5C5C]">{when(r.last_error_at)}</span>}
                    </span>
                  </>
                );
                if (!r.domain_id) {
                  return (
                    <div key={r.shop_id} className={ROW} data-shop={r.shop_slug}>
                      {cells}
                      <span className="hidden lg:block" />
                    </div>
                  );
                }
                const actions = (
                  [
                    ["dns", a.action_dns, r.kind === "connected" && r.status !== "live"],
                    ["retry", a.action_retry, r.status !== "live"],
                    ["email", a.action_email, r.status === "live"],
                    ["auth", a.action_auth, r.kind === "bought" && !r.test_mode],
                    ["resolve", a.action_resolve, r.needs_admin],
                  ] as [string, string, boolean][]
                ).filter(([, , show]) => show);
                const panel = (
                  <>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      <span className={kv}>
                        <span className={kvHead}>{a.col_stripe}</span>
                        <span>
                          {r.refunded_at ? a.stripe_refunded : r.paid_at ? a.stripe_paid : "–"}
                          {r.invoice_url && (
                            <>
                              {" · "}
                              <a href={r.invoice_url} target="_blank" rel="noopener" className="underline underline-offset-4">
                                {r.stripe_invoice}
                              </a>
                            </>
                          )}
                        </span>
                      </span>
                      <span className={kv}>
                        <span className={kvHead}>{a.col_order}</span>
                        <span className="break-all font-mono text-[13px]">{r.registrar_order_id || "–"}</span>
                      </span>
                      <span className={kv}>
                        <span className={kvHead}>{a.col_expires}</span>
                        <span>{r.expires_at ? day(r.expires_at) : "–"}</span>
                      </span>
                      <span className={kv}>
                        <span className={kvHead}>{a.col_email}</span>
                        <span>{r.live_email_sent ? a.yes : a.no}</span>
                      </span>
                    </div>
                    {r.last_error && (
                      <p className="break-words text-sm">
                        <strong>{a.col_error}:</strong> {r.last_error}
                        {r.last_error_at ? <span className="text-[#5C5C5C]"> · {when(r.last_error_at)}</span> : null}
                      </p>
                    )}
                    {actions.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {actions.map(([value, label]) => (
                          <form key={value} action={domainAction}>
                            {hidden}
                            <input type="hidden" name="order_id" value={r.domain_id!} />
                            <button type="submit" name="do" value={value} className={`${value === "resolve" ? buttonClass : ghostClass} !min-h-11 !px-4 !text-[15px]`} data-action={value}>
                              {label}
                            </button>
                          </form>
                        ))}
                      </div>
                    )}
                    {codeFor === r.domain_id && (
                      <p className="font-mono text-sm" data-auth-code>
                        {shownCode ?? "—"}
                      </p>
                    )}
                    {r.kind === "bought" && !r.test_mode && (
                      <form action={domainAction} className="flex flex-wrap items-center gap-2">
                        {hidden}
                        <input type="hidden" name="order_id" value={r.domain_id} />
                        <label className="min-w-0 flex-1 basis-56">
                          <span className="sr-only">{a.action_auth}</span>
                          <input name="auth_code" placeholder={a.auth_placeholder} className={`${fieldClass} !min-h-11 !text-[15px]`} />
                        </label>
                        <button type="submit" name="do" value="save_auth" className={`${ghostClass} !min-h-11 !px-4 !text-[15px]`}>
                          {a.action_save_auth}
                        </button>
                      </form>
                    )}
                  </>
                );
                return (
                  <ExpandRow
                    key={r.shop_id}
                    id={`shop-${r.shop_slug}`}
                    className={ROW}
                    cells={cells}
                    panel={panel}
                    label={t(h.row_label, { shop: r.shop_name })}
                    openLabel={h.open}
                    closeLabel={h.close}
                    startOpen={codeFor === r.domain_id}
                    data-shop={r.shop_slug}
                  />
                );
              })}
            </div>
          </div>
        )}
        <p className="border-t border-[#E4E4E4] pt-2.5 text-sm text-[#5C5C5C]">{t(h.shops_count, { n: rows.length })}</p>
      </section>
    </div>
  );
}
