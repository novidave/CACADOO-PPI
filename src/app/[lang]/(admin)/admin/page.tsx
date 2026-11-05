import type { Metadata } from "next";
import Link from "next/link";
import { t } from "@/i18n/dictionaries";
import { formatDateTime } from "@/lib/format";
import { adminHref } from "@/lib/adminPages";
import {
  HEALTH_COLORS,
  type InventoryConnection,
  type OverviewShop,
  type PartnerInfo,
  pluralOf,
  services,
  type TelegramInfo,
  tiles,
  todos,
} from "@/lib/adminOverview";
import { ownerAiReady } from "@/lib/grammar";
import { outsideSearchEnabled, sourcesStatus } from "@/lib/productSources";
import { cardClass, ghostClass, StatusDot } from "@/components/owner/ui";
import type { BlogAdminInfo } from "./_parts/FacebookAppAdmin";
import type { SearchSettings, SourcesEnv } from "./_parts/ExternalSearchAdmin";
import type { InventoryOverview } from "./_parts/InventoryAdmin";
import { AdminHead, AdminNotice, adminStart, adminTitle } from "./_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin">): Promise<Metadata> {
  return adminTitle(params, "home");
}

/**
 * Admin → Prehľad (2026-11-05, canvas "Cacaduu – Admin", artboard 1): the platform at a glance, built only from the
 * existing admin reads, all at once — four tiles (Obchody, Vlastné domény, Chyby za 7 dní, SMS tento mesiac; each opens
 * its page), "Treba riešiť" (one row per real problem with a dot, one line and "Otvoriť"; "Všetko beží." when none) and
 * "Služby" (a dot + words each). A function that does not answer is grey "neodpovedá", never an error page. The rules
 * are @/lib/adminOverview's.
 */
