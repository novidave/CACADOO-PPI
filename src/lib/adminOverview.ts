/**
 * Admin → Prehľad (2026-11-05, canvas "Cacaduu – Admin", artboard 1): the rules that turn the existing admin reads into
 * the four tiles, the "Treba riešiť" rows and the "Služby" rows — and the shops list's order (problems first). No
 * imports and no texts (the page fills `key` + `vars` from `admin_home.*`); `adminOverview_test.ts` in
 * `npm run test:content`. A status is always shown as a dot next to its words: ok #1E9E5A, warn #F2B705, bad #D64545,
 * off #9AA5B1.
 */

export type Health = "ok" | "warn" | "bad" | "off";

export const HEALTH_COLORS: Record<Health, string> = { ok: "#1E9E5A", warn: "#F2B705", bad: "#D64545", off: "#9AA5B1" };

/** One shop of admin_domain_overview (the fields the overview reads). */
export interface OverviewShop {
  shop_name: string;
  shop_slug: string;
  has_plan: boolean;
  domain_id: string | null;
  hostname: string | null;
  status: string | null;
  test_mode: boolean | null;
  last_error: string | null;
  last_error_at: string | null;
  needs_admin: boolean;
  waiting_credit: boolean;
  paid_at?: string | null;
}

/** A shop's domain needs the admin (the same as admin_domain_overview's filter "problem" and the menu's badge). */
export const isDomainProblem = (r: OverviewShop): boolean =>
  Boolean(r.domain_id) && (r.needs_admin || r.waiting_credit || r.status === "failed" || r.status === "dns_timeout");

/** The shops list: the ones with a problem first, the rest in the database's order. */
export function problemsFirst<T extends OverviewShop>(rows: T[]): T[] {
  return [...rows.filter(isDomainProblem), ...rows.filter((r) => !isDomainProblem(r))];
}

/** The shops' state as the Obchody a domény page shows it: a dot, the status words' key and the note under them. */
export function shopState(r: OverviewShop): { health: Health; note: "needs_admin" | "waiting_credit" | null } {
  if (!r.domain_id) return { health: "off", note: null };
  if (r.waiting_credit) return { health: "warn", note: "waiting_credit" };
  if (r.needs_admin || r.status === "failed" || r.status === "dns_timeout") return { health: "bad", note: "needs_admin" };
  if (r.status === "live") return { health: "ok", note: null };
  if (r.status === "lapsed" || r.status === "ended" || r.status === "canceled") return { health: "off", note: null };
  return { health: "warn", note: null };
}

export interface Tiles {
  shops: { count: number; pro: number; free: number };
  domains: { count: number; live: number; problem: number };
  errors: { places: number; hits: number };
  sms: { used: number; atLimit: number };
}

export function tiles(input: {
  shops: OverviewShop[];
  stats: { live?: unknown } | null;
  errors: { hits: number }[] | null;
  sms: { used_this_month: number; shops_at_limit: number }[] | null;
}): Tiles {
  const pro = input.shops.filter((s) => s.has_plan).length;
  const withDomain = input.shops.filter((s) => s.domain_id);
  const statsLive = Number(input.stats?.live);
  return {
    shops: { count: input.shops.length, pro, free: input.shops.length - pro },
    domains: {
      count: withDomain.length,
      live: Number.isFinite(statsLive) ? statsLive : withDomain.filter((s) => s.status === "live").length,
      problem: withDomain.filter(isDomainProblem).length,
    },
    errors: { places: input.errors?.length ?? 0, hits: (input.errors ?? []).reduce((n, e) => n + Number(e.hits || 0), 0) },
    sms: {
      used: (input.sms ?? []).reduce((n, q) => n + Number(q.used_this_month || 0), 0),
      atLimit: (input.sms ?? []).reduce((n, q) => n + Number(q.shops_at_limit || 0), 0),
    },
  };
}

/** One "Treba riešiť" row: the dot, the title's and the detail's text keys with their values, and the page it opens. */
export interface Todo {
  health: Health;
  title: string;
  detail: string;
  vars: Record<string, string | number>;
  page: "shops" | "integrations" | "partners" | "translations" | "inventory";
  hash: string;
}

export interface TelegramInfo {
  configured: boolean;
  url_ok?: boolean;
  last_error?: string | null;
  last_error_at?: string | null;
}

export interface PartnerInfo {
  name: string;
  enabled?: boolean;
  imports: { status: string; error: string | null; started_at: string }[];
}

