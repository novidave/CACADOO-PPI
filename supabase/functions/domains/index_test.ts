// Unit tests of domains: names, Websupport signing and orders, Vercel's records, DNS that
// never touches mail, payments recorded once, the steps to "live", the e-mail once, renewals.
// Run: npm run test:functions
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import * as site from "../../../src/lib/domainName.ts";
import {
  cleanDomain,
  daily,
  dnsPlan,
  googleVerification,
  manualRecordName,
  MAX_GOOGLE_RECORDS,
  type DnsRecord,
  type Deps,
  handle,
  nameProblem,
  type Params,
  OWNER_REFUSED,
  type Registrar,
  RegistrarError,
  sendLiveMail,
  soldTld,
  type Stripe,
  StripeError,
  testRegistrar,
  tick,
  validSkIco,
  type Vercel,
  vercelApi,
  verificationRecords,
  type Want,
  websiteRecords,
  websupport,
  websupportProfile,
  wsDate,
  wsSignature,
} from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}
function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
}

const SHOP = "11111111-2222-4333-8444-555555555555";
const OTHER_SHOP = "11111111-2222-4333-8444-666666666666";
const SERVICE = "service-role-key-0123456789";
const CRON = "cron-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const RETURN = "https://ppi.example/sk/dashboard/plan?shop=potraviny";
const OPEN = ["checkout", "paid", "registering", "configuring", "securing", "live", "waiting_dns", "verified"];
const WORK = ["paid", "registering", "configuring", "securing", "waiting_dns", "verified"];

// ---------------------------------------------------------------- a small stand-in for the database

type Row = Record<string, unknown>;

interface World {
  now: number;
  orders: Row[];
  shops: Row[];
  settings: Row[];
  prices: Row[];
  subscriptions: Row[];
  plan: Set<string>;
  owner: Row & { missing: string[] };
  mails: { to: string[]; subject: string; text: string; html?: string }[];
  https: Set<string>;
  background: Promise<unknown>[];
}

function world(): World {
  return {
    now: Date.parse("2026-10-11T10:00:00Z"),
    orders: [],
    shops: [
      { id: SHOP, slug: "potraviny-centrum", name: "Potraviny Centrum", timezone: "Europe/Bratislava" },
      { id: OTHER_SHOP, slug: "drogeria", name: "Drogéria", timezone: "Europe/Budapest" },
    ],
    settings: [{ id: true, test_domain: "cacadoo-test.sk", search_url: "https://www.websupport.sk", same_price_as_registrar: true, low_credit_eur: 30, credit_alert_at: null }],
    prices: [
      { tld: "sk", price_cents: 1990, renewal_cents: 1990, vat_included: true, currency: "EUR", active: true },
      { tld: "eu", price_cents: 1490, renewal_cents: 1590, vat_included: false, currency: "EUR", active: true },
    ],
    subscriptions: [{ shop_id: SHOP, status: "active", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" }],
    plan: new Set([SHOP]),
    owner: {
      company_name: "Potraviny Centrum s.r.o.", contact_name: "Ján Novák", street: "Hlavná 1", city: "Košice", zip: "04001",
      country: "SK", ico: "12345679", dic: null, ic_dph: null, email: "info@example.invalid", phone: "+421 900 123 456", missing: [],
    },
    mails: [],
    https: new Set(),
    background: [],
  };
}

const isoAt = (w: World, plus = 0) => new Date(w.now + plus).toISOString();

function newOrder(w: World, values: Row): Row {
  const row: Row = {
    id: crypto.randomUUID(), shop_id: SHOP, kind: "bought", hostname: "davide.sk", site_host: null, www: true, status: "quoted",
    price_cents: 1990, renewal_cents: 1990, vat_included: true, currency: "EUR", with_pro: false, site_url: "https://ppi.example",
    stripe_session: null, stripe_invoice: null, stripe_payment_intent: null, invoice_url: null, paid_at: null, refunded_at: null,
    refund_id: null, registrar_profile_id: null, registrar_order_id: null, registrar_service_id: null, registrar_paid_at: null,
    test_mode: false, waiting_credit: false, dns_records: null, vercel_added_at: null, checks: 0, last_check_at: null,
    next_check_at: null, attempts: 0, next_attempt_at: null, claimed_until: null, live_at: null, live_email_at: null,
    dns_reminder_at: null, stuck_alert_at: null, failure_alert_at: null, expires_at: null, renewal_state: "none",
    renewal_invoice: null, renewal_invoice_url: null, renewal_paid_until: null, notice_30_at: null, notice_7_at: null,
    renewal_reminder_at: null, auth_code: null, ended_at: null, last_error: null, needs_admin: false, log: [],
    created_at: isoAt(w), updated_at: isoAt(w), ...values,
  };
  w.orders.push(row);
  return row;
}

class Query implements PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> {
  private filters: ((r: Row) => boolean)[] = [];
  private mode: "select" | "update" = "select";
  private values: Row = {};
  private returning = false;
  private single = false;
  private sortKey: string | null = null;
  private ascending = true;
  private max = Number.POSITIVE_INFINITY;
  constructor(private rows: Row[]) {}
  select(_columns?: string) {
    if (this.mode === "update") this.returning = true;
    return this;
  }
  update(values: Row) {
    this.mode = "update";
    this.values = values;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((r) => r[column] === value);
    return this;
  }
  is(column: string, value: unknown) {
    this.filters.push((r) => (value === null ? r[column] === null || r[column] === undefined : r[column] === value));
    return this;
  }
  not(column: string, _op: string, _value: unknown) {
    this.filters.push((r) => r[column] !== null && r[column] !== undefined);
    return this;
  }
  in(column: string, list: unknown[]) {
    this.filters.push((r) => list.includes(r[column]));
    return this;
  }
  lt(column: string, value: string) {
    this.filters.push((r) => typeof r[column] === "string" && (r[column] as string) < value);
    return this;
  }
  or(expression: string) {
    const before = /claimed_until\.lt\.(.+)$/.exec(expression)?.[1] ?? "";
    this.filters.push((r) => r.claimed_until === null || r.claimed_until === undefined || (r.claimed_until as string) < before);
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.sortKey = column;
    this.ascending = options?.ascending !== false;
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  then<A, B>(resolve?: ((v: { data: unknown; error: { message: string; code?: string } | null }) => A) | null, reject?: ((e: unknown) => B) | null) {
    try {
      return Promise.resolve(resolve ? resolve(this.run()) : (this.run() as unknown as A));
    } catch (e) {
      return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
    }
  }
  private run(): { data: unknown; error: { message: string; code?: string } | null } {
    let hits = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") {
      // the database's "one open domain per host" (domain_orders_open_host)
      if (typeof this.values.status === "string" && OPEN.includes(this.values.status)) {
        for (const r of hits) {
          if (this.rows.some((o) => o !== r && o.hostname === r.hostname && OPEN.includes(String(o.status)))) {
            return { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } };
          }
        }
      }
      // ... and one open website per host (domain_orders_open_site_host)
      const site = this.values.site_host;
      if (typeof site === "string" && hits.some((r) => this.rows.some((o) => o !== r && o.site_host === site && WORK.concat("live").includes(String(o.status))))) {
        return { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } };
      }
      for (const r of hits) Object.assign(r, this.values);
      return { data: this.returning ? hits.map((r) => ({ ...r })) : null, error: null };
    }
    if (this.sortKey) {
      const k = this.sortKey;
      hits = [...hits].sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : 1) * (this.ascending ? 1 : -1));
    }
    hits = hits.slice(0, this.max);
    if (this.single) return { data: hits[0] ? { ...hits[0] } : null, error: null };
    return { data: hits.map((r) => ({ ...r })), error: null };
  }
}