export default async function AdminHomePage({ params, searchParams }: PageProps<"/[lang]/admin">) {
  const { lang, dict, session } = await adminStart(params);
  const sp = await searchParams;
  const sb = session.supabase;
  const fn = <T,>(name: string, body: Record<string, unknown>): Promise<T | null> =>
    sb.functions
      .invoke<T>(name, { body })
      .then(({ data, error }) => (error || !data ? null : data))
      .catch(() => null);
  const rows = <T,>(r: { data: unknown; error: unknown }): T[] | null => (r.error ? null : ((r.data ?? []) as T[]));

  const [overview, stats, errors, sms, telegram, partners, usage, inventory, search, sourcesEnv, crm, facebook] = await Promise.all([
    sb.rpc("admin_domain_overview", { p_q: null, p_status: null, p_kind: null }),
    sb.rpc("admin_domain_stats"),
    sb.rpc("admin_server_errors", { p_days: 7 }),
    sb.rpc("admin_sms_quotas"),
    fn<TelegramInfo>("telegram", { action: "webhook_info" }),
    sb.rpc("admin_partner_settings"),
    sb.rpc("admin_translation_usage"),
    sb.rpc("admin_inventory_overview"),
    sb.rpc("admin_search_settings"),
    sourcesStatus(sb).catch(() => null),
    fn<{ email?: boolean; sms?: string; sms_live?: boolean }>("crm-messages", { action: "config" }),
    fn<BlogAdminInfo>("shop-blog", { action: "admin_info" }),
  ]);

  const shops = rows<OverviewShop>(overview) ?? [];
  const s = (stats.error ? null : stats.data) as Record<string, unknown> | null;
  const credit = s?.credit_eur === null || s?.credit_eur === undefined ? null : Number(s.credit_eur);
  const partnerList = partners.error ? null : (((partners.data as { partners?: PartnerInfo[] } | null)?.partners ?? []) as PartnerInfo[]);
  const connections = inventory.error ? null : (((inventory.data as InventoryOverview | null)?.connections ?? []) as InventoryConnection[]);
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = (rows<{ month: string; cost_eur: number; alerted_at: string | null }>(usage) ?? []).find((u) => String(u.month).startsWith(month));
  const searchSettings = (search.error ? null : search.data) as SearchSettings | null;
  const env = sourcesEnv as SourcesEnv | null;
  const withDomain = shops.filter((r) => r.domain_id);

  const tile = tiles({ shops, stats: s, errors: rows<{ hits: number }>(errors), sms: rows<{ used_this_month: number; shops_at_limit: number }>(sms) });
  const todo = todos({
    shops,
    credit,
    lowCredit: Number(s?.low_credit_eur ?? 0),
    telegram,
    partners: partnerList,
    translationAlerted: Boolean(thisMonth?.alerted_at),
    translationCost: Number(thisMonth?.cost_eur ?? 0),
    connections,
  });
  const svc = services({
    shops,
    domainTestMode: withDomain.length ? !withDomain.some((r) => !r.test_mode) : null,
    crm,
    aiKey: ownerAiReady(),
    telegram,
    facebook,
    search:
      env === null
        ? null
        : {
            todayCalls: Number(searchSettings?.today_calls ?? 0),
            limit: env.daily_limit ?? null,
            on: outsideSearchEnabled() && env.secret_set !== false && (searchSettings?.layers ?? []).some((l) => l.enabled),
          },
    partners: partnerList,
    connections,
  });

  const h = dict.admin_home as Record<string, string>;
  const statusWords = dict.domains.status as Record<string, string>;
  const counted = (key: string, n: number) => t(h[`${key}_${pluralOf(lang, n)}`], { n });
  const fill = (key: string, vars: Record<string, string | number>) =>
    t(h[key] ?? key, { ...vars, ...(typeof vars.status === "string" ? { status: statusWords[vars.status] ?? vars.status } : {}) });
  const healthCount = (health: string) => svc.filter((v) => v.health === health).length;
  const summary = (
    [
      ["ok", "sum_ok"],
      ["bad", "sum_bad"],
      ["warn", "sum_warn"],
      ["off", "sum_off"],
    ] as const
  )
    .map(([health, key]) => [healthCount(health), key] as const)
    .filter(([n]) => n > 0)
    .map(([n, key]) => counted(key, n))
    .join(" · ");
  const tileClass = "flex min-h-11 flex-col gap-0.5 rounded-[14px] border border-[#E4E4E4] px-4 py-3.5 text-[#111] no-underline hover:border-[#111]";

  return (
    <section className="flex flex-col gap-4" id="overview" aria-label={dict.admin_nav.home}>
      <div>
        <AdminHead dict={dict} page="home" aside={<span className="text-sm text-[#5C5C5C]">{t(h.state_line, { date: formatDateTime(new Date().toISOString(), lang, "UTC") })}</span>} />
        <AdminNotice dict={dict} sp={sp} />
      </div>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4" data-admin-tiles>
        <Link href={adminHref(lang, "shops")} className={tileClass} data-tile="shops">
          <span className="text-[13px] font-bold text-[#5C5C5C]">{h.tile_shops}</span>
          <strong className="text-[26px] leading-tight">{tile.shops.count}</strong>
          <span className="text-[13px] text-[#5C5C5C]">{t(h.tile_shops_sub, { pro: tile.shops.pro, free: tile.shops.free })}</span>
        </Link>
        <Link href={adminHref(lang, "shops")} className={tileClass} data-tile="domains">
          <span className="text-[13px] font-bold text-[#5C5C5C]">{h.tile_domains}</span>
          <strong className="text-[26px] leading-tight">{tile.domains.count}</strong>
          <span className="text-[13px] text-[#5C5C5C]">{t(h.tile_domains_sub, { live: tile.domains.live, problem: tile.domains.problem })}</span>
        </Link>
        <Link href={adminHref(lang, "errors")} className={tileClass} data-tile="errors">
          <span className="text-[13px] font-bold text-[#5C5C5C]">{h.tile_errors}</span>
          <strong className="text-[26px] leading-tight">{counted("places", tile.errors.places)}</strong>
          <span className="text-[13px] text-[#5C5C5C]">{counted("hits", tile.errors.hits)}</span>
        </Link>
        <Link href={adminHref(lang, "sms")} className={tileClass} data-tile="sms">
          <span className="text-[13px] font-bold text-[#5C5C5C]">{h.tile_sms}</span>
          <strong className="text-[26px] leading-tight">{tile.sms.used}</strong>
          <span className="text-[13px] text-[#5C5C5C]">{counted("at_limit", tile.sms.atLimit)}</span>
        </Link>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className={`${cardClass} !gap-0`} aria-labelledby="admin-todo" data-admin-todo>
          <div className="flex items-baseline justify-between gap-3 pb-2">
            <h2 id="admin-todo" className="text-[19px] font-bold">
              {h.todo_title}
            </h2>
            {todo.length > 0 && <span className="text-sm text-[#5C5C5C]">{counted("things", todo.length)}</span>}
          </div>
          {todo.length === 0 ? (
            <p className="flex min-h-14 items-center gap-2.5 border-t border-[#E4E4E4] font-semibold" data-admin-all-ok>
              <StatusDot color={HEALTH_COLORS.ok} />
              {h.all_ok}
            </p>
          ) : (
            <ul className="flex flex-col">
              {todo.map((r, i) => (
                <li key={i} className="border-t border-[#E4E4E4]" data-todo={r.title}>
                  <Link href={adminHref(lang, r.page, undefined, r.hash)} className="flex min-h-[66px] items-center gap-3 py-2 text-[#111] no-underline md:min-h-[72px]">
                    <StatusDot color={HEALTH_COLORS[r.health]} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <strong className="break-words text-[15px] md:text-base">{fill(r.title, r.vars)}</strong>
                      <span className="break-words text-[13px] text-[#5C5C5C] md:text-sm">{fill(r.detail, r.vars)}</span>
                    </span>
                    <span className={`${ghostClass} !hidden !min-h-11 flex-none !px-4 !text-[15px] md:!inline-flex`}>{h.open}</span>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" aria-hidden="true" className="flex-none md:hidden">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={`${cardClass} !gap-0`} aria-labelledby="admin-services" data-admin-services>
          <div className="flex flex-wrap items-baseline gap-x-2 pb-2">
            <h2 id="admin-services" className="text-[19px] font-bold">
              {h.services_title}
            </h2>
            <span className="text-sm text-[#5C5C5C] md:hidden" data-services-sum>
              {summary}
            </span>
          </div>
          <ul className="flex flex-col">
            {svc.map((v) => (
              <li key={v.name} className="flex min-h-[46px] items-center justify-between gap-3 border-t border-[#E4E4E4] text-[15px]" data-service={v.name} data-health={v.health}>
                <span className="min-w-0">{h[v.name]}</span>
                <span className="inline-flex items-center gap-[7px] text-right text-sm font-bold">
                  <StatusDot color={HEALTH_COLORS[v.health]} />
                  {t(h[v.state], v.vars)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}