export interface InventoryConnection {
  shop: string;
  provider: string;
  status: string;
  last_error: string | null;
}

/** The newest import of a partner (by its start) failed. */
const lastImportFailed = (p: PartnerInfo) => {
  const last = [...(p.imports ?? [])].sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  return last?.status === "error" ? last : null;
};

/** A connection that needs the admin: an invalid key (stopped until a new one), or an error from its last run. */
const connectionProblem = (c: InventoryConnection): Health | null =>
  c.status === "invalid_key" ? "bad" : c.status === "error" || c.last_error ? "warn" : null;

/** The "Treba riešiť" rows, worst first; [] = "Všetko beží." */
export function todos(input: {
  shops: OverviewShop[];
  credit: number | null;
  lowCredit: number;
  telegram: TelegramInfo | null;
  partners: PartnerInfo[] | null;
  /** this month's row of admin_translation_usage: alerted = the 80 % e-mail went out */
  translationAlerted: boolean;
  translationCost: number;
  connections: InventoryConnection[] | null;
}): Todo[] {
  const out: Todo[] = [];
  for (const s of input.shops.filter(isDomainProblem)) {
    const state = shopState(s);
    out.push({
      health: state.health,
      title: "todo_domain",
      detail: s.last_error ? "todo_domain_error" : s.waiting_credit ? "todo_domain_credit" : "todo_domain_detail",
      vars: { host: s.hostname ?? s.shop_slug, shop: s.shop_name, status: s.status ?? "", error: (s.last_error ?? "").slice(0, 120) },
      page: "shops",
      hash: "shops",
    });
  }
  if (input.credit !== null && input.credit < input.lowCredit) {
    out.push({
      health: "warn",
      title: "todo_credit",
      detail: "todo_credit_detail",
      vars: { credit: input.credit.toFixed(2), limit: input.lowCredit.toFixed(2), waiting: input.shops.filter((s) => s.domain_id && s.waiting_credit).length },
      page: "shops",
      hash: "credit",
    });
  }
  const tg = input.telegram;
  if (tg?.configured && tg.url_ok === false) {
    out.push({ health: "bad", title: "todo_telegram_webhook", detail: "todo_telegram_webhook_detail", vars: {}, page: "integrations", hash: "telegram" });
  } else if (tg?.configured && tg.last_error) {
    out.push({ health: "warn", title: "todo_telegram_error", detail: "todo_error_detail", vars: { error: tg.last_error.slice(0, 120) }, page: "integrations", hash: "telegram" });
  }
  for (const p of input.partners ?? []) {
    const failed = lastImportFailed(p);
    if (failed) out.push({ health: "warn", title: "todo_partner", detail: "todo_error_detail", vars: { name: p.name, error: (failed.error ?? "").slice(0, 120) }, page: "partners", hash: "partner-feeds" });
  }
  if (input.translationAlerted) {
    out.push({ health: "warn", title: "todo_translations", detail: "todo_translations_detail", vars: { cost: input.translationCost.toFixed(2) }, page: "translations", hash: "usage" });
  }
  for (const c of input.connections ?? []) {
    const h = connectionProblem(c);
    if (h) out.push({ health: h, title: "todo_inventory", detail: "todo_error_detail", vars: { shop: c.shop, provider: c.provider, status: c.status, error: (c.last_error ?? c.status).slice(0, 120) }, page: "inventory", hash: "inventory" });
  }
  const rank: Record<Health, number> = { bad: 0, warn: 1, ok: 2, off: 3 };
  return out.sort((a, b) => rank[a.health] - rank[b.health]);
}

/** One "Služby" row: its name's key, a dot and the words' key with their values. */
export interface Service {
  name: string;
  health: Health;
  state: string;
  vars: Record<string, string | number>;
}

/** null = the function did not answer: grey "neodpovedá" (never an error page). */
const silent = (name: string): Service => ({ name, health: "off", state: "svc_silent", vars: {} });