function fakeDb(w: World): SupabaseClient {
  const tables: Record<string, Row[]> = {
    domain_orders: w.orders, shops: w.shops, domain_settings: w.settings, domain_prices: w.prices, subscriptions: w.subscriptions,
  };
  const find = (id: unknown) => w.orders.find((o) => o.id === id);
  const ok = (data: unknown) => Promise.resolve({ data, error: null });
  const rpc = (name: string, a: Row) => {
    switch (name) {
      case "domain_log": {
        const o = find(a.p_id);
        if (o) {
          (o.log as Row[]).push({ at: isoAt(w), step: a.p_step, ok: a.p_ok, detail: a.p_detail });
          if (!a.p_ok) o.last_error = a.p_detail ?? a.p_step;
        }
        return ok(null);
      }
      case "domain_claim": {
        const due = w.orders.filter((o) => WORK.includes(String(o.status))
          && (o.next_attempt_at === null || (o.next_attempt_at as string) <= isoAt(w))
          && (o.claimed_until === null || (o.claimed_until as string) < isoAt(w))).slice(0, Number(a.p_limit ?? 10));
        for (const o of due) o.claimed_until = isoAt(w, 180_000);
        return ok(due.map((o) => o.id));
      }
      case "domain_claim_one": {
        const o = find(a.p_id);
        if (!o || !WORK.includes(String(o.status)) || (o.claimed_until !== null && (o.claimed_until as string) >= isoAt(w))) return ok(false);
        o.claimed_until = isoAt(w, 180_000);
        return ok(true);
      }
      case "domain_set_credit": {
        const s = w.settings[0];
        const alert = Number(a.p_credit) < Number(s.low_credit_eur)
          && (s.credit_alert_at === null || (s.credit_alert_at as string) < isoAt(w, -86_400_000));
        s.credit_eur = a.p_credit;
        if (alert) s.credit_alert_at = isoAt(w);
        return ok(alert);
      }
      case "domain_owner_details":
        return ok({ ...w.owner });
      case "domain_quote": {
        if (w.orders.some((o) => o.shop_id === a.p_shop_id && OPEN.includes(String(o.status)))) {
          return Promise.resolve({ data: null, error: { message: "The shop already has a domain", code: "55000" } });
        }
        const tld = String(a.p_hostname).split(".").slice(1).join(".");
        const price = w.prices.find((p) => p.tld === tld && p.active);
        if (!price) return Promise.resolve({ data: null, error: { message: "TLD not sold", code: "P0002" } });
        for (let i = w.orders.length - 1; i >= 0; i--) if (w.orders[i].shop_id === a.p_shop_id && w.orders[i].status === "quoted") w.orders.splice(i, 1);
        const o = newOrder(w, { shop_id: a.p_shop_id, hostname: a.p_hostname, price_cents: price.price_cents, renewal_cents: price.renewal_cents, vat_included: price.vat_included, site_url: a.p_site_url, test_mode: a.p_test_mode });
        return ok({ id: o.id, price_cents: o.price_cents, renewal_cents: o.renewal_cents, vat_included: o.vat_included, currency: "EUR" });
      }
      case "domain_connect_start": {
        if (!w.plan.has(String(a.p_shop_id))) return Promise.resolve({ data: null, error: { message: "Pro plan required", code: "55000" } });
        if (w.orders.some((o) => o.hostname === a.p_hostname && OPEN.includes(String(o.status)))) {
          return Promise.resolve({ data: null, error: { message: "used", code: "23505" } });
        }
        const o = newOrder(w, { shop_id: a.p_shop_id, kind: "connected", hostname: a.p_hostname, site_host: a.p_hostname, www: a.p_www, status: "waiting_dns", price_cents: null, renewal_cents: null, vat_included: null, site_url: a.p_site_url, next_attempt_at: null });
        return ok(o.id);
      }
      case "domain_payment_received": {
        const o = find(a.p_id);
        if (!o) return ok("not_found");
        if (o.paid_at) {
          o.stripe_invoice = o.stripe_invoice ?? a.p_invoice;
          return ok("duplicate");
        }
        if (!["quoted", "checkout"].includes(String(o.status))) {
          Object.assign(o, { paid_at: isoAt(w), status: "canceled", stripe_payment_intent: a.p_payment_intent });
          return ok("orphan");
        }
        Object.assign(o, { status: "paid", paid_at: isoAt(w), next_attempt_at: isoAt(w), stripe_invoice: o.stripe_invoice ?? a.p_invoice, stripe_payment_intent: a.p_payment_intent ?? o.stripe_payment_intent, invoice_url: a.p_invoice_url ?? o.invoice_url });
        return ok("recorded");
      }
      case "domain_renewal_paid": {
        const o = find(a.p_id);
        if (!o || !["due", "failed"].includes(String(o.renewal_state))) return ok(false);
        Object.assign(o, { renewal_state: "paid", renewal_invoice: a.p_invoice ?? o.renewal_invoice });
        return ok(true);
      }
      case "domain_shop_emails":
        return ok(["shop@example.invalid"]);
      case "shop_has_plan":
        return ok(w.plan.has(String(a.p_shop_id)));
      case "link_stripe_customer":
        return ok(a.p_customer);
      case "assistant_cron_ok":
        return ok(a.p_secret === CRON);
    }
    throw new Error(`unexpected rpc ${name}`);
  };
  return { from: (table: string) => new Query(tables[table] ?? []), rpc } as unknown as SupabaseClient;
}

/** The owner ("Bearer owner") of SHOP, another owner, and the admin. */
function callerDb(authorization: string): SupabaseClient {
  const token = authorization.replace(/^Bearer\s+/i, "");
  const users: Record<string, { id: string; email: string }> = {
    owner: { id: "u-owner", email: "owner@example.invalid" },
    stranger: { id: "u-stranger", email: "x@example.invalid" },
    admin: { id: "u-admin", email: "admin@example.invalid" },
  };
  return {
    auth: { getUser: (t: string) => Promise.resolve({ data: { user: users[t] ?? null } }) },
    rpc: (name: string, a: Row) => {
      if (name === "is_shop_member") return Promise.resolve({ data: token === "owner" && a.p_shop_id === SHOP });
      if (name === "is_admin") return Promise.resolve({ data: token === "admin" });
      throw new Error(`unexpected caller rpc ${name}`);
    },
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------- stand-ins for Websupport, Vercel, Stripe, Brevo

function fakeRegistrar() {
  const calls: string[] = [];
  const state = {
    available: new Set(["davide.sk", "nove-meno.sk", "obchod.eu"]),
    credit: 100,
    price: 9.5,
    services: new Map<string, { id: string; expiresAt: string | null }>([["cacadoo-test.sk", { id: "svc-test", expiresAt: "2027-05-01T00:00:00.000Z" }]]),
    records: new Map<string, DnsRecord[]>(),
    authCode: "AUTH-CODE-1" as string | null,
    registerAtOnce: true,
    // Websupport's validation answer for the domain profile (its own field names), e.g. ["identCompanyRegistration"].
    profileRefuses: [] as string[],
  };
  let n = 0;
  const registrar: Registrar = {
    name: "fake",
    check: (d) => {
      calls.push(`check ${d}`);
      return Promise.resolve({ available: state.available.has(d), price: state.price });
    },
    credit: () => {
      calls.push("credit");
      return Promise.resolve(state.credit);
    },
    profile: (owner, existing) => {
      calls.push(`profile ${owner.company_name} ${existing ?? "new"}`);
      if (state.profileRefuses.length) {
        const errors = Object.fromEntries(state.profileRefuses.map((f) => [f, ["validation.not-valid"]]));
        return Promise.reject(new RegistrarError(`Websupport: creating the domain profile failed (200: ${JSON.stringify(errors)})`, 200, state.profileRefuses));
      }
      return Promise.resolve(existing ?? "501");
    },
    findService: (d) => {
      calls.push(`find ${d}`);
      return Promise.resolve(state.services.get(d) ?? null);
    },
    order: (d, profile, dry) => {
      calls.push(`order ${d} profile ${profile} ${dry ? "dry" : "real"}`);
      if (!dry) {
        state.available.delete(d);
        if (state.registerAtOnce) state.services.set(d, { id: `svc-${d}`, expiresAt: "2027-10-11T00:00:00.000Z" });
      }
      return Promise.resolve({ orderId: dry ? null : "777" });
    },
    pay: (id) => {
      calls.push(`pay ${id}`);
      return Promise.resolve();
    },
    records: (sid) => Promise.resolve([...(state.records.get(sid) ?? [])]),
    addRecord: (sid, r) => {
      calls.push(`add ${r.type} ${r.name} ${r.value}`);
      state.records.set(sid, [...(state.records.get(sid) ?? []), { id: `r${++n}`, type: r.type, name: r.name, content: r.value }]);
      return Promise.resolve();
    },
    deleteRecord: (sid, id) => {
      calls.push(`delete ${id}`);
      state.records.set(sid, (state.records.get(sid) ?? []).filter((r) => r.id !== id));
      return Promise.resolve();
    },
    autoRenew: (sid, on) => {
      calls.push(`autoRenew ${sid} ${on}`);
      return Promise.resolve();
    },
    authCode: () => Promise.resolve(state.authCode),
  };
  return { registrar, calls, state };
}

function fakeVercel() {
  const calls: string[] = [];
  const state = { ready: new Set<string>(), verification: [] as Want[] };
  const vercel: Vercel = {
    add: (host, redirect) => {
      calls.push(`add ${host}${redirect ? ` -> ${redirect}` : ""}`);
      return Promise.resolve({ verified: state.ready.has(host), verification: state.verification });
    },
    config: (host) => Promise.resolve({ misconfigured: !state.ready.has(host), ipv4: ["76.76.21.21"], cname: "cname.vercel-dns.com." }),
    verify: (host) => Promise.resolve(state.ready.has(host)),
    remove: (host) => {
      calls.push(`remove ${host}`);
      return Promise.resolve();
    },
  };
  return { vercel, calls, state };
}

function fakeStripe(opts: { card?: string | null; payFails?: boolean; renewalPaid?: boolean } = {}) {
  const calls: { method: string; path: string; params: Params; key?: string }[] = [];
  // A Stripe error for the next call to this path (e.g. a price of the other mode, a missing tax address).
  const fail = new Map<string, string>();
  const stripe = ((method: string, path: string, params: Params = {}, key?: string) => {
    calls.push({ method, path, params, key });
    const r = (v: unknown) => Promise.resolve(v);
    const failure = fail.get(path);
    if (failure) {
      fail.delete(path);
      return Promise.reject(new StripeError(`Stripe 400: ${failure}`, 400, "resource_missing"));
    }
    if (method === "DELETE") return r({ deleted: true });
    if (path === "/prices/price_pro") return r({ unit_amount: 2900, currency: "eur", recurring: { interval: "month", interval_count: 1 }, tax_behavior: "inclusive" });
    if (path.startsWith("/prices/")) return r({ product: "prod_domain" });
    if (path === "/customers") return r({ id: "cus_new" });
    if (path.startsWith("/customers/")) return r({ invoice_settings: { default_payment_method: opts.card ?? null } });
    if (path.startsWith("/subscriptions/")) return r({ default_payment_method: null });
    if (path === "/invoices" && method === "POST") return r({ id: "in_1", status: "draft" });
    if (path === "/invoiceitems") return r({ id: "ii_1" });
    if (path.endsWith("/finalize")) return r({ id: "in_1", status: "open", hosted_invoice_url: "https://invoice.stripe.com/i/in_1" });
    if (path.endsWith("/pay")) {
      if (opts.payFails) return Promise.reject(new StripeError("Stripe 402: This payment requires additional user action", 402, "invoice_payment_intent_requires_action"));
      return r({ id: "in_1", status: "paid", hosted_invoice_url: "https://invoice.stripe.com/i/in_1" });
    }
    if (path === "/checkout/sessions") return r({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
    if (path.startsWith("/checkout/sessions/")) return r({ payment_intent: null, invoice: "in_9" });
    if (path.endsWith("/void")) return r({});
    if (path.startsWith("/invoices/") && method === "GET") {
      return r({
        id: "in_9", status: opts.renewalPaid ? "paid" : "open",
        payments: { data: [{ payment: { payment_intent: "pi_9" } }] },
        lines: { data: [{ amount: 900, metadata: {} }, { amount: 1990, metadata: {} }] },
      });
    }
    if (path === "/refunds") return r({ id: "re_1" });
    if (path.endsWith("/expire")) return r({ status: "expired" });
    return Promise.reject(new Error(`unexpected Stripe call ${method} ${path}`));
  }) as Stripe;
  return { stripe, calls, fail };
}

function fakeFetch(w: World): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.brevo.com/")) {
      const b = JSON.parse(String(init?.body));
      w.mails.push({ to: b.to.map((t: { email: string }) => t.email), subject: b.subject, text: b.textContent, html: b.htmlContent });
      return Promise.resolve(new Response("{}", { status: 201 }));
    }
    if (w.https.has(new URL(url).hostname)) return Promise.resolve(new Response(null, { status: 200 }));
    return Promise.reject(new TypeError("TLS handshake failed"));
  }) as typeof fetch;
}

