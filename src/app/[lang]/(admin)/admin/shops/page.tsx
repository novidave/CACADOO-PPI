import type { Metadata } from "next";
import type { Locale } from "@/i18n/config";
import { t } from "@/i18n/dictionaries";
import { formatDate, formatDateTime } from "@/lib/format";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
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

const STATUSES = ["checkout", "paid", "registering", "configuring", "securing", "live", "waiting_dns", "verified",
  "taken", "failed", "dns_timeout", "lapsed", "ended", "canceled"];
const input = "rounded border border-line px-2 py-1 outline-none focus:border-foreground";

/**
 * Admin → Obchody a domény (2026-11-05; was the top of the long /admin/domains page): the Websupport credit and
 * "Overiť kredit", the domain numbers, the filters, every shop with its plan and domain and the domain actions
 * (admin_domain_overview, admin_domain_stats, the domains function — is_admin() decides each).
 */
export default async function AdminShopsPage({ params, searchParams }: PageProps<"/[lang]/admin/shops">) {
  const { lang, dict, session } = await adminStart(params);
  const a = dict.admin_domains;
  const statusLabel = dict.domains.status as Record<string, string>;
  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim().slice(0, 100);
  const status = first(sp.status) ?? "";
  const kind = first(sp.kind) ?? "";
  const keep = keepOf({ q, status, kind });
  const [overview, stats] = await Promise.all([
    session.supabase.rpc("admin_domain_overview", { p_q: q || null, p_status: status || null, p_kind: kind || null }),
    session.supabase.rpc("admin_domain_stats"),
  ]);
  if (overview.error) return <DbError message={overview.error.message} dict={dict} />;
  const rows = (overview.data ?? []) as Overview[];
  const s = (stats.data ?? {}) as Record<string, unknown>;
  const codeFor = first(sp.code_for);
  const shownCode = codeFor
    ? ((await session.supabase.from("domain_orders").select("auth_code").eq("id", codeFor).maybeSingle()).data as { auth_code: string | null } | null)?.auth_code
    : null;
  const credit = s.credit_eur === null || s.credit_eur === undefined ? null : Number(s.credit_eur);
  const low = Number(s.low_credit_eur ?? 0);
  const hidden = <Hidden lang={lang} keep={keep} />;
  const when = (iso: string | null) => (iso ? formatDateTime(iso, lang as Locale, "UTC") : "");

  return (
    <div className="flex flex-col gap-8">
      <div>
        <AdminHead dict={dict} page="shops" />
        <AdminNotice dict={dict} sp={sp} />
      </div>

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
    </div>
  );
}