export function services(input: {
  shops: OverviewShop[];
  /** the mode of the newest domain order (test_mode), null = no domain yet */
  domainTestMode: boolean | null;
  crm: { email?: boolean; sms?: string; sms_live?: boolean } | null;
  aiKey: boolean;
  telegram: TelegramInfo | null;
  facebook: { configured: boolean } | null;
  search: { todayCalls: number; limit: number | null; on: boolean } | null;
  partners: PartnerInfo[] | null;
  connections: InventoryConnection[] | null;
}): Service[] {
  const out: Service[] = [];
  out.push(
    input.domainTestMode === null
      ? { name: "svc_websupport", health: "off", state: "svc_no_domain", vars: {} }
      : input.domainTestMode
        ? { name: "svc_websupport", health: "warn", state: "svc_test_mode", vars: {} }
        : { name: "svc_websupport", health: "ok", state: "svc_live_mode", vars: {} },
  );
  const subs = input.shops.filter((s) => s.has_plan).length;
  out.push(subs ? { name: "svc_payments", health: "ok", state: "svc_subscriptions", vars: { n: subs } } : { name: "svc_payments", health: "off", state: "svc_no_subscriptions", vars: {} });
  if (!input.crm) out.push(silent("svc_sms"), silent("svc_email"));
  else {
    const sms = input.crm.sms ?? "test";
    out.push(
      sms === "test"
        ? { name: "svc_sms", health: "warn", state: "svc_sms_test", vars: {} }
        : input.crm.sms_live
          ? { name: "svc_sms", health: "ok", state: "svc_sms_live", vars: { provider: sms } }
          : { name: "svc_sms", health: "bad", state: "svc_sms_off", vars: { provider: sms } },
    );
    out.push(input.crm.email ? { name: "svc_email", health: "ok", state: "svc_sending", vars: {} } : { name: "svc_email", health: "bad", state: "svc_not_set", vars: {} });
  }
  out.push(input.aiKey ? { name: "svc_ai", health: "ok", state: "svc_key_set", vars: {} } : { name: "svc_ai", health: "off", state: "svc_key_missing", vars: {} });
  const tg = input.telegram;
  out.push(
    !tg
      ? silent("svc_telegram")
      : !tg.configured
        ? { name: "svc_telegram", health: "off", state: "svc_not_set", vars: {} }
        : tg.url_ok === false
          ? { name: "svc_telegram", health: "bad", state: "svc_webhook_missing", vars: {} }
          : tg.last_error
            ? { name: "svc_telegram", health: "warn", state: "svc_last_error", vars: {} }
            : { name: "svc_telegram", health: "ok", state: "svc_running", vars: {} },
  );
  out.push(
    !input.facebook
      ? silent("svc_facebook")
      : input.facebook.configured
        ? { name: "svc_facebook", health: "ok", state: "svc_set", vars: {} }
        : { name: "svc_facebook", health: "off", state: "svc_not_set", vars: {} },
  );
  const se = input.search;
  out.push(
    !se
      ? silent("svc_search")
      : !se.on
        ? { name: "svc_search", health: "off", state: "svc_off", vars: {} }
        : se.limit !== null && se.todayCalls >= se.limit
          ? { name: "svc_search", health: "warn", state: "svc_calls", vars: { n: se.todayCalls, limit: se.limit } }
          : { name: "svc_search", health: "ok", state: se.limit === null ? "svc_calls_nolimit" : "svc_calls", vars: { n: se.todayCalls, limit: se.limit ?? "" } },
  );
  const parts = input.partners;
  const failed = (parts ?? []).filter((p) => lastImportFailed(p)).length;
  out.push(
    !parts
      ? silent("svc_partners")
      : parts.length === 0
        ? { name: "svc_partners", health: "off", state: "svc_none", vars: {} }
        : failed
          ? { name: "svc_partners", health: "warn", state: "svc_errors", vars: { n: failed } }
          : { name: "svc_partners", health: "ok", state: "svc_count", vars: { n: parts.length } },
  );
  const conns = input.connections;
  const broken = (conns ?? []).filter((c) => connectionProblem(c)).length;
  out.push(
    !conns
      ? silent("svc_inventory")
      : conns.length === 0
        ? { name: "svc_inventory", health: "off", state: "svc_none", vars: {} }
        : broken
          ? { name: "svc_inventory", health: "warn", state: "svc_errors", vars: { n: broken } }
          : { name: "svc_inventory", health: "ok", state: "svc_connections", vars: { n: conns.length } },
  );
  return out;
}

/** Slovak / Hungarian / English plural category for a count: "one", "few" or "other". */
export function pluralOf(lang: string, n: number): "one" | "few" | "other" {
  let rule = "other";
  try {
    rule = new Intl.PluralRules(lang).select(n);
  } catch {
    rule = n === 1 ? "one" : "other";
  }
  return rule === "one" ? "one" : rule === "few" ? "few" : "other";
}