function setup(o: { mode?: "test" | "live"; card?: string | null; payFails?: boolean; renewalPaid?: boolean; email?: boolean } = {}) {
  const w = world();
  const reg = fakeRegistrar();
  const ver = fakeVercel();
  const st = fakeStripe({ card: o.card === undefined ? "pm_card" : o.card, payFails: o.payFails, renewalPaid: o.renewalPaid });
  const mode = o.mode ?? "live";
  const deps: Deps = {
    db: fakeDb(w),
    asCaller: (authorization) => callerDb(authorization),
    registrar: mode === "test" ? testRegistrar(reg.registrar) : reg.registrar,
    vercel: ver.vercel,
    stripe: st.stripe,
    prices: { pro: "price_pro", domain: "price_domain" },
    mode,
    email: o.email === false ? null : { apiKey: "brevo-key", from: "ppi@example.invalid" },
    adminEmail: "admin@example.invalid",
    serviceKey: SERVICE,
    fetch: fakeFetch(w),
    now: () => w.now,
    background: (task) => {
      w.background.push(task);
    },
  };
  return { w, deps, reg, ver, st };
}

async function post(deps: Deps, body: Record<string, unknown>, auth = "Bearer owner", headers: Record<string, string> = {}) {
  const res = await handle(new Request("https://p.supabase.co/functions/v1/domains", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), deps);
  return [res.status, await res.json()] as [number, Record<string, unknown>];
}

const settle = async (w: World) => {
  while (w.background.length) await w.background.shift();
};
const orderOf = (w: World, id: unknown) => w.orders.find((o) => o.id === id)!;

// ---------------------------------------------------------------- names

Deno.test("Pasted names are cleaned; the website cleans them the same way", () => {
  const cases: [string, string][] = [
    ["https://www.Davide.sk/", "davide.sk"],
    ["  WWW.davide.SK  ", "davide.sk"],
    ["http://davide.sk:8080/kontakt?x=1#y", "davide.sk"],
    ["davide.sk.", "davide.sk"],
    ["www.www.davide.sk", "davide.sk"],
    ["Dávide.sk", "dávide.sk"],
    ["davide", "davide"],
    ["", ""],
  ];
  for (const [input, expected] of cases) {
    eq(cleanDomain(input), expected, `clean ${input}`);
    eq(site.cleanDomain(input), expected, `website: clean ${input}`);
  }
  const problems: [string, string | null][] = [
    ["davide.sk", null],
    ["moj-obchod.eu", null],
    ["davide", "no_tld"],
    ["", "empty"],
    ["dávide.sk", "accents"],
    ["-davide.sk", "format"],
    ["davide-.sk", "format"],
    ["da_vide.sk", "format"],
    ["davide.123", "format"],
    [`${"a".repeat(64)}.sk`, "format"],
  ];
  for (const [name, expected] of problems) {
    eq(nameProblem(name), expected, `problem ${name}`);
    eq(site.nameProblem(name), expected, `website: problem ${name}`);
  }
  const tlds = ["sk", "eu", "co.uk"];
  for (const [name, expected] of [["davide.sk", "sk"], ["obchod.co.uk", "co.uk"], ["shop.davide.sk", null], ["davide.de", null]] as [string, string | null][]) {
    eq(soldTld(name, tlds), expected, `tld ${name}`);
    eq(site.soldTld(name, tlds), expected, `website: tld ${name}`);
  }
});

// ---------------------------------------------------------------- Websupport

Deno.test("Websupport: the signature of a known example, the Date header, a dry-run order", async () => {
  // Computed independently: hex HMAC-SHA1("GET /v1/user/self 1700000000", "ws-secret-123").
  eq(await wsSignature("ws-secret-123", "GET", "/v1/user/self", 1700000000), "521332f72470b3b74e2dfbcfdd752b09300ec805", "signature");
  eq(wsDate(1700000000), "20231114T221320Z", "Date header: ISO 8601 basic, GMT");

  const seen: { url: string; init: RequestInit }[] = [];
  const f = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    const url = String(input);
    if (url.includes("/validate/domain")) {
      const domain = JSON.parse(String(init?.body)).domain;
      return Promise.resolve(domain === "davide.sk"
        ? Response.json({ status: "success", item: { price: { price: 9.5 } } })
        : Response.json({ status: "error", errors: { domain: ["Doména nie je voľná"] } }, { status: 400 }));
    }
    if (url.includes("/order")) return Promise.resolve(Response.json({ status: "success", item: { id: 4242 } }));
    if (url.endsWith("/v1/user/self")) return Promise.resolve(Response.json({ id: 42, credit: 57.3 }));
    return Promise.resolve(Response.json({}, { status: 404 }));
  }) as typeof fetch;
  const ws = websupport({ apiKey: "ws-key", secret: "ws-secret-123", userId: "42" }, f, () => 1700000000 * 1000);

  eq(await ws.check("davide.sk"), { available: true, price: 9.5 }, "free, with Websupport's own price");
  eq((await ws.check("google.sk")).available, false, "taken");
  eq(await ws.credit(), 57.3, "the credit");

  const placed = await ws.order("davide.sk", "501", true);
  eq(placed.orderId, "4242", "the order id");
  const call = seen[seen.length - 1];
  eq(call.url, "https://rest.websupport.sk/v1/user/42/order?dry_run=1", "dry run: a query parameter");
  const headers = call.init.headers as Record<string, string>;
  const [key, signature] = atob(headers.Authorization.replace("Basic ", "")).split(":");
  eq(key, "ws-key", "API key as the user name");
  eq(signature, "150014b9296e6b250676e4406bbed6e012add55c", "the signed path has no query (independently computed)");
  eq([headers.Date, headers["Content-Type"], headers.Accept, headers["Accept-Language"]], ["20231114T221320Z", "application/json", "application/json", "sk"], "headers");
  eq(JSON.parse(String(call.init.body)), { services: [{ type: "domain", domain: "davide.sk", domainProfileId: 501 }] }, "registered for the shop's profile");

  const unauthorized = websupport({ apiKey: "k", secret: "s", userId: "42" }, (() => Promise.resolve(Response.json({ message: "Unauthorized" }, { status: 401 }))) as typeof fetch);
  let threw = false;
  try {
    await unauthorized.check("davide.sk");
  } catch {
    threw = true;
  }
  assert(threw, "a login problem is an error, never \"taken\"");
});

Deno.test("Websupport: the registrant is the shop (its company profile), test mode buys nothing", async () => {
  const profile = websupportProfile({
    company_name: "Potraviny Centrum s.r.o.", contact_name: "Ján Peter Novák", street: "Hlavná 1", city: "Košice", zip: "040 01",
    country: "SK", ico: "123 456 78", dic: "2020123456", ic_dph: "SK2020123456", email: "info@example.invalid", phone: "+421 900 123 456",
  });
  eq(profile, {
    firstName: "Ján Peter", lastName: "Novák", orgName: "Potraviny Centrum s.r.o.", street: "Hlavná 1", city: "Košice", zip: "040 01",
    country: "SK", email: "info@example.invalid", phone: "+421900123456", identCompanyRegistration: "12345678", identVat: "SK2020123456",
  }, "the shop's own company, never Cacadoo");

  const { registrar, calls } = fakeRegistrar();
  const test = testRegistrar(registrar);
  await test.order("davide.sk", "501", false);
  await test.pay("777");
  await test.autoRenew("svc", true);
  eq(calls, ["order davide.sk profile 501 dry"], "test mode: a dry run only, no payment, no renewal switch");
});

// ---------------------------------------------------------------- Vercel and DNS

Deno.test("A Slovak IČO is checked (mod 11) on the website and in the function the same way", () => {
  for (const [ico, ok] of [
    ["35763469", true], ["31322832", true], ["12345679", true], [" 357 634 69 ", true],
    ["12345678", false], ["1234567", false], ["123456789", false], ["abc12345", false], ["", false],
  ] as [string, boolean][]) {
    eq(validSkIco(ico), ok, `function: IČO ${ico}`);
    eq(site.validSkIco(ico), ok, `website: IČO ${ico}`);
  }
});

Deno.test("Websupport refuses the owner's details: the shop corrects them (e-mail once), nothing refunded, then it goes on", async () => {
  const { w, deps, reg } = setup({ mode: "test" });
  const o = newOrder(w, { status: "paid", paid_at: isoAt(w), next_attempt_at: isoAt(w), test_mode: true });
  reg.state.profileRefuses = ["country", "identCompanyRegistration"];
  await tick(deps);
  eq([o.status, o.needs_admin, o.attempts, o.refunded_at], ["registering", true, 0, null], "waits for the correction, no try counted");
  assert(String(o.last_error).startsWith(`${OWNER_REFUSED}country, ico`), String(o.last_error));
  eq(w.mails.filter((m) => m.subject === "Opravte údaje majiteľa domény davide.sk").length, 1, "the shop is told");
  assert(w.mails[0].text.includes("krajina, IČO"), w.mails[0].text);
  w.now += 6 * 3_600_000 + 1000;
  await tick(deps);
  eq(w.mails.filter((m) => m.subject.startsWith("Opravte")).length, 1, "once, not every 6 hours");
  // corrected on the page → "Skontrolovať" runs it again at once
  reg.state.profileRefuses = [];
  w.now += 60_000;
  await post(deps, { action: "recheck", order_id: o.id });
  eq(o.status, "configuring", "registered (dry run) and on to the website");
});

Deno.test("Pay: a Slovak IČO that is not valid is refused before anything is paid", async () => {
  const { w, deps, st } = setup();
  w.owner = { ...w.owner, ico: "12345678" };
  const [, free] = await post(deps, { action: "check", shop_id: SHOP, domain: "davide.sk", return_url: RETURN });
  eq((await post(deps, { action: "pay", order_id: free.order_id, return_url: RETURN, lang: "sk", accept_terms: true }))[1], { error: "owner_ico" }, "IČO first");
  eq(st.calls.filter((c) => c.method === "POST").length, 0, "nothing at Stripe");
});

Deno.test("DNS: only the records Vercel asked for; mail (MX, SPF, DKIM, DMARC) is never touched", () => {
  const verification = verificationRecords("davide.sk", [{ type: "TXT", domain: "_vercel.davide.sk", value: "vc-domain-verify=davide.sk,abc", reason: "pending" }]);
  eq(verification, [{ type: "TXT", name: "_vercel", value: "vc-domain-verify=davide.sk,abc" }], "the challenge, relative to the domain");
  const wanted = websiteRecords("davide.sk", true, { ipv4: ["76.76.21.21"], cname: "cname.vercel-dns.com." }, verification);
  eq(wanted.map((w) => `${w.type} ${w.name} ${w.value}`), [
    "A @ 76.76.21.21", "CNAME www cname.vercel-dns.com.", "TXT _vercel vc-domain-verify=davide.sk,abc",
  ], "built from Vercel's answer only");
  eq(websiteRecords("shop.example.com", false, { ipv4: ["76.76.21.21"], cname: "cname.vercel-dns.com." }, []), [
    { type: "CNAME", name: "shop", value: "cname.vercel-dns.com." },
  ], "a subdomain: one CNAME");

  const existing: DnsRecord[] = [
    { id: "1", type: "A", name: "@", content: "37.9.175.10" },
    { id: "2", type: "AAAA", name: "", content: "2a00:4b40::1" },
    { id: "3", type: "CNAME", name: "www", content: "davide.sk" },
    { id: "4", type: "MX", name: "@", content: "mail.websupport.sk" },
    { id: "5", type: "TXT", name: "@", content: "v=spf1 include:spf.websupport.sk ~all" },
    { id: "6", type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none" },
    { id: "7", type: "TXT", name: "default._domainkey", content: "v=DKIM1; k=rsa; p=MIIB" },
    { id: "8", type: "A", name: "mail", content: "37.9.175.11" },
    { id: "9", type: "A", name: "davide.sk.", content: "76.76.21.21" },
  ];
  const plan = dnsPlan("davide.sk", existing, wanted);
  eq(plan.remove.map((r) => r.id), ["1", "2", "3"], "only the old website records of @ and www go");
  eq(plan.add.map((w) => `${w.type} ${w.name}`), ["CNAME www", "TXT _vercel"], "A @ 76.76.21.21 is there already");
  assert(!plan.remove.some((r) => ["MX", "TXT"].includes(r.type) || r.name === "mail"), "mail records stay");
});

Deno.test("Vercel: bare + www (redirect), recommended records, a team project", async () => {
  const seen: string[] = [];
  const f = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url.replace("https://api.vercel.com", "")}${init?.body ? ` ${init.body}` : ""}`);
    if (url.includes("/config")) {
      return Promise.resolve(Response.json({
        misconfigured: true,
        recommendedIPv4: [{ rank: 2, value: ["1.2.3.4"] }, { rank: 1, value: ["76.76.21.21"] }],
        recommendedCNAME: [{ rank: 1, value: "cname.vercel-dns.com." }],
      }));
    }
    if (url.includes("/v10/projects/") && init?.body && JSON.parse(String(init.body)).name === "taken.sk") {
      return Promise.resolve(Response.json({ error: { code: "domain_already_in_use" } }, { status: 409 }));
    }
    if (url.includes("/v9/projects/") && url.includes("taken.sk")) return Promise.resolve(Response.json({ name: "taken.sk", verified: false, verification: [] }));
    return Promise.resolve(Response.json({ name: "davide.sk", verified: false, verification: [{ type: "TXT", domain: "_vercel.davide.sk", value: "vc=1" }] }));
  }) as typeof fetch;
  const v = vercelApi({ token: "t", projectId: "prj_1", teamId: "team_1" }, f);
  eq((await v.add("davide.sk")).verification, [{ type: "TXT", name: "_vercel", value: "vc=1" }], "verification");
  await v.add("www.davide.sk", "davide.sk");
  eq(await v.config("davide.sk"), { misconfigured: true, ipv4: ["76.76.21.21"], cname: "cname.vercel-dns.com." }, "rank 1 first");
  await v.add("taken.sk");
  eq(seen[0], 'POST /v10/projects/prj_1/domains?teamId=team_1 {"name":"davide.sk"}', "added to the project");
  eq(seen[1], 'POST /v10/projects/prj_1/domains?teamId=team_1 {"name":"www.davide.sk","redirect":"davide.sk","redirectStatusCode":308}', "www redirects to the bare host");
  assert(seen[2].startsWith("GET /v6/domains/davide.sk/config?teamId=team_1&projectIdOrName=prj_1"), "config of the project's domain");
  assert(seen.some((s) => s.startsWith("GET /v9/projects/prj_1/domains/taken.sk")), "already in the project: read instead");
});

// ---------------------------------------------------------------- step 2: check

Deno.test("Check: format errors, a TLD not sold, taken, free with the table's price", async () => {
  const { w, deps } = setup();
  eq((await post(deps, { action: "check", shop_id: SHOP, domain: "davide", return_url: RETURN }))[1], { state: "invalid", problem: "no_tld", domain: "davide" }, "no ending");
  eq((await post(deps, { action: "check", shop_id: SHOP, domain: "davide.de", return_url: RETURN }))[1].state, "unsupported", "not in the table");
  eq((await post(deps, { action: "check", shop_id: SHOP, domain: "google.sk", return_url: RETURN }))[1].state, "taken", "taken");
  const [status, free] = await post(deps, { action: "check", shop_id: SHOP, domain: "https://www.Davide.sk/", return_url: RETURN });
  eq([status, free.state, free.domain, free.price_cents, free.vat_included], [200, "available", "davide.sk", 1990, true], "free: the table's price");
  eq(orderOf(w, free.order_id).price_cents, 1990, "the price is frozen on the order");
  eq((await post(deps, { action: "check", shop_id: SHOP, domain: "davide.sk", return_url: RETURN }, "Bearer stranger"))[0], 403, "only the shop's owners");
  eq((await post(deps, { action: "check", shop_id: SHOP, domain: "davide.sk", return_url: "https://evil.example/x" }))[0], 400, "back only to the plan page");
});

// ---------------------------------------------------------------- step 4: pay

Deno.test("Pay: one click with the saved card (exactly the price shown), recorded once, then the steps", async () => {
  const { w, deps, st, reg, ver } = setup();
  ver.state.ready.add("davide.sk"); // Vercel sees the records once they are written
  const [, free] = await post(deps, { action: "check", shop_id: SHOP, domain: "davide.sk", return_url: RETURN });
  eq((await post(deps, { action: "pay", order_id: free.order_id, return_url: RETURN, lang: "sk", accept_terms: false }))[1], { error: "terms" }, "terms first");
  const [status, paid] = await post(deps, { action: "pay", order_id: free.order_id, return_url: RETURN, lang: "sk", accept_terms: true });
  eq([status, paid], [200, { paid: true }], "paid with one click");
  const item = st.calls.find((c) => c.path === "/invoiceitems")!;
  eq([item.params.amount, item.params.tax_behavior, item.params.currency], [1990, "inclusive", "eur"], "price shown = price charged (VAT included)");
  const invoice = st.calls.find((c) => c.path === "/invoices" && c.method === "POST")!;
  eq((invoice.params.metadata as Params).ppi_domain_order, free.order_id, "the invoice knows its order");
  eq(st.calls.find((c) => c.path.endsWith("/pay"))!.params, { payment_method: "pm_card", off_session: false }, "the shop is there (3-D Secure possible)");

  await settle(w);
  const o = orderOf(w, free.order_id);
  eq(o.status, "securing", "registered and set up; waiting for HTTPS");
  eq(reg.calls.filter((c) => c.startsWith("order ")), ["order davide.sk profile 501 real"], "ordered once, for the shop's profile");
  assert(reg.calls.includes("pay 777"), "paid from our credit");
  assert(reg.calls.includes("autoRenew svc-davide.sk false"), "Websupport never renews on its own");
  assert(reg.calls.includes("add A @ 76.76.21.21") && reg.calls.includes("add CNAME www cname.vercel-dns.com."), "DNS from Vercel's answer");

  // the webhook comes too (and again): nothing is ordered twice
  eq((await post(deps, { action: "run", order_id: free.order_id }, `Bearer ${SERVICE}`))[0], 202, "the webhook's call");
  await post(deps, { action: "run", order_id: free.order_id }, `Bearer ${SERVICE}`);
  await settle(w);
  eq(reg.calls.filter((c) => c.startsWith("order ")).length, 1, "a duplicate webhook never orders twice");
  eq((await post(deps, { action: "run", order_id: free.order_id }, "Bearer wrong"))[0], 401, "only with the service key");

  // HTTPS works → live; the e-mail goes once
  w.https.add("davide.sk");
  w.now += 6 * 60_000;
  await tick(deps);
  eq(o.status, "live", "live");
  eq(w.mails.filter((m) => m.subject === "Vaša stránka beží na davide.sk").length, 1, "the e-mail once");
  const mail = w.mails.find((m) => m.subject === "Vaša stránka beží na davide.sk")!;
  assert(mail.text.includes("https://davide.sk") && mail.text.includes("https://business.google.com/"), "the link and the Google profile");
  assert(mail.text.includes("11. 10. 2027") && mail.text.includes("https://invoice.stripe.com/i/in_1"), "expiry and the invoice");
  assert(mail.text.includes("https://ppi.example/sk/dashboard/plan?shop=potraviny-centrum"), "the plan page");
  eq(mail.to, ["shop@example.invalid"], "to the shop");
  eq(await sendLiveMail(deps, o as never), false, "never twice");
  await daily(deps);
  eq(w.mails.filter((m) => m.subject.startsWith("Vaša stránka beží")).length, 1, "the daily job does not send it again");
});

Deno.test("Pay: 3-D Secure → Stripe's invoice page; no card → Checkout; no Pro → Pro and the domain together", async () => {
  {
    const { deps } = setup({ payFails: true });
    const [, free] = await post(deps, { action: "check", shop_id: SHOP, domain: "davide.sk", return_url: RETURN });
    eq((await post(deps, { action: "pay", order_id: free.order_id, return_url: RETURN, lang: "sk", accept_terms: true }))[1],
      { url: "https://invoice.stripe.com/i/in_1" }, "3-D Secure: Stripe's own page finishes it");
  }
  {
    const { w, deps, st } = setup({ card: null });
    const [, free] = await post(deps, { action: "check", shop_id: SHOP, domain: "obchod.eu", return_url: RETURN });
    const [, page] = await post(deps, { action: "pay", order_id: free.order_id, return_url: RETURN, lang: "sk", accept_terms: true });
    eq(page, { url: "https://checkout.stripe.com/c/pay/cs_1" }, "no saved card: Checkout (card, Apple Pay, Google Pay)");
    const session = st.calls.find((c) => c.path === "/checkout/sessions")!.params;
    eq(session.mode, "payment", "only the domain");
    const line = (session.line_items as Params[])[0].price_data as Params;
    eq([line.unit_amount, line.tax_behavior, line.product], [1490, "exclusive", "prod_domain"], "the table's price (VAT on top for this TLD)");
    eq(((session.invoice_creation as Params).enabled), true, "an invoice from Cacadoo");
    eq(String(session.success_url), "https://ppi.example/sk/dashboard/plan?shop=potraviny&domain=paid#domain", "back to the plan page");
    eq(orderOf(w, free.order_id).status, "checkout", "reserved while paying");
  }
  {
    const { w, deps, st } = setup({ card: null });
    w.plan.clear();
    w.subscriptions[0].status = "canceled";
    const [, free] = await post(deps, { action: "check", shop_id: SHOP, domain: "davide.sk", return_url: RETURN });
    await post(deps, { action: "pay", order_id: free.order_id, return_url: RETURN, lang: "sk", accept_terms: true, company_id_label: "IČO" });
    const session = st.calls.find((c) => c.path === "/checkout/sessions")!.params;
    eq(session.mode, "subscription", "Pro and the domain in one payment");
    eq((session.line_items as Params[]).map((l) => (l.price as string) ?? ((l.price_data as Params).unit_amount)), ["price_pro", 1990], "Pro + the domain");
    eq(orderOf(w, free.order_id).with_pro, true, "bought with Pro");
  }
  {
    const { w, deps } = setup();
    w.owner = { ...w.owner, missing: ["zip"] };
    const [, free] = await post(deps, { action: "check", shop_id: SHOP, domain: "davide.sk", return_url: RETURN });
    eq((await post(deps, { action: "pay", order_id: free.order_id, return_url: RETURN, lang: "sk", accept_terms: true }))[1], { error: "owner_details" }, "the owner's details first");
  }
  {
    const { w, deps } = setup();
    newOrder(w, { shop_id: OTHER_SHOP, hostname: "davide.sk", status: "checkout" });
    const free = newOrder(w, { hostname: "davide.sk", status: "quoted" });
    eq((await post(deps, { action: "pay", order_id: free.id, return_url: RETURN, lang: "sk", accept_terms: true }))[1], { state: "in_use" }, "another shop is paying for the same name");
  }
});

Deno.test("Pay fails at Stripe: the reason comes back, nothing stays half-made, a new try works; or the owner cancels", async () => {
  {
    const { w, deps, st } = setup();
    const [, free] = await post(deps, { action: "check", shop_id: SHOP, domain: "davide.sk", return_url: RETURN });
    st.fail.set("/invoices", "No such customer: 'cus_1'");
    const [status, body] = await post(deps, { action: "pay", order_id: free.order_id, return_url: RETURN, lang: "sk", accept_terms: true });
    eq([status, body], [502, { error: "stripe", message: "Stripe 400: No such customer: 'cus_1'" }], "the reason for the page");
    const o = orderOf(w, free.order_id);
    eq([o.status, o.attempts], ["quoted", 1], "checked again (no dead end in Čaká na platbu)");
    assert((o.log as { detail: string }[]).some((l) => /Payment page not opened: Stripe 400: No such customer/.test(l.detail ?? "")), "logged");
    // fixed: the next try opens with new keys and pays once
    const [, paid] = await post(deps, { action: "pay", order_id: free.order_id, return_url: RETURN, lang: "sk", accept_terms: true });
    eq(paid, { paid: true }, "paid on the second try");
    eq(st.calls.filter((c) => c.key?.startsWith("ppi-domain-invoice-")).map((c) => c.key), [`ppi-domain-invoice-${free.order_id}-0`, `ppi-domain-invoice-${free.order_id}-1`], "the second try with a fresh idempotency key");
  }
  {
    const { w, deps, st } = setup();
    const [, free] = await post(deps, { action: "check", shop_id: SHOP, domain: "davide.sk", return_url: RETURN });
    st.fail.set("/invoiceitems", "Customer has no valid tax location");
    eq((await post(deps, { action: "pay", order_id: free.order_id, return_url: RETURN, lang: "sk", accept_terms: true }))[0], 502, "refused");
    assert(st.calls.some((c) => c.method === "DELETE" && c.path === "/invoices/in_1"), "the draft invoice is deleted");
    eq(orderOf(w, free.order_id).stripe_invoice, null, "no invoice left on the order");
  }
  {
    const { w, deps, st } = setup({ card: null });
    const [, free] = await post(deps, { action: "check", shop_id: SHOP, domain: "davide.sk", return_url: RETURN });
    await post(deps, { action: "pay", order_id: free.order_id, return_url: RETURN, lang: "sk", accept_terms: true });
    eq(orderOf(w, free.order_id).status, "checkout", "Stripe's page is open");
    eq((await post(deps, { action: "cancel_payment", order_id: free.order_id }, "Bearer stranger"))[0], 404, "only the shop's owners");
    eq((await post(deps, { action: "cancel_payment", order_id: free.order_id }))[1], { status: "canceled" }, "the owner gives it up");
    assert(st.calls.some((c) => c.path === "/checkout/sessions/cs_1/expire"), "Stripe's page is closed");
    eq(orderOf(w, free.order_id).status, "canceled", "a new name can be checked");
    const paid = newOrder(w, { status: "paid", paid_at: isoAt(w) });
    eq((await post(deps, { action: "cancel_payment", order_id: paid.id }))[0], 409, "a paid order is never canceled here");
  }
});

// ---------------------------------------------------------------- after payment

Deno.test("Low credit: the order waits (the admin is e-mailed once), then goes on by itself", async () => {
  const { w, deps, reg, ver } = setup();
  ver.state.ready.add("davide.sk");
  reg.state.credit = 3;
  const o = newOrder(w, { status: "paid", paid_at: isoAt(w), next_attempt_at: isoAt(w) });
  await tick(deps);
  eq([o.status, o.waiting_credit], ["registering", true], "waits; the shop sees \"Registrujem doménu\"");
  eq(reg.calls.filter((c) => c.startsWith("order")).length, 0, "nothing ordered");
  eq(w.mails.filter((m) => m.subject === "Dobite kredit na Websupport").map((m) => m.to), [["admin@example.invalid"]], "the admin");
  w.now += 11 * 60_000;
  await tick(deps);
  eq(w.mails.filter((m) => m.subject === "Dobite kredit na Websupport").length, 1, "once");
  reg.state.credit = 500;
  w.now += 11 * 60_000;
  await tick(deps);
  eq([o.status, o.waiting_credit], ["securing", false], "topped up: registered and set up");
});

Deno.test("Nastavujem stránku waits until Vercel sees the records (and the admin hears after 48 hours)", async () => {
  const { w, deps, ver } = setup();
  const o = newOrder(w, { status: "paid", paid_at: isoAt(w), next_attempt_at: isoAt(w) });
  await tick(deps);
  eq(o.status, "configuring", "the DNS is written; Vercel does not see it yet");
  w.now += 49 * 3600_000;
  await tick(deps);
  eq(w.mails.filter((m) => m.subject === "DNS sa nenastavili do 48 hodín: davide.sk").length, 1, "the admin, once");
  ver.state.ready.add("davide.sk");
  w.https.add("davide.sk");
  w.now += 6 * 60_000;
  await tick(deps);
  eq(o.status, "live", "then live");
});

Deno.test("Taken after payment: the domain part is refunded, Pro stays, the shop is told", async () => {
  const { w, deps, reg, st } = setup();
  reg.state.available.delete("davide.sk");
  const o = newOrder(w, { status: "paid", paid_at: isoAt(w), next_attempt_at: isoAt(w), with_pro: true, stripe_session: "cs_1" });
  await tick(deps);
  eq(o.status, "taken", "taken");
  const refund = st.calls.find((c) => c.path === "/refunds")!;
  eq([refund.params.payment_intent, refund.params.amount, refund.key], ["pi_9", 1990, `ppi-domain-refund-${o.id}`], "only the domain's line, once");
  assert(!st.calls.some((c) => c.path.includes("/subscriptions") && c.method === "POST"), "Pro is kept");
  const mail = w.mails.find((m) => m.subject.startsWith("Doména davide.sk už nie je voľná"))!;
  assert(mail.text.includes("predplatné Pro zostáva") && mail.text.includes("Websupport.sk"), "choose another name");
  eq(reg.calls.filter((c) => c.startsWith("order")).length, 0, "nothing ordered");
});

Deno.test("Test mode: a dry run, no credit used, the website goes on the test domain", async () => {
  const { w, deps, reg, ver } = setup({ mode: "test" });
  const o = newOrder(w, { status: "paid", paid_at: isoAt(w), next_attempt_at: isoAt(w), test_mode: true });
  ver.state.ready.add("cacadoo-test.sk");
  w.https.add("cacadoo-test.sk");
  await tick(deps);
  eq([o.status, o.site_host, o.hostname], ["live", "cacadoo-test.sk", "davide.sk"], "live on the test domain");
  eq(reg.calls.filter((c) => c.startsWith("order") || c.startsWith("pay") || c === "credit"), ["order davide.sk profile 501 dry"], "a dry run only");
  assert(reg.calls.includes("add A @ 76.76.21.21"), "the test domain's DNS is set");
  const mail = w.mails.find((m) => m.subject === "Vaša stránka beží na cacadoo-test.sk")!;
  assert(mail.text.includes("Testovací režim"), "the e-mail says it was a test");

  // A second test order: checked (taken → refund) like any other, then it waits for the test domain.
  reg.state.available.add("druha.sk");
  const second = newOrder(w, { shop_id: OTHER_SHOP, hostname: "druha.sk", status: "paid", paid_at: isoAt(w), next_attempt_at: isoAt(w), test_mode: true });
  await tick(deps);
  eq([second.status, second.site_host, second.needs_admin], ["registering", null, true], "waits: one website at a time on the test domain");
  assert((second.log as { detail: string }[]).some((l) => /test domain cacadoo-test\.sk carries another shop's website/.test(l.detail ?? "")), "the reason is logged");
});

// ---------------------------------------------------------------- flow 14

Deno.test("Own domain: records from Vercel, Čaká na DNS → Overené → Beží, a reminder after 24 hours, 7 days at most", async () => {
  const { w, deps, ver } = setup();
  const [, started] = await post(deps, { action: "connect", shop_id: SHOP, domain: "https://www.moj-obchod.sk/", return_url: RETURN });
  eq(started.state, "started", "started");
  const o = orderOf(w, started.order_id);
  eq([o.status, o.www], ["waiting_dns", true], "Čaká na DNS");
  eq(ver.calls.slice(0, 2), ["add moj-obchod.sk", "add www.moj-obchod.sk -> moj-obchod.sk"], "bare + www (redirect)");
  eq((o.dns_records as Want[]).map((r) => `${r.type} ${r.name} ${r.value}`), ["A @ 76.76.21.21", "CNAME www cname.vercel-dns.com."], "the records to show");

  eq((await post(deps, { action: "recheck", order_id: o.id }))[0], 429, "Skontrolovať: not twice in 30 seconds");
  w.now += 25 * 3600_000;
  await tick(deps);
  eq(w.mails.filter((m) => m.subject === "Pripojte doménu moj-obchod.sk: chýbajú DNS záznamy").length, 1, "the 24-hour reminder");
  assert(w.mails.at(-1)!.text.includes("Neodstraňujte existujúce MX záznamy"), "with the MX warning");
  w.now += 3 * 3600_000 + 1;
  await tick(deps);
  eq(w.mails.filter((m) => m.subject.startsWith("Pripojte doménu")).length, 1, "once");

  ver.state.ready.add("moj-obchod.sk");
  w.https.add("moj-obchod.sk");
  w.now += 31_000;
  eq((await post(deps, { action: "recheck", order_id: o.id }))[1], { status: "live" }, "Skontrolovať → Overené → Beží");
  assert((o.log as { step: string }[]).some((l) => l.step === "verified"), "Overené logged");
  eq(w.mails.filter((m) => m.subject === "Vaša stránka beží na moj-obchod.sk").length, 1, "the same e-mail as a bought domain");

  // 7 days without records: stopped and removed from Vercel
  const { w: w2, deps: deps2, ver: ver2 } = setup();
  const [, s2] = await post(deps2, { action: "connect", shop_id: SHOP, domain: "pomaly.sk", return_url: RETURN });
  w2.now += 7 * 86_400_000 + 1;
  orderOf(w2, s2.order_id).next_attempt_at = isoAt(w2);
  await tick(deps2);
  eq(orderOf(w2, s2.order_id).status, "dns_timeout", "after 7 days");
  assert(ver2.calls.includes("remove pomaly.sk") && ver2.calls.includes("remove www.pomaly.sk"), "removed from Vercel");

  // Pro required; a host of another shop is refused
  const { w: w3, deps: deps3 } = setup();
  w3.plan.clear();
  eq((await post(deps3, { action: "connect", shop_id: SHOP, domain: "moj.sk", return_url: RETURN }))[1].state, "no_plan", "Pro only");
  w3.plan.add(SHOP);
  newOrder(w3, { shop_id: OTHER_SHOP, kind: "connected", hostname: "cudzi.sk", status: "live" });
  eq((await post(deps3, { action: "connect", shop_id: SHOP, domain: "cudzi.sk", return_url: RETURN }))[1].state, "in_use", "another shop's domain");
  eq((await post(deps3, { action: "connect", shop_id: SHOP, domain: "ppi.example", return_url: RETURN }))[1].state, "invalid", "never PPI's own address");
});

Deno.test("Own domain at Websupport in our account: the records are written for the shop", async () => {
  const { w, deps, reg } = setup();
  reg.state.services.set("nasa-domena.sk", { id: "svc-nasa", expiresAt: null });
  reg.state.records.set("svc-nasa", [
    { id: "m1", type: "MX", name: "@", content: "mail.websupport.sk" },
    { id: "a1", type: "A", name: "@", content: "37.9.175.10" },
  ]);
  const [, started] = await post(deps, { action: "connect", shop_id: SHOP, domain: "nasa-domena.sk", return_url: RETURN });
  assert(reg.calls.includes("delete a1") && reg.calls.includes("add A @ 76.76.21.21"), "the website record replaced");
  assert(!reg.calls.includes("delete m1"), "MX stays");
  eq(orderOf(w, started.order_id).registrar_service_id, "svc-nasa", "found in our account");
});

// ---------------------------------------------------------------- renewal and the end

Deno.test("Renewal: charged 30 days before; Websupport renews from credit only after the shop paid; else lapsed", async () => {
  {
    const { w, deps, reg, st } = setup();
    const o = newOrder(w, { status: "live", live_at: isoAt(w), live_email_at: isoAt(w), expires_at: isoAt(w, 20 * 86_400_000), registrar_service_id: "svc-davide.sk", site_host: "davide.sk" });
    await daily(deps);
    eq(o.renewal_state, "paid", "paid from the saved card");
    assert(reg.calls.includes("autoRenew svc-davide.sk true"), "only now may Websupport renew");
    const item = st.calls.find((c) => c.path === "/invoiceitems")!;
    eq(item.params.amount, 1990, "the renewal price");
    eq(st.calls.find((c) => c.path.endsWith("/pay"))!.params.off_session, true, "charged without the shop");
    assert(w.mails.some((m) => m.subject.startsWith("Doména davide.sk sa obnoví")), "told");
  }
  {
    const { w, deps, reg, ver } = setup({ payFails: true });
    const o = newOrder(w, { status: "live", live_email_at: isoAt(w), expires_at: isoAt(w, 20 * 86_400_000), registrar_service_id: "svc-davide.sk", site_host: "davide.sk" });
    await daily(deps);
    eq([o.renewal_state, o.renewal_invoice_url], ["failed", "https://invoice.stripe.com/i/in_1"], "failed: a payment link");
    assert(!reg.calls.includes("autoRenew svc-davide.sk true"), "not renewed without payment");
    assert(w.mails.some((m) => m.subject === "Platba za obnovu domény davide.sk sa nepodarila"), "the shop is told");
    w.now += 7 * 86_400_000;
    await daily(deps);
    eq(w.mails.filter((m) => m.subject.startsWith("Pripomienka: zaplaťte obnovu domény")).length, 1, "weekly reminder");
    w.now += 14 * 86_400_000;
    await daily(deps);
    eq(o.status, "lapsed", "at expiry: lapsed");
    assert(ver.calls.includes("remove davide.sk"), "the website goes back to its Cacadoo address");
  }
});

Deno.test("Pro ended: the website goes back; a bought domain stays the shop's (auth code, never held back)", async () => {
  const { w, deps, reg, ver } = setup();
  const o = newOrder(w, { status: "live", live_email_at: isoAt(w), expires_at: isoAt(w, 200 * 86_400_000), registrar_service_id: "svc-davide.sk", site_host: "davide.sk" });
  w.plan.clear();
  await daily(deps);
  eq([o.status, o.auth_code], ["ended", "AUTH-CODE-1"], "ended, with the transfer code");
  assert(reg.calls.includes("autoRenew svc-davide.sk false"), "never renewed for nothing");
  assert(ver.calls.includes("remove davide.sk"), "off the project");
  const mail = w.mails.find((m) => m.subject === "Doména davide.sk zostáva vaša")!;
  assert(mail.text.includes("AUTH-CODE-1") && mail.text.includes("prevod"), "the code and how to transfer");
});

// ---------------------------------------------------------------- Google Search Console (update 33)

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcd";
const VALUE = `google-site-verification=${TOKEN}`;

Deno.test("Search Console: only the pasted TXT value \"google-site-verification=…\" is accepted", () => {
  eq(googleVerification(`google-site-verification=${TOKEN}`), `google-site-verification=${TOKEN}`, "the whole value");
  eq(googleVerification(`  "google-site-verification=${TOKEN}"  `), `google-site-verification=${TOKEN}`, "with quotes");
  eq(googleVerification(`\u201egoogle-site-verification = ${TOKEN}\u201c`), `google-site-verification=${TOKEN}`, "Slovak quotes, spaces");
  eq(googleVerification(TOKEN), null, "the token alone is not the TXT value");
  eq(googleVerification(`google-site-verification:${TOKEN}`), null, "another separator");
  eq(googleVerification(`msvalidate.01=${"A".repeat(32)}`), null, "Bing's code");
  eq(googleVerification("google-site-verification=short"), null, "too short");
  eq(googleVerification(`<meta name="google-site-verification" content="${TOKEN}" />`), null, "an HTML tag is not the TXT value");
  eq(googleVerification("v=spf1 include:spf.websupport.sk ~all"), null, "another TXT record");
  eq(googleVerification(`google-site-verification=${TOKEN}\nv=spf1 -all`), null, "two lines");
  eq(googleVerification(null), null, "nothing");
  eq([manualRecordName("davide.sk"), manualRecordName("eshop.davide.sk"), manualRecordName("a.b.davide.sk")], ["@", "eshop", "a.b"], "record names");
  for (const host of ["davide.sk", "eshop.davide.sk", "a.b.davide.sk"]) eq(site.recordName(host), manualRecordName(host), `the page shows the same name for ${host}`);
});

Deno.test("Search Console: a bought domain gets the TXT record added; MX, SPF, DMARC and the rest stay untouched", async () => {
  const { w, deps, reg } = setup();
  const o = newOrder(w, { status: "live", site_host: "davide.sk", registrar_service_id: "svc-davide.sk" });
  const before: DnsRecord[] = [
    { id: "a1", type: "A", name: "@", content: "76.76.21.21" },
    { id: "m1", type: "MX", name: "@", content: "mail.websupport.sk" },
    { id: "t1", type: "TXT", name: "@", content: "v=spf1 include:spf.websupport.sk ~all" },
    { id: "t2", type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none" },
    { id: "t3", type: "TXT", name: "default._domainkey", content: "v=DKIM1; k=rsa; p=MIGf" },
  ];
  reg.state.records.set("svc-davide.sk", [...before]);
  const [status, body] = await post(deps, { action: "google_verify", order_id: o.id, value: `google-site-verification=${TOKEN}` });
  eq([status, body.state, body.host], [200, "added", "davide.sk"], "added");
  eq(body.record, { type: "TXT", name: "@", value: `google-site-verification=${TOKEN}` }, "the record shown");
  eq(reg.calls.filter((c) => c.startsWith("add ") || c.startsWith("delete ")), [`add TXT @ google-site-verification=${TOKEN}`], "one record added, nothing removed");
  const after = reg.state.records.get("svc-davide.sk")!;
  for (const r of before) assert(after.some((x) => x.id === r.id && x.content === r.content), `${r.type} ${r.name} untouched`);
  eq([o.google_verification, o.google_verification_state], [`google-site-verification=${TOKEN}`, "added"], "remembered");
  eq(o.google_txt_record_id, after.find((r) => r.content === VALUE)!.id, "the id of the record we added");
  assert((o.log as { step: string }[]).some((l) => l.step === "google"), "logged");

  // the same value again (Websupport may keep it in quotes): never a second record
  reg.state.records.set("svc-davide.sk", after.map((r) => (r.content.startsWith("google") ? { ...r, content: `"${r.content}"` } : r)));
  w.now += 60_000;
  const [, again] = await post(deps, { action: "google_verify", order_id: o.id, value: VALUE });
  eq(again.state, "added", "still added");
  eq(reg.calls.filter((c) => c.startsWith("add ")).length, 1, "not added twice");

  // at most a few Search Console values on one domain
  const many = Array.from({ length: MAX_GOOGLE_RECORDS }, (_, i) => ({ id: `g${i}`, type: "TXT", name: "@", content: `google-site-verification=${TOKEN.slice(0, -1)}${i}` }));
  reg.state.records.set("svc-davide.sk", [...before, ...many]);
  w.now += 60_000;
  const [, full] = await post(deps, { action: "google_verify", order_id: o.id, value: `google-site-verification=${"z".repeat(43)}` });
  eq(full.state, "too_many", "refused, nothing added");
  eq(reg.calls.filter((c) => c.startsWith("add ")).length, 1, "nothing more added");
});

Deno.test("Search Console: an own domain elsewhere gets the record to add by hand; only owners, only live, not too often", async () => {
  const { w, deps, reg } = setup();
  const o = newOrder(w, { kind: "connected", hostname: "eshop.mojobchod.sk", site_host: "eshop.mojobchod.sk", status: "live", price_cents: null, renewal_cents: null, vat_included: null });
  const [, body] = await post(deps, { action: "google_verify", order_id: o.id, value: VALUE });
  eq([body.state, body.host], ["manual", "eshop.mojobchod.sk"], "to add by hand");
  eq(body.record, { type: "TXT", name: "eshop", value: `google-site-verification=${TOKEN}` }, "the record to add");
  eq(reg.calls.filter((c) => c.startsWith("add ")), [], "no DNS change of a domain we do not run");
  eq(o.google_verification_state, "manual", "remembered");

  const [soon] = await post(deps, { action: "google_verify", order_id: o.id, value: VALUE });
  eq(soon, 429, "not again within 10 seconds");
  w.now += 60_000;
  const [, bad] = await post(deps, { action: "google_verify", order_id: o.id, value: "<meta name=x>" });
  eq(bad.state, "invalid", "a wrong value");
  eq(o.google_verification, `google-site-verification=${TOKEN}`, "a wrong value keeps the old one");
  const [stranger] = await post(deps, { action: "google_verify", order_id: o.id, value: VALUE }, "Bearer stranger");
  eq(stranger, 404, "another shop's owner");
  const [nobody] = await post(deps, { action: "google_verify", order_id: o.id, value: VALUE }, "");
  eq(nobody, 401, "no login");
  o.status = "waiting_dns";
  const [notLive] = await post(deps, { action: "google_verify", order_id: o.id, value: VALUE });
  eq(notLive, 409, "only a live domain");
});

Deno.test("Search Console: the same value already in the DNS is not added, and Odstrániť never removes it", async () => {
  const { w, deps, reg } = setup();
  const o = newOrder(w, { status: "live", site_host: "davide.sk", registrar_service_id: "svc-davide.sk" });
  const before: DnsRecord[] = [
    { id: "m1", type: "MX", name: "@", content: "mail.websupport.sk" },
    { id: "t1", type: "TXT", name: "@", content: "v=spf1 include:spf.websupport.sk ~all" },
    { id: "t2", type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none" },
    { id: "g9", type: "TXT", name: "davide.sk.", content: `"${VALUE}"` },
  ];
  reg.state.records.set("svc-davide.sk", [...before]);
  const [, body] = await post(deps, { action: "google_verify", order_id: o.id, value: VALUE });
  eq(body.state, "present", "already in the DNS");
  eq(reg.calls.filter((c) => c.startsWith("add ") || c.startsWith("delete ")), [], "nothing added, nothing removed");
  eq([o.google_verification_state, o.google_txt_record_id], ["present", null], "not ours");

  w.now += 60_000;
  const [status, removed] = await post(deps, { action: "google_remove", order_id: o.id });
  eq([status, removed], [200, { state: "removed", dns: false }], "forgotten, the DNS not changed");
  eq(reg.calls.filter((c) => c.startsWith("delete ")), [], "the record that was there stays");
  eq(reg.state.records.get("svc-davide.sk"), before, "every record as it was");
  eq([o.google_verification, o.google_verification_state, o.google_txt_record_id], [null, null, null], "the stored value gone");
});

Deno.test("Search Console: Odstrániť removes only the record Cacadoo added; a new value replaces only ours", async () => {
  const { w, deps, reg } = setup();
  const o = newOrder(w, { status: "live", site_host: "davide.sk", registrar_service_id: "svc-davide.sk" });
  const other = `google-site-verification=${"Q".repeat(43)}`;
  const before: DnsRecord[] = [
    { id: "a1", type: "A", name: "@", content: "76.76.21.21" },
    { id: "m1", type: "MX", name: "@", content: "mail.websupport.sk" },
    { id: "t1", type: "TXT", name: "@", content: "v=spf1 include:spf.websupport.sk ~all" },
    { id: "t2", type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none" },
    { id: "t3", type: "TXT", name: "default._domainkey", content: "v=DKIM1; k=rsa; p=MIGf" },
    { id: "g1", type: "TXT", name: "@", content: other },
    { id: "g2", type: "TXT", name: "shop", content: VALUE },
  ];
  reg.state.records.set("svc-davide.sk", [...before]);
  await post(deps, { action: "google_verify", order_id: o.id, value: VALUE });
  const ours = o.google_txt_record_id as string;
  assert(ours && !before.some((r) => r.id === ours), "a new record of ours (the same value under another name is not the domain's)");

  // a new value: the new record first, then only our earlier one goes
  w.now += 60_000;
  const second = `google-site-verification=${"R".repeat(43)}`;
  const [, replaced] = await post(deps, { action: "google_verify", order_id: o.id, value: second });
  eq(replaced.state, "added", "added");
  eq(reg.calls.filter((c) => c.startsWith("add ") || c.startsWith("delete ")), [`add TXT @ ${VALUE}`, `add TXT @ ${second}`, `delete ${ours}`], "new first, then only ours");
  const secondId = o.google_txt_record_id as string;
  assert(secondId && secondId !== ours, "the new record's id");

  // Odstrániť: only our record; SPF, MX, DMARC, DKIM, the A record and the other Google value stay
  w.now += 60_000;
  const [status, removed] = await post(deps, { action: "google_remove", order_id: o.id });
  eq([status, removed], [200, { state: "removed", dns: true }], "removed");
  eq(reg.calls.filter((c) => c.startsWith("delete ")), [`delete ${ours}`, `delete ${secondId}`], "only our records were ever removed");
  eq(reg.state.records.get("svc-davide.sk"), before, "every other record exactly as it was");
  eq([o.google_verification, o.google_verification_state, o.google_txt_record_id], [null, null, null], "forgotten");
  assert((o.log as { step: string; detail: string }[]).some((l) => l.step === "google" && /removed from DNS/.test(l.detail)), "logged");

  // our record changed by someone in the DNS → no longer ours: never removed
  w.now += 60_000;
  await post(deps, { action: "google_verify", order_id: o.id, value: VALUE });
  const third = o.google_txt_record_id as string;
  reg.state.records.set("svc-davide.sk", reg.state.records.get("svc-davide.sk")!.map((r) => (r.id === third ? { ...r, content: other } : r)));
  w.now += 60_000;
  const deletes = reg.calls.filter((c) => c.startsWith("delete ")).length;
  const [, changed] = await post(deps, { action: "google_remove", order_id: o.id });
  eq(changed.dns, false, "a record that is no longer our value is left alone");
  eq(reg.calls.filter((c) => c.startsWith("delete ")).length, deletes, "nothing removed");

  // only the shop's owner
  w.now += 60_000;
  await post(deps, { action: "google_verify", order_id: o.id, value: VALUE });
  eq((await post(deps, { action: "google_remove", order_id: o.id }, "Bearer stranger"))[0], 404, "another shop's owner");
  eq((await post(deps, { action: "google_remove", order_id: o.id }, ""))[0], 401, "no login");
  assert(o.google_verification, "still there");
});

Deno.test("Callers: cron secret, owners only for their shop, admin actions only for the admin", async () => {
  const { w, deps } = setup();
  eq((await post(deps, { action: "tick" }, "", { "x-ppi-cron": "wrong" }))[0], 401, "a wrong cron secret");
  eq((await post(deps, { action: "tick" }, "", { "x-ppi-cron": CRON }))[1], { done: 0 }, "the tick");
  eq((await post(deps, { action: "check", shop_id: SHOP, domain: "x.sk", return_url: RETURN }, ""))[0], 401, "no login");
  const o = newOrder(w, { status: "live", site_host: "davide.sk", live_email_at: isoAt(w) });
  eq((await post(deps, { action: "admin_email", order_id: o.id }))[0], 403, "an owner is not the admin");
  eq((await post(deps, { action: "admin_email", order_id: o.id }, "Bearer admin"))[1], { sent: true }, "the admin resends the e-mail");
  eq((await post(deps, { action: "admin_save_auth_code", order_id: o.id, auth_code: "XYZ-1" }, "Bearer admin"))[1], { saved: true }, "the admin saves a code");
  eq(o.auth_code, "XYZ-1", "kept for the shop");
  eq((await post(deps, { action: "auth_code", order_id: o.id }, "Bearer stranger"))[0], 404, "never another shop's code");
  eq((await post(deps, { action: "pro_price", shop_id: SHOP }))[1], { cents: 2900, currency: "EUR", interval: "month", interval_count: 1, vat_included: true }, "the Pro price from Stripe");
  eq((await post(deps, { action: "pro_price", shop_id: SHOP }, "Bearer stranger"))[0], 403, "owners only");
});
