/// <reference lib="deno.ns" />
// PPI · domains Edge Function (database update 25)
//
// A shop with Pro gets its website on its own domain:
//   13 "Kúpiť doménu": the shop finds a free name on websupport.sk, pastes it, pays once
//      (Stripe); then this function registers it at Websupport IN THE SHOP'S NAME (a domain
//      profile with the shop's company details), pays Websupport from our prepaid credit,
//      adds it to the Vercel project, writes the DNS records Vercel asks for and goes live.
//   14 "Už mám vlastnú doménu": the shop's own domain is added to Vercel; the shop gets the
//      exact DNS records; checks every few hours for 7 days (automatic when the domain is
//      in our Websupport account).
// Live: "Vaša stránka beží na <doména>" e-mail once; renewal from our credit only after the
// shop's Stripe renewal succeeded; never a domain held back (auth code on cancellation).
//
// Who calls it:
//   - the website with the owner's login: check, pay, cancel_payment, connect, recheck, disconnect, auth_code, pro_price
//   - the website with the admin's login: admin_retry, admin_email, admin_auth_code,
//     admin_save_auth_code, admin_credit
//   - stripe-webhook (service role key): run (a payment was confirmed)
//   - pg_cron (x-ppi-cron): tick every 5 minutes, daily once a day
// Registrars sit behind the Registrar interface (Websupport now; another can be added).
// REGISTRAR_MODE=test (the default): every Websupport order is a dry run, nothing is paid
// from the credit, and the website is set up on the admin's test domain instead.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "domains" →
// paste this file → Deploy, then switch OFF "Verify JWT" (it checks its callers itself).
// Secrets: WEBSUPPORT_API_KEY, WEBSUPPORT_API_SECRET, WEBSUPPORT_USER_ID, REGISTRAR_MODE,
// VERCEL_API_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID (only for a team project),
// STRIPE_SECRET_KEY, STRIPE_PRICE_PRO, STRIPE_PRICE_DOMAIN, BREVO_API_KEY, ALERT_EMAIL_FROM,
// ADMIN_EMAIL. Nothing of a key, a signature, a token or a card is ever logged.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

/** The Stripe API version these calls are written for (the same as stripe-checkout). */
export const STRIPE_VERSION = "2026-09-30.endive";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANGS = ["sk", "hu", "en"] as const;
type Lang = (typeof LANGS)[number];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Statuses the work loop moves on. */
const WORK = ["paid", "registering", "configuring", "securing", "waiting_dns", "verified"];
/** A shop's open domain (one at a time). */
const OPEN = ["checkout", ...WORK, "live"];
/** Subscriptions that still bill: the shop is on Pro (shop_has_plan decides access). */
const LIVE_PLAN = ["trialing", "active", "past_due", "unpaid", "paused"];
const TICK_BUDGET_MS = 90_000;

// ---------------------------------------------------------------- domain names

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** "https://www.Davide.sk/" → "davide.sk": spaces, case, scheme, www., port, path, query, dot. */
export function cleanDomain(input: string): string {
  let name = String(input ?? "").trim().toLowerCase();
  name = name.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  name = name.replace(/^[^/@]*@/, "");
  name = name.split(/[/?#\\]/)[0];
  name = name.replace(/:\d*$/, "");
  name = name.replace(/\s+/g, "");
  name = name.replace(/\.+$/, "");
  while (name.startsWith("www.")) name = name.slice(4);
  return name;
}

export type NameProblem = "empty" | "no_tld" | "format" | "accents";

/** Letters, digits and hyphens, a dot before the ending ("davide.sk"); null when fine. */
export function nameProblem(name: string): NameProblem | null {
  if (!name) return "empty";
  if (/[^\x00-\x7f]/.test(name)) return "accents";
  const labels = name.split(".");
  if (labels.length < 2) return "no_tld";
  if (name.length > 253 || !labels.every((l) => LABEL.test(l))) return "format";
  if (/^[0-9-]+$/.test(labels[labels.length - 1])) return "format";
  return null;
}

/** The TLD of the price table a name ends with (longest first), only one label before it. */
export function soldTld(name: string, tlds: string[]): string | null {
  const sorted = [...tlds].sort((a, b) => b.length - a.length);
  for (const tld of sorted) {
    if (!name.endsWith(`.${tld}`)) continue;
    const rest = name.slice(0, -tld.length - 1);
    return rest && !rest.includes(".") ? tld : null;
  }
  return null;
}

/** bare + www for a registrable name (two labels); a subdomain gets one host. */
export const isApex = (name: string) => name.split(".").length === 2;

// ---------------------------------------------------------------- registrars

export interface Registrant {
  company_name: string;
  contact_name: string;
  street: string;
  city: string;
  zip: string;
  country: string;
  ico: string;
  dic: string | null;
  ic_dph: string | null;
  email: string;
  phone: string;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
}

export interface Want {
  type: "A" | "CNAME" | "TXT";
  /** "@" for the domain itself, "www", "_vercel"… */
  name: string;
  value: string;
}

export interface Registrar {
  readonly name: string;
  /** Free to register? `price` is the registrar's own price (only to check the credit; never shown). */
  check(domain: string): Promise<{ available: boolean; price: number | null }>;
  /** Prepaid credit (EUR). */
  credit(): Promise<number>;
  /** The registrant profile with the shop's details (updated when it exists) → its id. */
  profile(owner: Registrant, existing: string | null): Promise<string>;
  /** The domain as a service in our account (registered), or null. */
  findService(domain: string): Promise<{ id: string; expiresAt: string | null } | null>;
  /** Orders the domain for the registrant; dryRun: checked only, nothing bought. */
  order(domain: string, profileId: string, dryRun: boolean): Promise<{ orderId: string | null }>;
  /** Pays the order from the prepaid credit. */
  pay(orderId: string): Promise<void>;
  records(serviceId: string): Promise<DnsRecord[]>;
  addRecord(serviceId: string, record: Want): Promise<void>;
  deleteRecord(serviceId: string, recordId: string): Promise<void>;
  autoRenew(serviceId: string, on: boolean): Promise<void>;
  /** The transfer (auth) code, when the registrar gives it through its API. */
  authCode(serviceId: string): Promise<string | null>;
}

export class RegistrarError extends Error {
  /** The fields the registrar refused (its own names, e.g. "identCompanyRegistration"). */
  constructor(message: string, readonly status: number, readonly fields: string[] = []) {
    super(message);
  }
}

/** Websupport's profile fields → the owner's details on the page (step 3). */
const OWNER_FIELD_OF: Record<string, string> = {
  firstName: "contact_name",
  lastName: "contact_name",
  orgName: "company_name",
  street: "street",
  city: "city",
  zip: "zip",
  country: "country",
  email: "email",
  phone: "phone",
  identCompanyRegistration: "ico",
  identVat: "ic_dph",
};
export const OWNER_REFUSED = "Owner details refused by Websupport: ";
export function refusedOwnerFields(e: unknown): string[] {
  if (!(e instanceof RegistrarError)) return [];
  return [...new Set(e.fields.map((f) => OWNER_FIELD_OF[f]).filter(Boolean))];
}

/** A Slovak company ID (IČO): 8 digits (older ones 6, with leading zeros), the last one a mod-11 check digit. */
export function validSkIco(value: string): boolean {
  const digits = String(value ?? "").replace(/\s+/g, "");
  if (!/^\d{6,8}$/.test(digits)) return false;
  const n = digits.padStart(8, "0");
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(n[i]) * (8 - i);
  return (11 - (sum % 11)) % 10 === Number(n[7]);
}

/** Websupport's Date header: ISO 8601 basic, GMT ("20261011T143005Z"). */
export function wsDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** hex HMAC-SHA1 of "{METHOD} {path} {unix time}" with the API secret (the query is not signed). */
export async function wsSignature(secret: string, method: string, path: string, unixSeconds: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${method} ${path} ${unixSeconds}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Json = Record<string, unknown>;
type Fetch = typeof fetch;

/** First, Last from "Ján Novák" (the last word is the surname). */
export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return { firstName: parts[0] ?? "", lastName: parts[0] ?? "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

/** The domain profile Websupport keeps for the registrant (the shop's company). */
export function websupportProfile(owner: Registrant): Json {
  const { firstName, lastName } = splitName(owner.contact_name);
  return {
    firstName,
    lastName,
    orgName: owner.company_name,
    street: owner.street,
    city: owner.city,
    zip: owner.zip,
    country: owner.country.toUpperCase(),
    email: owner.email,
    phone: owner.phone.startsWith("+") ? `+${owner.phone.replace(/\D/g, "")}` : owner.phone.replace(/[^\d+]/g, ""),
    identCompanyRegistration: owner.ico.replace(/\s+/g, ""),
    ...(owner.ic_dph ? { identVat: owner.ic_dph.replace(/\s+/g, "") } : {}),
  };
}

const numberIn = (...values: unknown[]): number | null => {
  for (const v of values) {
    const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : Number.NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const itemsOf = (data: unknown): Json[] =>
  Array.isArray(data) ? (data as Json[]) : Array.isArray((data as Json)?.items) ? ((data as Json).items as Json[]) : Array.isArray((data as Json)?.data) ? ((data as Json).data as Json[]) : [];

/** Websupport REST API (v1 orders/users/services, v2 DNS). */
export function websupport(
  env: { apiKey: string; secret: string; userId: string; base?: string },
  f: Fetch = fetch,
  now: () => number = Date.now,
): Registrar {
  const base = (env.base || "https://rest.websupport.sk").replace(/\/+$/, "");
  // The market of the account (websupport.sk → "sk"), for prices and validation.
  const market = /websupport\.(sk|cz|hu|se)$/.exec(new URL(base).hostname)?.[1] ?? "sk";
  const user = encodeURIComponent(env.userId);

  async function call(method: string, path: string, body?: unknown, query = ""): Promise<{ status: number; data: Json }> {
    const time = Math.floor(now() / 1000);
    const signature = await wsSignature(env.secret, method, path, time);
    const res = await f(`${base}${path}${query}`, {
      method,
      headers: {
        Authorization: `Basic ${btoa(`${env.apiKey}:${signature}`)}`,
        Date: wsDate(time),
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": "sk",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    let data: Json = {};
    try {
      data = text ? (JSON.parse(text) as Json) : {};
    } catch {
      data = { message: text.slice(0, 200) };
    }
    return { status: res.status, data };
  }
  const why = (data: Json) => {
    const errors = data.errors && typeof data.errors === "object" ? JSON.stringify(data.errors) : "";
    return String(data.message ?? data.title ?? errors ?? "").slice(0, 200) || "no reason given";
  };
  const must = (r: { status: number; data: Json }, what: string) => {
    if (r.status >= 200 && r.status < 300 && r.data.status !== "error") return r.data;
    const fields = r.data.errors && typeof r.data.errors === "object" && !Array.isArray(r.data.errors) ? Object.keys(r.data.errors as Json) : [];
    throw new RegistrarError(`Websupport: ${what} failed (${r.status}: ${why(r.data)})`, r.status, fields);
  };

  return {
    name: "websupport",
    async check(domain) {
      const r = await call("POST", `/v1/order/${market}/validate/domain`, { domain });
      if (r.status >= 500 || r.status === 401 || r.status === 403 || r.status === 429) {
        throw new RegistrarError(`Websupport: availability check failed (${r.status}: ${why(r.data)})`, r.status);
      }
      const item = (r.data.item ?? r.data) as Json;
      const available = r.status >= 200 && r.status < 300 && r.data.status !== "error" && item.available !== false;
      const price = numberIn((item.price as Json)?.price, (item.price as Json)?.priceWithVat, item.price, r.data.price);
      return { available, price };
    },
    async credit() {
      const data = must(await call("GET", "/v1/user/self"), "reading the credit");
      const value = numberIn((data.item as Json)?.credit, data.credit);
      if (value === null) throw new RegistrarError("Websupport: the credit is not in the answer", 200);
      return value;
    },
    async profile(owner, existing) {
      const body = websupportProfile(owner);
      if (existing) {
        const r = await call("PUT", `/v1/user/${user}/domainProfile/${encodeURIComponent(existing)}`, body);
        if (r.status >= 200 && r.status < 300 && r.data.status !== "error") return existing;
        if (r.status !== 404) must(r, "updating the domain profile");
      }
      const data = must(await call("POST", `/v1/user/${user}/domainProfile`, body), "creating the domain profile");
      const id = (data.item as Json)?.id ?? data.id;
      if (id === undefined || id === null) throw new RegistrarError("Websupport: the domain profile has no id", 200);
      return String(id);
    },
    async findService(domain) {
      const data = must(await call("GET", `/v1/user/${user}/service`), "listing services");
      const match = itemsOf(data).find((s) => String(s.name ?? s.serviceName ?? s.domain ?? "").toLowerCase() === domain);
      if (!match || match.id === undefined) return null;
      const expire = match.expireTime ?? match.expiresAt ?? match.expireDate;
      const expiresAt =
        typeof expire === "number" ? new Date(expire * 1000).toISOString() : typeof expire === "string" ? new Date(expire).toISOString() : null;
      return { id: String(match.id), expiresAt };
    },
    async order(domain, profileId, dryRun) {
      const body = {
        services: [{ type: "domain", domain, domainProfileId: /^\d+$/.test(profileId) ? Number(profileId) : profileId }],
      };
      const data = must(await call("POST", `/v1/user/${user}/order`, body, `?dry_run=${dryRun ? 1 : 0}`), dryRun ? "test order" : "ordering");
      const id = (data.item as Json)?.id ?? data.id ?? (data.order as Json)?.id;
      return { orderId: id === undefined || id === null ? null : String(id) };
    },
    async pay(orderId) {
      const r = await call("PUT", `/v1/user/${user}/order/${encodeURIComponent(orderId)}/pay/byCredit`);
      must(r, "paying from the credit");
      if (r.data.status === false) throw new RegistrarError("Websupport: paying from the credit was refused", r.status);
    },
    async records(serviceId) {
      const out: DnsRecord[] = [];
      for (let page = 1; page <= 20; page++) {
        const data = must(await call("GET", `/v2/service/${encodeURIComponent(serviceId)}/dns/record`, undefined, `?page=${page}&rowsPerPage=100`), "reading DNS");
        for (const r of itemsOf(data)) {
          out.push({ id: String(r.id), type: String(r.type), name: String(r.name ?? ""), content: String(r.content ?? ""), ttl: Number(r.ttl) || undefined });
        }
        const total = Number(data.totalPages ?? 1);
        if (!Number.isFinite(total) || page >= total) break;
      }
      return out;
    },
    async addRecord(serviceId, record) {
      must(await call("POST", `/v2/service/${encodeURIComponent(serviceId)}/dns/record`, {
        type: record.type,
        name: record.name,
        content: record.value,
        ttl: 600,
      }), `adding the ${record.type} record ${record.name}`);
    },
    async deleteRecord(serviceId, recordId) {
      must(await call("DELETE", `/v2/service/${encodeURIComponent(serviceId)}/dns/record/${encodeURIComponent(recordId)}`), "removing a DNS record");
    },
    async autoRenew(serviceId, on) {
      must(await call("PUT", `/v1/user/${user}/service/${encodeURIComponent(serviceId)}`, { autoExtend: on }), "setting the renewal");
    },
    async authCode(serviceId) {
      const data = must(await call("GET", `/v1/user/${user}/service/${encodeURIComponent(serviceId)}`), "reading the domain");
      const item = (data.item ?? data) as Json;
      for (const key of ["authCode", "authInfo", "eppCode", "transferCode", "authcode"]) {
        if (typeof item[key] === "string" && item[key]) return String(item[key]);
      }
      return null;
    },
  };
}

/**
 * REGISTRAR_MODE=test: checks and dry-run orders are real (they buy nothing), the credit is
 * never used, the renewal switch is left alone and no auth code is read.
 */
export function testRegistrar(real: Registrar): Registrar {
  return {
    ...real,
    name: `${real.name} (test)`,
    order: (domain, profileId) => real.order(domain, profileId, true),
    pay: () => Promise.resolve(),
    autoRenew: () => Promise.resolve(),
    authCode: () => Promise.resolve(null),
  };
}

// ---------------------------------------------------------------- Vercel

export interface Vercel {
  /** Adds a host to the project (a second call for the same host is fine). */
  add(host: string, redirectTo?: string): Promise<{ verified: boolean; verification: Want[] }>;
  /** The records Vercel recommends for this host, and whether DNS points at Vercel. */
  config(host: string): Promise<{ misconfigured: boolean; ipv4: string[]; cname: string | null }>;
  verify(host: string): Promise<boolean>;
  remove(host: string): Promise<void>;
}

/** Vercel's verification challenge ("_vercel.davide.sk" TXT) → a record relative to the domain. */
export function verificationRecords(host: string, verification: unknown): Want[] {
  if (!Array.isArray(verification)) return [];
  return verification
    .filter((v) => String((v as Json).type ?? "").toUpperCase() === "TXT" && (v as Json).value)
    .map((v) => {
      const full = String((v as Json).domain ?? `_vercel.${host}`).toLowerCase().replace(/\.$/, "");
      const name = full === host ? "@" : full.endsWith(`.${host}`) ? full.slice(0, -host.length - 1) : full;
      return { type: "TXT" as const, name, value: String((v as Json).value) };
    });
}

export function vercelApi(env: { token: string; projectId: string; teamId?: string | null; base?: string }, f: Fetch = fetch): Vercel {
  const base = (env.base || "https://api.vercel.com").replace(/\/+$/, "");
  const team = env.teamId ? `teamId=${encodeURIComponent(env.teamId)}` : "";
  const q = (extra = "") => {
    const parts = [team, extra].filter(Boolean).join("&");
    return parts ? `?${parts}` : "";
  };
  const project = encodeURIComponent(env.projectId);
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Json }> {
    const res = await f(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${env.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Json;
    return { status: res.status, data };
  }
  const fail = (r: { status: number; data: Json }, what: string): never => {
    const e = r.data.error as Json | undefined;
    throw new Error(`Vercel: ${what} failed (${r.status}: ${String(e?.code ?? "")} ${String(e?.message ?? "").slice(0, 160)})`);
  };
  return {
    async add(host, redirectTo) {
      let r = await call("POST", `/v10/projects/${project}/domains${q()}`, {
        name: host,
        ...(redirectTo ? { redirect: redirectTo, redirectStatusCode: 308 } : {}),
      });
      if (r.status === 409) r = await call("GET", `/v9/projects/${project}/domains/${encodeURIComponent(host)}${q()}`);
      if (r.status < 200 || r.status >= 300) fail(r, `adding ${host}`);
      return { verified: r.data.verified === true, verification: verificationRecords(host, r.data.verification) };
    },
    async config(host) {
      const r = await call("GET", `/v6/domains/${encodeURIComponent(host)}/config${q(`projectIdOrName=${project}`)}`);
      if (r.status < 200 || r.status >= 300) fail(r, `reading the DNS of ${host}`);
      const ranked = (list: unknown) =>
        Array.isArray(list) ? [...(list as Json[])].sort((a, b) => Number(a.rank ?? 99) - Number(b.rank ?? 99)) : [];
      const v4 = ranked(r.data.recommendedIPv4)[0]?.value;
      const cname = ranked(r.data.recommendedCNAME)[0]?.value;
      return {
        misconfigured: r.data.misconfigured !== false,
        ipv4: Array.isArray(v4) ? v4.map(String) : typeof v4 === "string" ? [v4] : [],
        cname: typeof cname === "string" ? cname : null,
      };
    },
    async verify(host) {
      const r = await call("POST", `/v9/projects/${project}/domains/${encodeURIComponent(host)}/verify${q()}`);
      if (r.status >= 200 && r.status < 300) return r.data.verified === true;
      if (r.status === 400 || r.status === 409) return false;
      return fail(r, `verifying ${host}`);
    },
    async remove(host) {
      const r = await call("DELETE", `/v9/projects/${project}/domains/${encodeURIComponent(host)}${q()}`);
      if (r.status !== 404 && (r.status < 200 || r.status >= 300)) fail(r, `removing ${host}`);
    },
  };
}

// ---------------------------------------------------------------- DNS

/** The records the website needs, only from Vercel's answer (never an IP of our own). */
export function websiteRecords(host: string, www: boolean, config: { ipv4: string[]; cname: string | null }, verification: Want[]): Want[] {
  const out: Want[] = [];
  if (isApex(host)) {
    for (const ip of config.ipv4) out.push({ type: "A", name: "@", value: ip });
    if (www && config.cname) out.push({ type: "CNAME", name: "www", value: config.cname });
  } else if (config.cname) {
    out.push({ type: "CNAME", name: host.split(".")[0], value: config.cname });
  }
  return [...out, ...verification];
}

const WEBSITE_TYPES = ["A", "AAAA", "CNAME", "ANAME", "ALIAS"];
const bareName = (name: string, host: string) => {
  const n = name.toLowerCase().replace(/\.$/, "");
  return n === "" || n === "@" || n === host ? "@" : n.endsWith(`.${host}`) ? n.slice(0, -host.length - 1) : n;
};
const sameValue = (a: string, b: string) => a.toLowerCase().replace(/\.$/, "") === b.toLowerCase().replace(/\.$/, "");

/**
 * What to change in the zone: only the website records (A/AAAA/CNAME/ALIAS) of exactly the
 * names Vercel needs ("@", "www") are replaced, and the verification TXT is added. MX, SPF,
 * DKIM, DMARC, every other TXT and every other name are never touched.
 */
export function dnsPlan(host: string, existing: DnsRecord[], wanted: Want[]): { add: Want[]; remove: DnsRecord[] } {
  const websiteNames = new Set(wanted.filter((w) => w.type !== "TXT").map((w) => w.name));
  const remove = existing.filter((r) => {
    const name = bareName(r.name, host);
    if (!websiteNames.has(name) || !WEBSITE_TYPES.includes(r.type.toUpperCase())) return false;
    return !wanted.some((w) => w.type === r.type.toUpperCase() && w.name === name && sameValue(w.value, r.content));
  });
  const add = wanted.filter(
    (w) => !existing.some((r) => r.type.toUpperCase() === w.type && bareName(r.name, host) === w.name && sameValue(w.value, r.content)),
  );
  return { add, remove };
}

async function applyDns(registrar: Registrar, serviceId: string, host: string, wanted: Want[]): Promise<string> {
  const plan = dnsPlan(host, await registrar.records(serviceId), wanted);
  for (const r of plan.remove) await registrar.deleteRecord(serviceId, r.id);
  for (const w of plan.add) await registrar.addRecord(serviceId, w);
  return `DNS: ${plan.add.length} added, ${plan.remove.length} website records replaced`;
}

// ---------------------------------------------------------------- Stripe

type Value = string | number | boolean | null | undefined | Params | Value[];
export interface Params {
  [key: string]: Value;
}

/** Stripe's form encoding: {a: {b: [{c: 1}]}} → "a[b][0][c]=1". Empty values are left out. */
export function toForm(params: Params): URLSearchParams {
  const form = new URLSearchParams();
  const add = (name: string, value: Value) => {
    if (value === null || value === undefined || value === "") return;
    if (Array.isArray(value)) value.forEach((item, i) => add(`${name}[${i}]`, item));
    else if (typeof value === "object") for (const [key, inner] of Object.entries(value)) add(`${name}[${key}]`, inner);
    else form.append(name, String(value));
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return form;
}

export class StripeError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
  }
}

export type Stripe = <T>(method: "GET" | "POST" | "DELETE", path: string, params?: Params, idempotencyKey?: string) => Promise<T>;

export function stripeApi(secretKey: string, f: Fetch = fetch, base = "https://api.stripe.com"): Stripe {
  return async <T>(method: "GET" | "POST" | "DELETE", path: string, params: Params = {}, idempotencyKey?: string) => {
    const form = toForm(params).toString();
    const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}`, "Stripe-Version": STRIPE_VERSION };
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await f(`${base}/v1${path}${method === "GET" && form ? `?${form}` : ""}`, {
      method,
      headers,
      body: method === "POST" ? form : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new StripeError(`Stripe ${res.status}: ${data?.error?.message ?? res.statusText}`, res.status, data?.error?.code ?? null);
    }
    return data as T;
  };
}

type Ref = string | { id: string } | null | undefined;
const idOf = (ref: Ref) => (typeof ref === "string" ? ref : ref?.id ?? null);

interface Invoice {
  id: string;
  status?: string;
  hosted_invoice_url?: string | null;
  payment_intent?: Ref;
  payments?: { data?: { payment?: { payment_intent?: Ref } | null }[] };
  lines?: { data?: { amount?: number; metadata?: Record<string, string> | null; taxes?: { amount?: number }[] }[] };
}

/** The product of STRIPE_PRICE_DOMAIN (name, tax code); the amount always comes from the price table. */
const productCache = new Map<string, string>();
async function domainProduct(stripe: Stripe, priceId: string): Promise<string> {
  const known = productCache.get(priceId);
  if (known) return known;
  const price = await stripe<{ product: Ref }>("GET", `/prices/${encodeURIComponent(priceId)}`);
  const product = idOf(price.product);
  if (!product) throw new Error("STRIPE_PRICE_DOMAIN has no product");
  productCache.set(priceId, product);
  return product;
}

/** The card the shop already pays Pro with (the customer's or the subscription's default). */
async function savedCard(stripe: Stripe, customer: string, subscription: string | null): Promise<string | null> {
  const c = await stripe<{ invoice_settings?: { default_payment_method?: Ref } | null }>("GET", `/customers/${encodeURIComponent(customer)}`);
  const fromCustomer = idOf(c.invoice_settings?.default_payment_method);
  if (fromCustomer) return fromCustomer;
  if (!subscription) return null;
  const s = await stripe<{ default_payment_method?: Ref }>("GET", `/subscriptions/${encodeURIComponent(subscription)}`);
  return idOf(s.default_payment_method);
}

/** The payment of an invoice (newer API versions list it under payments). */
async function invoicePaymentIntent(stripe: Stripe, invoiceId: string): Promise<{ intent: string | null; invoice: Invoice }> {
  const invoice = await stripe<Invoice>("GET", `/invoices/${encodeURIComponent(invoiceId)}`, { expand: ["payments"] });
  const fromPayments = (invoice.payments?.data ?? []).map((p) => idOf(p.payment?.payment_intent)).find(Boolean) ?? null;
  return { intent: fromPayments ?? idOf(invoice.payment_intent), invoice };
}

const taxBehavior = (vatIncluded: boolean | null) => (vatIncluded === false ? "exclusive" : "inclusive");

// ---------------------------------------------------------------- data

export interface Order {
  id: string;
  shop_id: string;
  kind: "bought" | "connected";
  hostname: string;
  site_host: string | null;
  www: boolean;
  status: string;
  price_cents: number | null;
  renewal_cents: number | null;
  vat_included: boolean | null;
  currency: string;
  with_pro: boolean;
  site_url: string | null;
  stripe_session: string | null;
  stripe_invoice: string | null;
  stripe_payment_intent: string | null;
  invoice_url: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  registrar_profile_id: string | null;
  registrar_order_id: string | null;
  registrar_service_id: string | null;
  registrar_paid_at: string | null;
  test_mode: boolean;
  waiting_credit: boolean;
  dns_records: Want[] | null;
  vercel_added_at: string | null;
  checks: number;
  attempts: number;
  live_at: string | null;
  live_email_at: string | null;
  dns_reminder_at: string | null;
  stuck_alert_at: string | null;
  failure_alert_at: string | null;
  expires_at: string | null;
  renewal_state: "none" | "due" | "paid" | "failed";
  renewal_invoice: string | null;
  renewal_invoice_url: string | null;
  renewal_paid_until: string | null;
  notice_30_at: string | null;
  notice_7_at: string | null;
  renewal_reminder_at: string | null;
  auth_code: string | null;
  needs_admin: boolean;
  last_error: string | null;
  last_check_at: string | null;
  created_at: string;
}

export interface Deps {
  /** Service role: moves orders; never exposed. */
  db: SupabaseClient;
  /** The caller's own login (owner or admin): is_shop_member() / is_admin() and RLS decide. */
  asCaller: (authorization: string) => SupabaseClient;
  registrar: Registrar | null;
  vercel: Vercel | null;
  stripe: Stripe | null;
  prices: { pro: string | null; domain: string | null };
  mode: "test" | "live";
  email: { apiKey: string; from: string } | null;
  adminEmail: string | null;
  serviceKey: string;
  fetch: Fetch;
  now: () => number;
  background: (task: Promise<unknown>) => void;
}

async function load(deps: Deps, id: string): Promise<Order | null> {
  const { data } = await deps.db.from("domain_orders").select("*").eq("id", id).maybeSingle();
  return (data as Order | null) ?? null;
}

async function patch(deps: Deps, id: string, values: Record<string, unknown>): Promise<void> {
  const { error } = await deps.db.from("domain_orders").update({ ...values, updated_at: new Date(deps.now()).toISOString() }).eq("id", id);
  if (error) throw new Error(`database: ${error.message}`);
}

async function log(deps: Deps, id: string, step: string, ok: boolean, detail: string | null = null) {
  await deps.db.rpc("domain_log", { p_id: id, p_step: step, p_ok: ok, p_detail: detail ? detail.slice(0, 400) : null });
}

const iso = (deps: Deps, plus = 0) => new Date(deps.now() + plus).toISOString();
const failText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

interface ShopInfo {
  id: string;
  slug: string;
  name: string;
  timezone: string;
}

async function shopOf(deps: Deps, shopId: string): Promise<ShopInfo | null> {
  const { data } = await deps.db.from("shops").select("id, slug, name, timezone").eq("id", shopId).maybeSingle();
  return (data as ShopInfo | null) ?? null;
}

async function settingsOf(deps: Deps): Promise<{ test_domain: string | null; search_url: string; same_price_as_registrar: boolean }> {
  const { data } = await deps.db.from("domain_settings").select("test_domain, search_url, same_price_as_registrar").maybeSingle();
  return (data as { test_domain: string | null; search_url: string; same_price_as_registrar: boolean } | null) ?? {
    test_domain: null,
    search_url: "https://www.websupport.sk",
    same_price_as_registrar: false,
  };
}

// ---------------------------------------------------------------- e-mails (Brevo)

const money = (cents: number | null) =>
  cents === null ? "" : `${(cents / 100).toLocaleString("sk-SK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const dateIn = (isoTime: string | null, timeZone: string) =>
  isoTime ? new Intl.DateTimeFormat("sk-SK", { timeZone, day: "numeric", month: "numeric", year: "numeric" }).format(new Date(isoTime)) : "";
/** "Predplatné a doména" of this shop on the website the shop used. */
const planPage = (o: Order, shop: ShopInfo) => `${(o.site_url ?? "").replace(/\/+$/, "")}/sk/dashboard/plan?shop=${encodeURIComponent(shop.slug)}`;
export const GOOGLE_PROFILE_URL = "https://business.google.com/";

export interface Mail {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

async function send(deps: Deps, mail: Mail): Promise<boolean> {
  if (!mail.to.length) return false;
  if (!deps.email) {
    console.error("domains: e-mail not sent (BREVO_API_KEY or ALERT_EMAIL_FROM missing):", mail.subject.slice(0, 80));
    return false;
  }
  const res = await deps.fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": deps.email.apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      sender: { name: "Cacadoo PPI", email: deps.email.from },
      to: mail.to.map((email) => ({ email })),
      subject: mail.subject,
      textContent: mail.text,
      ...(mail.html ? { htmlContent: mail.html } : {}),
    }),
  }).catch(() => null);
  if (!res?.ok) console.error("domains: e-mail failed", res?.status ?? "network");
  return Boolean(res?.ok);
}

async function shopMail(deps: Deps, shopId: string): Promise<string[]> {
  const { data } = await deps.db.rpc("domain_shop_emails", { p_shop_id: shopId });
  return Array.isArray(data) ? (data as string[]).filter(Boolean) : [];
}

async function adminMail(deps: Deps, subject: string, text: string) {
  if (!deps.adminEmail) {
    console.error("domains: admin e-mail not sent (ADMIN_EMAIL missing):", subject.slice(0, 80));
    return false;
  }
  return await send(deps, { to: [deps.adminEmail], subject, text });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** "Vaša stránka beží na <doména>": link, Google profile in 3 steps, expiry, the page, the invoice. */
export function liveMail(o: Order, shop: ShopInfo, to: string[]): Mail {
  const host = o.site_host ?? o.hostname;
  const url = `https://${host}`;
  const steps = [
    "1. Otvorte svoj Google profil firmy (tlačidlo vyššie).",
    "2. Kliknite na Upraviť profil → Kontakt → Webstránka.",
    `3. Vložte ${url} a uložte.`,
  ];
  const lines = [
    `Dobrý deň,`,
    ``,
    `stránka obchodu ${shop.name} beží na vlastnej doméne:`,
    url,
    ``,
    `Vložte ju do Google profilu firmy (${GOOGLE_PROFILE_URL}):`,
    ...steps,
    ``,
    ...(o.kind === "bought" && o.expires_at ? [`Doména je zaregistrovaná na vašu firmu do ${dateIn(o.expires_at, shop.timezone)}.`] : []),
    ...(o.test_mode ? [`(Testovací režim: doména ${o.hostname} sa nekúpila, stránka beží na testovacej doméne.)`] : []),
    `Predplatné a doména: ${planPage(o, shop)}`,
    ...(o.invoice_url ? [`Faktúra: ${o.invoice_url}`] : []),
    ``,
    `Cacadoo PPI`,
  ];
  const a = (href: string, text: string) =>
    `<a href="${escapeHtml(href)}" style="color:#000;text-decoration:underline">${escapeHtml(text)}</a>`;
  const button = (href: string, text: string) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;border:1px solid #000;padding:10px 16px;color:#000;text-decoration:none;font-weight:600">${escapeHtml(text)}</a>`;
  const html = [
    `<div style="font-family:Arial,sans-serif;color:#000;max-width:560px">`,
    `<p>Dobrý deň,</p>`,
    `<p>stránka obchodu ${escapeHtml(shop.name)} beží na vlastnej doméne:</p>`,
    `<p style="font-size:20px;font-weight:600">${a(url, url)}</p>`,
    `<p>${button(GOOGLE_PROFILE_URL, "Vložiť do Google profilu")}</p>`,
    `<ol style="padding-left:20px">`,
    `<li>Otvorte svoj Google profil firmy (tlačidlo vyššie).</li>`,
    `<li>Kliknite na Upraviť profil → Kontakt → Webstránka.</li>`,
    `<li>Vložte ${escapeHtml(url)} a uložte.</li>`,
    `</ol>`,
    o.kind === "bought" && o.expires_at
      ? `<p>Doména je zaregistrovaná na vašu firmu do ${escapeHtml(dateIn(o.expires_at, shop.timezone))}.</p>`
      : "",
    o.test_mode ? `<p>(Testovací režim: doména ${escapeHtml(o.hostname)} sa nekúpila, stránka beží na testovacej doméne.)</p>` : "",
    `<p>${a(planPage(o, shop), "Predplatné a doména")}${o.invoice_url ? ` · ${a(o.invoice_url, "Faktúra")}` : ""}</p>`,
    `<p>Cacadoo PPI</p>`,
    `</div>`,
  ].join("");
  return { to, subject: `Vaša stránka beží na ${host}`, text: lines.join("\n"), html };
}

// ---------------------------------------------------------------- the steps

/** Back off: 5 min · 2ⁿ, at most 6 hours. */
const backoff = (attempts: number) => Math.min(5 * MINUTE * 2 ** Math.max(0, attempts), 6 * HOUR);
const MAX_ATTEMPTS = 12;

/** One step further for one order (called by the tick, a payment, or a button). */
export async function advance(deps: Deps, o: Order): Promise<void> {
  try {
    switch (o.status) {
      case "paid":
        return await startRegistration(deps, o);
      case "registering":
        return await register(deps, o);
      case "configuring":
        return await configure(deps, o);
      case "securing":
        return await secure(deps, o);
      case "waiting_dns":
        return await waitForDns(deps, o);
      case "verified":
        await patch(deps, o.id, { status: "securing" });
        return await secure(deps, { ...o, status: "securing" });
    }
  } catch (e) {
    const attempts = o.attempts + 1;
    await log(deps, o.id, o.status, false, failText(e));
    if (o.kind === "bought" && ["paid", "registering"].includes(o.status) && attempts >= MAX_ATTEMPTS) {
      await registrationFailed(deps, o, failText(e));
      return;
    }
    await patch(deps, o.id, { attempts, next_attempt_at: iso(deps, backoff(attempts)), claimed_until: null });
  } finally {
    await deps.db.from("domain_orders").update({ claimed_until: null }).eq("id", o.id);
  }
}

async function later(deps: Deps, o: Order, ms: number, values: Record<string, unknown> = {}) {
  await patch(deps, o.id, { next_attempt_at: iso(deps, ms), ...values });
}

/** Test mode: the admin's test domain (in our Websupport account) carries the website. */
async function testDomain(deps: Deps, o: Order): Promise<string | null> {
  const settings = await settingsOf(deps);
  if (settings.test_domain) return settings.test_domain;
  await patch(deps, o.id, { needs_admin: true });
  await log(deps, o.id, o.status, false, "Test mode: set the test domain in Predplatné a domény → Nastavenia");
  await later(deps, o, 30 * MINUTE);
  return null;
}

async function startRegistration(deps: Deps, o: Order) {
  // Test mode: the test domain is taken on only when the website is set up (see register).
  const siteHost = o.test_mode ? null : o.hostname;
  if (o.test_mode && !(await testDomain(deps, o))) return;
  await patch(deps, o.id, { status: "registering", site_host: siteHost, attempts: 0, next_attempt_at: iso(deps) });
  await log(deps, o.id, "registering", true, null);
  return await register(deps, { ...o, status: "registering", site_host: siteHost, attempts: 0 });
}

async function register(deps: Deps, o: Order) {
  const registrar = deps.registrar;
  if (!registrar) throw new Error("Websupport is not set up (WEBSUPPORT_API_KEY, WEBSUPPORT_API_SECRET, WEBSUPPORT_USER_ID)");

  if (!o.registrar_order_id) {
    // Between the check and the payment someone else may have bought it.
    const free = await registrar.check(o.hostname);
    const ours = free.available ? null : await registrar.findService(o.hostname);
    if (!free.available && !ours) return await domainTaken(deps, o);
    if (ours) {
      // Ordered by an earlier attempt that stopped before saving it: never a second order.
      await patch(deps, o.id, { registrar_order_id: "existing", registrar_paid_at: iso(deps) });
      await log(deps, o.id, "ordered", true, "already in the account (an earlier attempt)");
      return await register(deps, { ...o, registrar_order_id: "existing", registrar_paid_at: iso(deps) });
    }

    if (!o.test_mode) {
      // Our prepaid credit pays Websupport; a low credit waits (the shop sees "Registrujem doménu").
      const credit = await registrar.credit();
      const { data: alert } = await deps.db.rpc("domain_set_credit", { p_credit: credit });
      const needed = free.price ?? (o.price_cents ?? 0) / 100;
      if (credit < needed) {
        if (!o.waiting_credit || alert === true) {
          await adminMail(deps, "Dobite kredit na Websupport",
            `Na Websupporte chýba kredit na registráciu domény ${o.hostname} (kredit ${credit} €). Objednávka čaká a po dobití sa dokončí sama.`);
        }
        await log(deps, o.id, "registering", false, `Waiting for Websupport credit (${credit} EUR)`);
        return await later(deps, o, 10 * MINUTE, { waiting_credit: true });
      }
    }

    const { data: details } = await deps.db.rpc("domain_owner_details", { p_shop_id: o.shop_id });
    const owner = details as (Registrant & { missing: string[] }) | null;
    if (!owner || owner.missing.length) {
      await patch(deps, o.id, { needs_admin: true });
      await log(deps, o.id, "registering", false, `Owner details missing: ${owner?.missing.join(", ") ?? "shop"}`);
      return await later(deps, o, 6 * HOUR);
    }
    // The shop is the registrant: its own profile (the one of an earlier domain, updated).
    const { data: earlier } = await deps.db
      .from("domain_orders")
      .select("registrar_profile_id")
      .eq("shop_id", o.shop_id)
      .not("registrar_profile_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    const known = o.registrar_profile_id ?? (earlier?.[0] as { registrar_profile_id: string } | undefined)?.registrar_profile_id ?? null;
    let profileId: string;
    try {
      profileId = await registrar.profile(owner, known);
    } catch (e) {
      const fields = refusedOwnerFields(e);
      if (!fields.length) throw e;
      return await ownerDetailsRefused(deps, o, fields, failText(e));
    }
    await patch(deps, o.id, { registrar_profile_id: profileId, waiting_credit: false });

    const placed = await registrar.order(o.hostname, profileId, o.test_mode);
    const orderId = placed.orderId ?? (o.test_mode ? `dry-run-${o.id.slice(0, 8)}` : null);
    if (!orderId) throw new Error("Websupport: the order has no id");
    await patch(deps, o.id, { registrar_order_id: orderId });
    await log(deps, o.id, "ordered", true, o.test_mode ? `dry run ${orderId}` : `order ${orderId}`);
    o = { ...o, registrar_order_id: orderId, registrar_profile_id: profileId };
  }

  if (!o.test_mode && !o.registrar_paid_at) {
    await registrar.pay(o.registrar_order_id!);
    await patch(deps, o.id, { registrar_paid_at: iso(deps) });
    await log(deps, o.id, "paid by credit", true, null);
  }

  // Registration takes a while: the domain appears among our services when it is done.
  const siteHost = o.test_mode ? await testDomain(deps, o) : o.hostname;
  if (!siteHost) return;
  const service = await registrar.findService(siteHost);
  if (!service) {
    await stuckCheck(deps, o);
    return await later(deps, o, 5 * MINUTE);
  }
  if (!o.test_mode) await registrar.autoRenew(service.id, false).catch(() => null);
  const expiresAt = service.expiresAt ?? (o.test_mode ? null : iso(deps, 365 * DAY));
  try {
    await patch(deps, o.id, { status: "configuring", site_host: siteHost, registrar_service_id: service.id, expires_at: expiresAt, attempts: 0, next_attempt_at: iso(deps) });
  } catch (e) {
    // Test mode: one website at a time on the test domain.
    if (!o.test_mode || !/duplicate key|unique/i.test(failText(e))) throw e;
    await patch(deps, o.id, { needs_admin: true });
    await log(deps, o.id, "registering", false, `Test mode: the test domain ${siteHost} carries another shop's website; end that one first`);
    return await later(deps, o, 30 * MINUTE);
  }
  await log(deps, o.id, "configuring", true, o.test_mode ? `test mode: the website goes on ${siteHost} (service ${service.id})` : `service ${service.id}`);
  return await configure(deps, { ...o, status: "configuring", site_host: siteHost, registrar_service_id: service.id, expires_at: expiresAt, attempts: 0 });
}

const OWNER_LABEL_SK: Record<string, string> = {
  company_name: "názov firmy", contact_name: "kontaktná osoba", street: "ulica", city: "mesto", zip: "PSČ",
  country: "krajina", ico: "IČO", ic_dph: "IČ DPH", email: "e-mail", phone: "telefón",
};

/**
 * Websupport refused some of the owner's details (e.g. an IČO that is not valid): retrying cannot
 * help and nothing is refunded for it. The shop corrects them on its page (or the admin), and the
 * registration goes on by itself; the shop is told once by e-mail.
 */
async function ownerDetailsRefused(deps: Deps, o: Order, fields: string[], reason: string) {
  const firstTime = !o.needs_admin;
  await patch(deps, o.id, { needs_admin: true });
  await log(deps, o.id, "registering", false, `${OWNER_REFUSED}${fields.join(", ")} (${reason})`);
  if (firstTime) {
    const shop = await shopOf(deps, o.shop_id);
    if (shop) {
      await send(deps, {
        to: await shopMail(deps, o.shop_id),
        subject: `Opravte údaje majiteľa domény ${o.hostname}`,
        text: `Dobrý deň,\n\nregistrátor Websupport neprijal tieto údaje majiteľa domény ${o.hostname}: ${fields.map((f) => OWNER_LABEL_SK[f] ?? f).join(", ")}.\nOpravte ich na stránke Predplatné a doména – registrácia potom pokračuje sama:\n${planPage(o, shop)}\n\nCacadoo PPI`,
      });
    }
  }
  return await later(deps, o, 6 * HOUR);
}

/** Adds bare + www to Vercel (www redirects to the bare host) and returns the verification. */
async function addToVercel(deps: Deps, o: Order, host: string): Promise<Want[]> {
  const vercel = deps.vercel!;
  const added = await vercel.add(host);
  if (o.www && isApex(host)) await vercel.add(`www.${host}`, host);
  if (!o.vercel_added_at) {
    await patch(deps, o.id, { vercel_added_at: iso(deps) });
    await log(deps, o.id, "vercel", true, `${host} added to the project`);
  }
  return added.verification;
}

async function configure(deps: Deps, o: Order) {
  if (!deps.vercel) throw new Error("Vercel is not set up (VERCEL_API_TOKEN, VERCEL_PROJECT_ID)");
  const host = o.site_host ?? o.hostname;
  const verification = await addToVercel(deps, o, host);
  const config = await deps.vercel.config(host);
  const wanted = websiteRecords(host, o.www, config, verification);
  if (!wanted.some((w) => w.type !== "TXT")) throw new Error("Vercel gave no DNS records for the website");
  if (o.registrar_service_id && deps.registrar) {
    await log(deps, o.id, "dns", true, await applyDns(deps.registrar, o.registrar_service_id, host, wanted));
  }
  await patch(deps, o.id, { dns_records: wanted, checks: o.checks + 1, last_check_at: iso(deps) });
  const verified = !config.misconfigured && (await deps.vercel.verify(host));
  if (!verified) {
    await stuckCheck(deps, o);
    return await later(deps, o, 5 * MINUTE);
  }
  await patch(deps, o.id, { status: "securing", next_attempt_at: iso(deps) });
  await log(deps, o.id, "securing", true, null);
  return await secure(deps, { ...o, status: "securing" });
}

/** HTTPS works when the host answers over TLS (any HTTP status). */
async function httpsWorks(deps: Deps, host: string): Promise<boolean> {
  try {
    const res = await deps.fetch(`https://${host}/`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel().catch(() => null);
    return true;
  } catch {
    return false;
  }
}

async function secure(deps: Deps, o: Order) {
  const host = o.site_host ?? o.hostname;
  if (!(await httpsWorks(deps, host))) {
    await stuckCheck(deps, o);
    return await later(deps, o, 5 * MINUTE);
  }
  await patch(deps, o.id, { status: "live", live_at: iso(deps), attempts: 0, next_attempt_at: null, needs_admin: false });
  await log(deps, o.id, "live", true, `https://${host}`);
  await sendLiveMail(deps, { ...o, status: "live" });
}

/** "Vaša stránka beží na …" once (a second call never sends it again). */
export async function sendLiveMail(deps: Deps, o: Order, again = false): Promise<boolean> {
  if (!again) {
    const { data } = await deps.db
      .from("domain_orders")
      .update({ live_email_at: iso(deps) })
      .eq("id", o.id)
      .is("live_email_at", null)
      .select("id");
    if (!data?.length) return false;
  }
  const shop = await shopOf(deps, o.shop_id);
  if (!shop) return false;
  let fresh = (await load(deps, o.id)) ?? o;
  if (!fresh.invoice_url && fresh.stripe_invoice && deps.stripe) {
    const inv = await deps.stripe<Invoice>("GET", `/invoices/${encodeURIComponent(fresh.stripe_invoice)}`).catch(() => null);
    if (inv?.hosted_invoice_url) {
      await patch(deps, o.id, { invoice_url: inv.hosted_invoice_url });
      fresh = { ...fresh, invoice_url: inv.hosted_invoice_url };
    }
  }
  const sent = await send(deps, liveMail(fresh, shop, await shopMail(deps, o.shop_id)));
  if (!sent && !again) await deps.db.from("domain_orders").update({ live_email_at: null }).eq("id", o.id);
  if (sent && again) await patch(deps, o.id, { live_email_at: iso(deps) });
  await log(deps, o.id, "live e-mail", sent, sent ? null : "not sent (Brevo)");
  return sent;
}

/** Bought orders that hang for more than 48 hours, connected ones waiting for DNS as long: the admin hears once. */
async function stuckCheck(deps: Deps, o: Order) {
  if (o.stuck_alert_at) return;
  const since = Date.parse(o.paid_at ?? o.created_at);
  if (deps.now() - since < 48 * HOUR) return;
  await patch(deps, o.id, { stuck_alert_at: iso(deps) });
  await adminMail(deps, `DNS sa nenastavili do 48 hodín: ${o.hostname}`,
    `Doména ${o.hostname} (${o.kind === "bought" ? "kúpená" : "pripojená"}) je už 48 hodín v stave „${o.status}“.${o.last_error ? ` Posledná chyba: ${o.last_error}` : ""}\nPodrobnosti: Predplatné a domény v administrácii.`);
}

async function waitForDns(deps: Deps, o: Order) {
  if (!deps.vercel) throw new Error("Vercel is not set up (VERCEL_API_TOKEN, VERCEL_PROJECT_ID)");
  const host = o.site_host ?? o.hostname;
  const verification = await addToVercel(deps, o, host);
  const config = await deps.vercel.config(host);
  const wanted = websiteRecords(host, o.www, config, verification);

  // The domain is at Websupport in our account: the records are written for the shop.
  let serviceId = o.registrar_service_id;
  if (!serviceId && deps.registrar) {
    const service = await deps.registrar.findService(host).catch(() => null);
    if (service) {
      serviceId = service.id;
      await patch(deps, o.id, { registrar_service_id: serviceId });
    }
  }
  if (serviceId && deps.registrar && !o.dns_records) {
    await log(deps, o.id, "dns", true, await applyDns(deps.registrar, serviceId, host, wanted));
  }

  const verified = !config.misconfigured && (await deps.vercel.verify(host));
  const age = deps.now() - Date.parse(o.created_at);
  await patch(deps, o.id, { dns_records: wanted, checks: o.checks + 1, last_check_at: iso(deps) });
  if (verified) {
    await patch(deps, o.id, { status: "verified", next_attempt_at: iso(deps) });
    await log(deps, o.id, "verified", true, null);
    await patch(deps, o.id, { status: "securing" });
    return await secure(deps, { ...o, status: "securing" });
  }
  if (age > 7 * DAY) {
    await deps.vercel.remove(host).catch(() => null);
    if (o.www && isApex(host)) await deps.vercel.remove(`www.${host}`).catch(() => null);
    await patch(deps, o.id, { status: "dns_timeout", next_attempt_at: null, ended_at: iso(deps) });
    await log(deps, o.id, "dns_timeout", false, "No DNS records in 7 days: removed");
    const shop = await shopOf(deps, o.shop_id);
    if (shop) {
      await send(deps, {
        to: await shopMail(deps, o.shop_id),
        subject: `Doménu ${host} sa nepodarilo pripojiť`,
        text: `Dobrý deň,\n\nza 7 dní sme u domény ${host} nenašli potrebné DNS záznamy, preto sme pripájanie zastavili. Môžete ho kedykoľvek začať znova:\n${planPage(o, shop)}\n\nCacadoo PPI`,
      });
    }
    return;
  }
  if (age > DAY && !o.dns_reminder_at) {
    await patch(deps, o.id, { dns_reminder_at: iso(deps) });
    const shop = await shopOf(deps, o.shop_id);
    if (shop) {
      const records = wanted.map((w) => `${w.type}  ${w.name}  ${w.value}`).join("\n");
      await send(deps, {
        to: await shopMail(deps, o.shop_id),
        subject: `Pripojte doménu ${host}: chýbajú DNS záznamy`,
        text: `Dobrý deň,\n\nu domény ${host} ešte nevidíme záznamy pre vašu stránku. Prihláste sa u svojho registrátora a pridajte tieto záznamy:\n\n${records}\n\nNeodstraňujte existujúce MX záznamy, inak prestane fungovať e-mail.\n\nPodrobnosti a tlačidlo Skontrolovať: ${planPage(o, shop)}\n\nCacadoo PPI`,
      });
    }
  }
  if (age > 48 * HOUR) await stuckCheck(deps, o);
  // Every 10 minutes for the first 2 hours, then every 3 hours.
  return await later(deps, o, age < 2 * HOUR ? 10 * MINUTE : 3 * HOUR, { next_check_at: iso(deps, age < 2 * HOUR ? 10 * MINUTE : 3 * HOUR) });
}

// ---------------------------------------------------------------- refunds

/** The domain part back to the shop's card (Pro stays when it was bought together). */
export async function refundDomain(deps: Deps, o: Order, reason: string): Promise<string | null> {
  if (!deps.stripe) throw new Error("Stripe is not set up");
  if (o.refunded_at) return null;
  let intent = o.stripe_payment_intent;
  let invoice: Invoice | null = null;
  let invoiceId = o.stripe_invoice;
  if (!intent && !invoiceId && o.stripe_session) {
    const session = await deps.stripe<{ payment_intent?: Ref; invoice?: Ref }>("GET", `/checkout/sessions/${encodeURIComponent(o.stripe_session)}`);
    intent = idOf(session.payment_intent);
    invoiceId = idOf(session.invoice);
  }
  if (invoiceId && (!intent || o.with_pro)) {
    const found = await invoicePaymentIntent(deps.stripe, invoiceId);
    intent = intent ?? found.intent;
    invoice = found.invoice;
  }
  if (!intent) throw new Error("No payment to refund");
  // Bought together with Pro: only the domain's line (with its tax) comes back.
  let amount: number | undefined;
  if (o.with_pro) {
    const lines = invoice?.lines?.data ?? [];
    const line = lines.find((l) => l.metadata?.ppi_domain_order === o.id) ?? lines.find((l) => l.amount === o.price_cents);
    const tax = (line?.taxes ?? []).reduce((sum, t) => sum + (t.amount ?? 0), 0);
    amount = line?.amount !== undefined ? line.amount + (o.vat_included === false ? tax : 0) : o.price_cents ?? undefined;
  }
  const refund = await deps.stripe<{ id: string }>(
    "POST",
    "/refunds",
    { payment_intent: intent, amount, metadata: { ppi_domain_order: o.id, reason } },
    `ppi-domain-refund-${o.id}`,
  );
  await patch(deps, o.id, { refunded_at: iso(deps), refund_id: refund.id, stripe_payment_intent: intent });
  await log(deps, o.id, "refunded", true, `${refund.id} (${reason})`);
  return refund.id;
}

/** Paid for an order that was given up meanwhile (another domain was started): money back. */
async function refundOrphan(deps: Deps, id: string) {
  const o = await load(deps, id);
  if (!o || o.status !== "canceled" || !o.paid_at || o.refunded_at) return;
  try {
    await refundDomain(deps, o, "given up");
  } catch (e) {
    await patch(deps, o.id, { needs_admin: true });
    await log(deps, o.id, "refund", false, failText(e));
  }
}

async function domainTaken(deps: Deps, o: Order) {
  let refunded = true;
  try {
    await refundDomain(deps, o, "taken");
  } catch (e) {
    refunded = false;
    await log(deps, o.id, "refund", false, failText(e));
  }
  await patch(deps, o.id, { status: "taken", next_attempt_at: null, ended_at: iso(deps), needs_admin: !refunded });
  await log(deps, o.id, "taken", false, "The domain was registered by someone else before ours");
  const shop = await shopOf(deps, o.shop_id);
  if (shop) {
    await send(deps, {
      to: await shopMail(deps, o.shop_id),
      subject: `Doména ${o.hostname} už nie je voľná – peniaze za doménu vraciame`,
      text: `Dobrý deň,\n\ndoménu ${o.hostname} medzičasom zaregistroval niekto iný. ${refunded ? `Sumu za doménu (${money(o.price_cents)}) sme vrátili na vašu kartu` : "Sumu za doménu vám vrátime"}; predplatné Pro zostáva.\n\nVyberte si prosím iný názov na Websupport.sk a vložte ho znova:\n${planPage(o, shop)}\n\nCacadoo PPI`,
    });
  }
  if (!refunded) await adminMail(deps, `Vrátenie peňazí zlyhalo: ${o.hostname}`, `Doména ${o.hostname} bola obsadená, ale peniaze sa nepodarilo vrátiť automaticky. Vráťte ich v Stripe.`);
}

async function registrationFailed(deps: Deps, o: Order, reason: string) {
  let refunded = true;
  try {
    await refundDomain(deps, o, "failed");
  } catch (e) {
    refunded = false;
    await log(deps, o.id, "refund", false, failText(e));
  }
  await patch(deps, o.id, { status: "failed", next_attempt_at: null, needs_admin: true, failure_alert_at: iso(deps), ended_at: iso(deps) });
  await log(deps, o.id, "failed", false, reason);
  await adminMail(deps, `Registrácia domény zlyhala: ${o.hostname}`,
    `Doménu ${o.hostname} sa nepodarilo zaregistrovať ani po ${MAX_ATTEMPTS} pokusoch.\nDôvod: ${reason}\nPeniaze za doménu: ${refunded ? "vrátené automaticky" : "NEVRÁTENÉ – vráťte ich v Stripe"}.`);
  const shop = await shopOf(deps, o.shop_id);
  if (shop) {
    await send(deps, {
      to: await shopMail(deps, o.shop_id),
      subject: `Doménu ${o.hostname} sa nepodarilo zaregistrovať`,
      text: `Dobrý deň,\n\ndoménu ${o.hostname} sa nám nepodarilo zaregistrovať. ${refunded ? `Sumu za doménu (${money(o.price_cents)}) sme vrátili na vašu kartu` : "Sumu za doménu vám vrátime do niekoľkých dní"}; predplatné Pro zostáva. Ozveme sa vám, alebo si môžete vybrať iný názov:\n${planPage(o, shop)}\n\nCacadoo PPI`,
    });
  }
}

// ---------------------------------------------------------------- the jobs

/** Every 5 minutes: steps that are due (within the time budget). */
export async function tick(deps: Deps): Promise<{ done: number }> {
  const started = deps.now();
  let done = 0;
  while (deps.now() - started < TICK_BUDGET_MS) {
    const { data } = await deps.db.rpc("domain_claim", { p_limit: 5 });
    const ids = (data ?? []) as string[];
    if (!ids.length) break;
    for (const id of ids) {
      const o = await load(deps, id);
      if (o) await advance(deps, o);
      done++;
    }
  }
  return { done };
}

/** Runs one order now (after a payment or a button), unless another worker has it. */
async function runOne(deps: Deps, id: string) {
  const { data: claimed } = await deps.db.rpc("domain_claim_one", { p_id: id });
  if (claimed !== true) return;
  const o = await load(deps, id);
  if (o) await advance(deps, o);
}

interface PlanRow {
  shop_id: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
}

/** Once a day: abandoned payments, the credit, plans that ended, renewals and their reminders. */
export async function daily(deps: Deps): Promise<Record<string, number>> {
  const out = { canceled: 0, ended: 0, renewals: 0, lapsed: 0, reminders: 0 };

  // Payment pages left open for a day: given up (their invoice voided, never charged later).
  const { data: stale } = await deps.db
    .from("domain_orders")
    .select("*")
    .eq("status", "checkout")
    .is("paid_at", null)
    .lt("updated_at", iso(deps, -DAY));
  for (const o of (stale ?? []) as Order[]) {
    if (o.stripe_invoice && deps.stripe) {
      await deps.stripe("POST", `/invoices/${encodeURIComponent(o.stripe_invoice)}/void`).catch(() => null);
    }
    await patch(deps, o.id, { status: "canceled", ended_at: iso(deps) });
    await log(deps, o.id, "canceled", true, "Payment page not completed in 24 hours");
    out.canceled++;
  }

  // Payments for orders that were given up, not refunded yet (a failed refund is retried daily).
  const { data: orphans } = await deps.db.from("domain_orders").select("id").eq("status", "canceled").not("paid_at", "is", null).is("refunded_at", null);
  for (const o of (orphans ?? []) as { id: string }[]) await refundOrphan(deps, o.id);

  if (deps.registrar && deps.mode === "live") {
    try {
      const credit = await deps.registrar.credit();
      const { data: alert } = await deps.db.rpc("domain_set_credit", { p_credit: credit });
      if (alert === true) await adminMail(deps, "Dobite kredit na Websupport", `Kredit na Websupporte je ${credit} € – menej ako nastavený limit.`);
    } catch (e) {
      console.error("domains: credit check failed", failText(e).slice(0, 160));
    }
  }

  const { data: liveRows } = await deps.db.from("domain_orders").select("*").in("status", ["live", "waiting_dns", "verified", "securing", "configuring"]);
  for (const o of (liveRows ?? []) as Order[]) {
    try {
      const { data: hasPlan } = await deps.db.rpc("shop_has_plan", { p_shop_id: o.shop_id });
      if (hasPlan !== true) {
        await endDomain(deps, o, "The Pro plan ended");
        out.ended++;
        continue;
      }
      if (o.status === "live" && !o.live_email_at) await sendLiveMail(deps, o);
      if (o.kind === "bought" && o.status === "live" && !o.test_mode && o.expires_at) {
        const r = await renewal(deps, o);
        out.renewals += r.charged;
        out.lapsed += r.lapsed;
        out.reminders += r.reminders;
      }
    } catch (e) {
      await log(deps, o.id, "daily", false, failText(e));
    }
  }
  return out;
}

/** Pro ended: the website goes back to its Cacadoo address; a bought domain stays the shop's. */
async function endDomain(deps: Deps, o: Order, reason: string) {
  const host = o.site_host ?? o.hostname;
  if (deps.vercel) {
    await deps.vercel.remove(host).catch(() => null);
    if (o.www && isApex(host)) await deps.vercel.remove(`www.${host}`).catch(() => null);
  }
  let authCode = o.auth_code;
  if (o.kind === "bought" && !o.test_mode && deps.registrar && o.registrar_service_id) {
    await deps.registrar.autoRenew(o.registrar_service_id, false).catch(() => null);
    authCode = authCode ?? (await deps.registrar.authCode(o.registrar_service_id).catch(() => null));
  }
  await patch(deps, o.id, { status: "ended", ended_at: iso(deps), next_attempt_at: null, auth_code: authCode });
  await log(deps, o.id, "ended", true, reason);
  if (o.kind === "bought" && !o.test_mode) {
    const shop = await shopOf(deps, o.shop_id);
    if (shop) {
      await send(deps, {
        to: await shopMail(deps, o.shop_id),
        subject: `Doména ${o.hostname} zostáva vaša`,
        text: `Dobrý deň,\n\npredplatné Pro sa skončilo, stránka sa vrátila na adresu v Cacadoo. Doména ${o.hostname} je zaregistrovaná na vašu firmu${o.expires_at ? ` do ${dateIn(o.expires_at, shop.timezone)}` : ""} a zostáva vaša.\n${authCode ? `Kód na prevod k inému registrátorovi: ${authCode}\n` : "Kód na prevod nájdete na stránke Predplatné a doména.\n"}Prevod: u nového registrátora zvoľte „prevod domény“ a vložte tento kód.\n\n${planPage(o, shop)}\n\nCacadoo PPI`,
      });
    }
  }
}

/**
 * 30 days before expiry: the renewal is charged to the saved card (an invoice from Cacadoo).
 * Paid → Websupport renews from our credit (its renewal switch is turned on only now).
 * Not paid → a reminder every week with the payment link; at expiry the domain lapses and
 * the website goes back to its Cacadoo address.
 */
async function renewal(deps: Deps, o: Order): Promise<{ charged: number; lapsed: number; reminders: number }> {
  const result = { charged: 0, lapsed: 0, reminders: 0 };
  const left = Date.parse(o.expires_at!) - deps.now();
  const shop = await shopOf(deps, o.shop_id);
  if (!shop) return result;
  const to = await shopMail(deps, o.shop_id);
  const until = dateIn(o.expires_at, shop.timezone);

  // After the expiry: renewed at Websupport (the date moved) or lapsed.
  if (left <= 0) {
    const service = deps.registrar ? await deps.registrar.findService(o.hostname).catch(() => null) : null;
    if (o.renewal_state === "paid" && service?.expiresAt && Date.parse(service.expiresAt) > Date.parse(o.expires_at!)) {
      if (o.registrar_service_id) await deps.registrar!.autoRenew(o.registrar_service_id, false).catch(() => null);
      await patch(deps, o.id, {
        expires_at: service.expiresAt, renewal_state: "none", renewal_invoice: null, renewal_invoice_url: null,
        notice_30_at: null, notice_7_at: null, renewal_reminder_at: null,
      });
      await log(deps, o.id, "renewed", true, `until ${service.expiresAt}`);
      return result;
    }
    if (o.renewal_state !== "paid") {
      if (deps.vercel) {
        await deps.vercel.remove(o.hostname).catch(() => null);
        if (o.www) await deps.vercel.remove(`www.${o.hostname}`).catch(() => null);
      }
      await patch(deps, o.id, { status: "lapsed", ended_at: iso(deps) });
      await log(deps, o.id, "lapsed", false, "The renewal was not paid");
      await send(deps, {
        to,
        subject: `Doména ${o.hostname} vypršala`,
        text: `Dobrý deň,\n\nobnova domény ${o.hostname} nebola zaplatená, preto doména ${until} vypršala a stránka sa vrátila na adresu v Cacadoo.\n\n${planPage(o, shop)}\n\nCacadoo PPI`,
      });
      result.lapsed++;
    }
    return result;
  }

  // "due": the charge was started (a day with Stripe trouble is tried again; the invoice is the same).
  if (left <= 30 * DAY && (o.renewal_state === "none" || o.renewal_state === "due") && deps.stripe) {
    await patch(deps, o.id, { renewal_state: "due", notice_30_at: iso(deps) });
    const charge = await chargeRenewal(deps, o);
    if (charge.paid) {
      await deps.db.rpc("domain_renewal_paid", { p_id: o.id, p_invoice: charge.invoice });
      if (o.registrar_service_id && deps.registrar) await deps.registrar.autoRenew(o.registrar_service_id, true);
      await log(deps, o.id, "renewal at Websupport", true, "renewal switch on");
      await send(deps, {
        to,
        subject: `Doména ${o.hostname} sa obnoví ${until}`,
        text: `Dobrý deň,\n\nobnovu domény ${o.hostname} na ďalší rok (${money(o.renewal_cents)}) sme zaplatili z vašej karty${charge.url ? `; faktúra: ${charge.url}` : ""}. Doména sa obnoví ${until}.\n\nCacadoo PPI`,
      });
      result.charged++;
    } else {
      await patch(deps, o.id, { renewal_state: "failed", renewal_invoice: charge.invoice, renewal_invoice_url: charge.url, renewal_reminder_at: iso(deps) });
      await log(deps, o.id, "renewal payment", false, charge.reason);
      await send(deps, {
        to,
        subject: `Platba za obnovu domény ${o.hostname} sa nepodarila`,
        text: `Dobrý deň,\n\nobnovu domény ${o.hostname} (${money(o.renewal_cents)}) sa nepodarilo zaplatiť z vašej karty. Zaplaťte ju prosím do ${until}${charge.url ? `:\n${charge.url}` : " na stránke Predplatné a doména"}.\nInak doména ${until} vyprší a stránka sa vráti na adresu v Cacadoo.\n\n${planPage(o, shop)}\n\nCacadoo PPI`,
      });
      result.reminders++;
    }
    return result;
  }

  if (o.renewal_state === "failed") {
    // Paid meanwhile on Stripe's page (the webhook records it)? Then renew; else remind weekly.
    if (o.renewal_invoice && deps.stripe) {
      const inv = await deps.stripe<Invoice>("GET", `/invoices/${encodeURIComponent(o.renewal_invoice)}`).catch(() => null);
      if (inv?.status === "paid") {
        await deps.db.rpc("domain_renewal_paid", { p_id: o.id, p_invoice: o.renewal_invoice });
        if (o.registrar_service_id && deps.registrar) await deps.registrar.autoRenew(o.registrar_service_id, true);
        return result;
      }
    }
    const lastReminder = o.renewal_reminder_at ? Date.parse(o.renewal_reminder_at) : 0;
    const week = deps.now() - lastReminder >= 7 * DAY;
    const lastWeek = left <= 7 * DAY && !o.notice_7_at;
    if (week || lastWeek) {
      await patch(deps, o.id, { renewal_reminder_at: iso(deps), ...(lastWeek ? { notice_7_at: iso(deps) } : {}) });
      await send(deps, {
        to,
        subject: `Pripomienka: zaplaťte obnovu domény ${o.hostname} do ${until}`,
        text: `Dobrý deň,\n\nobnova domény ${o.hostname} (${money(o.renewal_cents)}) ešte nie je zaplatená. Bez platby doména ${until} vyprší a stránka sa vráti na adresu v Cacadoo.${o.renewal_invoice_url ? `\nZaplatiť: ${o.renewal_invoice_url}` : ""}\n\n${planPage(o, shop)}\n\nCacadoo PPI`,
      });
      result.reminders++;
    }
  } else if (o.renewal_state === "paid" && o.registrar_service_id && deps.registrar) {
    // Paid (perhaps on Stripe's page): Websupport may renew from our credit (switching it on again is harmless).
    await deps.registrar.autoRenew(o.registrar_service_id, true);
  }
  if (o.renewal_state === "paid" && left <= 7 * DAY && !o.notice_7_at) {
    await patch(deps, o.id, { notice_7_at: iso(deps) });
    await send(deps, {
      to,
      subject: `Doména ${o.hostname} sa obnoví ${until}`,
      text: `Dobrý deň,\n\nobnova domény ${o.hostname} je zaplatená; doména sa obnoví ${until}. Nemusíte nič robiť.\n\nCacadoo PPI`,
    });
    result.reminders++;
  }
  return result;
}

/** The renewal invoice, charged to the saved card without the shop being there. */
async function chargeRenewal(deps: Deps, o: Order): Promise<{ paid: boolean; invoice: string | null; url: string | null; reason: string | null }> {
  const stripe = deps.stripe!;
  const { data: sub } = await deps.db.from("subscriptions").select("stripe_customer_id, stripe_subscription_id").eq("shop_id", o.shop_id).maybeSingle();
  const row = sub as { stripe_customer_id: string | null; stripe_subscription_id: string | null } | null;
  if (!row?.stripe_customer_id) return { paid: false, invoice: null, url: null, reason: "No Stripe customer" };
  const card = await savedCard(stripe, row.stripe_customer_id, row.stripe_subscription_id);
  const year = new Date(o.expires_at!).getUTCFullYear();
  const invoice = await stripe<Invoice>("POST", "/invoices", {
    customer: row.stripe_customer_id,
    collection_method: "charge_automatically",
    auto_advance: false,
    automatic_tax: { enabled: true },
    default_payment_method: card ?? undefined,
    description: `Obnova domény ${o.hostname} na ďalší rok`,
    metadata: { ppi_domain_renewal: o.id, ppi_kind: "domain_renewal", shop_id: o.shop_id },
  }, `ppi-domain-renewal-${o.id}-${year}`);
  await stripe("POST", "/invoiceitems", {
    customer: row.stripe_customer_id,
    invoice: invoice.id,
    amount: o.renewal_cents ?? 0,
    currency: (o.currency || "EUR").toLowerCase(),
    description: `Doména ${o.hostname} – obnova na 1 rok`,
    tax_behavior: taxBehavior(o.vat_included),
    metadata: { ppi_domain_renewal: o.id },
  }, `ppi-domain-renewal-item-${o.id}-${year}`);
  const final = invoice.status === "draft" || !invoice.status
    ? await stripe<Invoice>("POST", `/invoices/${encodeURIComponent(invoice.id)}/finalize`, {}, `ppi-domain-renewal-finalize-${o.id}-${year}`)
    : invoice;
  if (final.status === "paid") return { paid: true, invoice: invoice.id, url: final.hosted_invoice_url ?? null, reason: null };
  if (!card) return { paid: false, invoice: invoice.id, url: final.hosted_invoice_url ?? null, reason: "No saved card" };
  try {
    const paid = await stripe<Invoice>("POST", `/invoices/${encodeURIComponent(invoice.id)}/pay`, { payment_method: card, off_session: true });
    return { paid: paid.status === "paid", invoice: invoice.id, url: paid.hosted_invoice_url ?? final.hosted_invoice_url ?? null, reason: paid.status ?? null };
  } catch (e) {
    return { paid: false, invoice: invoice.id, url: final.hosted_invoice_url ?? null, reason: failText(e) };
  }
}

// ---------------------------------------------------------------- owners

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function caller(req: Request, deps: Deps): Promise<{ authorization: string; userId: string; email: string | null } | null> {
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data } = await deps.asCaller(authorization).auth.getUser(token);
  return data?.user ? { authorization, userId: data.user.id, email: data.user.email ?? null } : null;
}

async function member(deps: Deps, authorization: string, shopId: string): Promise<boolean> {
  if (!UUID.test(shopId)) return false;
  const { data } = await deps.asCaller(authorization).rpc("is_shop_member", { p_shop_id: shopId });
  return data === true;
}

/** Back only to a PPI page of this flow: https (http only on this computer), /{lang}/dashboard/plan. */
export function returnUrl(value: unknown): URL | null {
  try {
    const url = new URL(String(value));
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (url.username || url.password || !/^\/(sk|hu|en)\/dashboard\/plan$/.test(url.pathname)) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

const siteOrigin = (value: unknown) => {
  const url = returnUrl(value);
  return url ? url.origin : null;
};

/** Hosts that are never a shop's own domain (PPI itself, Vercel's own addresses). */
function ourOwnHost(host: string, origin: string | null): boolean {
  const own = origin ? new URL(origin).hostname : "";
  return host === own || host.endsWith(".vercel.app") || host.endsWith(".supabase.co") || host === "localhost";
}

/** Step 2: the pasted name, cleaned, checked against the price table and Websupport. */
async function checkAction(deps: Deps, who: { authorization: string }, body: Json): Promise<Response> {
  const shopId = String(body.shop_id ?? "");
  if (!(await member(deps, who.authorization, shopId))) return reply(403, { error: "not_member" });
  const origin = siteOrigin(body.return_url);
  if (!origin) return reply(400, { error: "bad_request" });
  const name = cleanDomain(String(body.domain ?? ""));
  const problem = nameProblem(name);
  if (problem) return reply(200, { state: "invalid", problem, domain: name });
  const { data: prices } = await deps.db.from("domain_prices").select("tld").eq("active", true);
  const tld = soldTld(name, ((prices ?? []) as { tld: string }[]).map((p) => p.tld));
  if (!tld) return reply(200, { state: name.split(".").length > 2 ? "invalid" : "unsupported", problem: "format", domain: name });
  if (!deps.registrar) return reply(503, { error: "not_configured" });
  const free = await deps.registrar.check(name);
  if (!free.available) return reply(200, { state: "taken", domain: name });
  const { data: quote, error } = await deps.db.rpc("domain_quote", {
    p_shop_id: shopId,
    p_hostname: name,
    p_site_url: origin,
    p_test_mode: deps.mode === "test",
  });
  if (error) {
    if (error.code === "55000") return reply(200, { state: "has_domain", domain: name });
    if (error.code === "P0002") return reply(200, { state: "unsupported", domain: name });
    throw new Error(error.message);
  }
  const q = quote as { id: string; price_cents: number; renewal_cents: number; vat_included: boolean; currency: string };
  return reply(200, { state: "available", domain: name, order_id: q.id, price_cents: q.price_cents, renewal_cents: q.renewal_cents, vat_included: q.vat_included, test: deps.mode === "test" });
}

/** Step 4: one click with the saved card, else Stripe Checkout (with Pro when the shop has none). */
async function payAction(deps: Deps, who: { authorization: string; userId: string; email: string | null }, body: Json): Promise<Response> {
  const id = String(body.order_id ?? "");
  const back = returnUrl(body.return_url);
  const lang: Lang = LANGS.find((l) => l === body.lang) ?? "sk";
  if (!UUID.test(id) || !back) return reply(400, { error: "bad_request" });
  if (body.accept_terms !== true) return reply(400, { error: "terms" });
  const o = await load(deps, id);
  if (!o || !(await member(deps, who.authorization, o.shop_id))) return reply(404, { error: "not_found" });
  if (o.kind !== "bought" || !["quoted", "checkout"].includes(o.status) || o.paid_at) return reply(409, { error: "state" });
  if (!deps.stripe || !deps.prices.domain) return reply(503, { error: "not_configured" });

  const { data: details } = await deps.db.rpc("domain_owner_details", { p_shop_id: o.shop_id });
  if ((details as { missing?: string[] } | null)?.missing?.length) return reply(409, { error: "owner_details" });
  const owner = details as { country?: string | null; ico?: string | null };
  // The registrar refuses a Slovak IČO that is not valid: say so before anything is paid.
  if (String(owner.country ?? "").toUpperCase() === "SK" && !validSkIco(String(owner.ico ?? ""))) return reply(409, { error: "owner_ico" });

  const stripe = deps.stripe;
  const [{ data: hasPlan }, { data: subRow }, shop] = await Promise.all([
    deps.db.rpc("shop_has_plan", { p_shop_id: o.shop_id }),
    deps.db.from("subscriptions").select("stripe_customer_id, stripe_subscription_id, status").eq("shop_id", o.shop_id).maybeSingle(),
    shopOf(deps, o.shop_id),
  ]);
  if (!shop) return reply(404, { error: "not_found" });
  const sub = subRow as { stripe_customer_id: string | null; stripe_subscription_id: string | null; status: string } | null;
  const metadata = { ppi_domain_order: o.id, ppi_kind: "domain", shop_id: o.shop_id };
  const description = `Doména ${o.hostname} – registrácia na 1 rok`;
  const success = new URL(back);
  success.searchParams.set("domain", "paid");
  success.hash = "domain";
  const cancel = new URL(back);
  cancel.searchParams.set("domain", "canceled");
  cancel.hash = "domain";

  // The shop's Stripe customer (made once, like stripe-checkout does).
  let customer = sub?.stripe_customer_id ?? null;
  if (!customer) {
    const created = await stripe<{ id: string }>("POST", "/customers", {
      email: who.email ?? undefined,
      name: shop.name,
      preferred_locales: [lang],
      metadata: { shop_id: o.shop_id },
    }, `ppi-customer-${o.shop_id}-${who.userId}`);
    const { data: linked, error } = await deps.db.rpc("link_stripe_customer", { p_shop_id: o.shop_id, p_customer: created.id });
    if (error || typeof linked !== "string") throw new Error(error?.message ?? "Customer not saved");
    customer = linked;
  }

  // The name is reserved for this shop before Stripe opens (a host is one shop's at a time).
  if (o.status === "quoted") {
    try {
      await patch(deps, o.id, { status: "checkout" });
    } catch (e) {
      if (/duplicate key|unique/i.test(failText(e))) return reply(200, { state: "in_use" });
      throw e;
    }
  }

  // Each try after a failed one gets new Stripe idempotency keys (Stripe keeps a key's answer for 24 hours).
  const n = o.attempts;
  const domainPrice: string = deps.prices.domain;
  const made: Made = { invoice: null, finalized: false };
  const open = async (): Promise<Response> => {
    const product = await domainProduct(stripe, domainPrice);
    const domainLine = {
      price_data: {
        currency: (o.currency || "EUR").toLowerCase(),
        product,
        unit_amount: o.price_cents ?? 0,
        tax_behavior: taxBehavior(o.vat_included),
      },
      quantity: 1,
    };

    if (hasPlan === true && sub && LIVE_PLAN.includes(sub.status)) {
      // On Pro: only the domain. The saved card pays it with one click.
      const card = await savedCard(stripe, customer, sub.stripe_subscription_id);
      if (card) {
        const invoice = await stripe<Invoice>("POST", "/invoices", {
          customer,
          collection_method: "charge_automatically",
          auto_advance: false,
          automatic_tax: { enabled: true },
          default_payment_method: card,
          description,
          metadata,
        }, `ppi-domain-invoice-${o.id}-${n}`);
        made.invoice = invoice.id;
        await stripe("POST", "/invoiceitems", {
          customer,
          invoice: invoice.id,
          amount: o.price_cents ?? 0,
          currency: (o.currency || "EUR").toLowerCase(),
          description,
          tax_behavior: taxBehavior(o.vat_included),
          metadata: { ppi_domain_order: o.id },
        }, `ppi-domain-item-${o.id}-${n}`);
        const final = await stripe<Invoice>("POST", `/invoices/${encodeURIComponent(invoice.id)}/finalize`, {}, `ppi-domain-finalize-${o.id}-${n}`);
        made.finalized = true;
        await patch(deps, o.id, { status: "checkout", stripe_invoice: invoice.id, invoice_url: final.hosted_invoice_url ?? null, with_pro: false });
        await log(deps, o.id, "checkout", true, `one-click invoice ${invoice.id}`);
        try {
          const paid = await stripe<Invoice>("POST", `/invoices/${encodeURIComponent(invoice.id)}/pay`, { payment_method: card, off_session: false });
          if (paid.status === "paid") {
            const { data: recorded } = await deps.db.rpc("domain_payment_received", {
              p_id: o.id, p_session: null, p_invoice: invoice.id, p_payment_intent: null, p_invoice_url: paid.hosted_invoice_url ?? final.hosted_invoice_url ?? null,
            });
            if (recorded === "recorded") deps.background(runOne(deps, o.id));
            return reply(200, { paid: true });
          }
        } catch (e) {
          // 3-D Secure or a declined card: Stripe's own invoice page finishes it.
          await log(deps, o.id, "one-click", false, failText(e));
        }
        if (final.hosted_invoice_url) return reply(200, { url: final.hosted_invoice_url });
        throw new Error("The invoice has no payment page");
      }
      const session = await stripe<{ id: string; url: string }>("POST", "/checkout/sessions", {
        mode: "payment",
        customer,
        customer_update: { name: "auto", address: "auto" },
        line_items: [domainLine],
        automatic_tax: { enabled: true },
        billing_address_collection: "required",
        invoice_creation: { enabled: true, invoice_data: { description, metadata } },
        payment_intent_data: { metadata, description },
        metadata,
        client_reference_id: o.shop_id,
        locale: lang,
        success_url: success.toString(),
        cancel_url: cancel.toString(),
      }, `ppi-domain-checkout-${o.id}-${n}`);
      await patch(deps, o.id, { status: "checkout", stripe_session: session.id, with_pro: false });
      await log(deps, o.id, "checkout", true, `payment page ${session.id}`);
      return reply(200, { url: session.url });
    }

    // Not on Pro: Pro and the domain in one payment (the domain is a one-time line).
    if (!deps.prices.pro) return reply(503, { error: "not_configured" });
    const companyId = String((details as { ico?: string } | null)?.ico ?? "").trim().slice(0, 40);
    const label = String(body.company_id_label ?? "").replace(/[\x00-\x1f]/g, "").trim().slice(0, 100) || "Company ID";
    const session = await stripe<{ id: string; url: string }>("POST", "/checkout/sessions", {
      mode: "subscription",
      customer,
      customer_update: { name: "auto", address: "auto" },
      line_items: [{ price: deps.prices.pro, quantity: 1 }, { ...domainLine, price_data: { ...domainLine.price_data } }],
      client_reference_id: o.shop_id,
      metadata,
      subscription_data: { metadata: { shop_id: o.shop_id } },
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      name_collection: { business: { enabled: true } },
      billing_address_collection: "required",
      custom_fields: [{
        key: "companyid",
        label: { type: "custom", custom: label },
        type: "text",
        optional: true,
        text: { maximum_length: 40, default_value: companyId || undefined },
      }],
      locale: lang,
      success_url: success.toString(),
      cancel_url: cancel.toString(),
    }, `ppi-domain-checkout-pro-${o.id}-${n}`);
    await patch(deps, o.id, { status: "checkout", stripe_session: session.id, with_pro: true });
    await log(deps, o.id, "checkout", true, `payment page with Pro ${session.id}`);
    return reply(200, { url: session.url });
  };
  try {
    return await open();
  } catch (e) {
    await paymentNotOpened(deps, o, made, failText(e));
    if (e instanceof StripeError) return reply(502, { error: "stripe", message: e.message.slice(0, 200) });
    throw e;
  }
}

interface Made {
  invoice: string | null;
  finalized: boolean;
}

/**
 * The payment page could not be opened: nothing half-made stays at Stripe (a finalized invoice
 * is voided, a draft deleted, an older payment page closed) and the order is "checked" again,
 * so the shop can simply press "Zaplatiť" again (with new idempotency keys).
 */
async function paymentNotOpened(deps: Deps, o: Order, made: Made, reason: string) {
  const stripe = deps.stripe;
  if (stripe && made.invoice) {
    const path = `/invoices/${encodeURIComponent(made.invoice)}`;
    await (made.finalized ? stripe("POST", `${path}/void`) : stripe("DELETE", path)).catch(() => null);
  }
  if (stripe && o.stripe_session) {
    await stripe("POST", `/checkout/sessions/${encodeURIComponent(o.stripe_session)}/expire`).catch(() => null);
  }
  await deps.db
    .from("domain_orders")
    .update({ status: "quoted", stripe_session: null, stripe_invoice: null, invoice_url: null, attempts: o.attempts + 1, updated_at: iso(deps) })
    .eq("id", o.id)
    .is("paid_at", null);
  await log(deps, o.id, "checkout", false, `Payment page not opened: ${reason}`);
}

/** "Zrušiť objednávku": an unpaid order is given up (its Stripe page closed); a payment that still arrives is refunded. */
async function cancelPaymentAction(deps: Deps, who: { authorization: string }, body: Json): Promise<Response> {
  const id = String(body.order_id ?? "");
  const o = UUID.test(id) ? await load(deps, id) : null;
  if (!o || !(await member(deps, who.authorization, o.shop_id))) return reply(404, { error: "not_found" });
  if (o.kind !== "bought" || !["quoted", "checkout"].includes(o.status) || o.paid_at) return reply(409, { error: "state" });
  if (deps.stripe) {
    if (o.stripe_session) await deps.stripe("POST", `/checkout/sessions/${encodeURIComponent(o.stripe_session)}/expire`).catch(() => null);
    if (o.stripe_invoice) await deps.stripe("POST", `/invoices/${encodeURIComponent(o.stripe_invoice)}/void`).catch(() => null);
  }
  const { data } = await deps.db
    .from("domain_orders")
    .update({ status: "canceled", ended_at: iso(deps), next_attempt_at: null, updated_at: iso(deps) })
    .eq("id", o.id)
    .is("paid_at", null)
    .select("id");
  if (!data?.length) return reply(409, { error: "state" });
  await log(deps, o.id, "canceled", true, "Canceled by the owner before paying");
  return reply(200, { status: "canceled" });
}

/** Flow 14: the shop's own domain (Pro only). */
async function connectAction(deps: Deps, who: { authorization: string }, body: Json): Promise<Response> {
  const shopId = String(body.shop_id ?? "");
  if (!(await member(deps, who.authorization, shopId))) return reply(403, { error: "not_member" });
  const origin = siteOrigin(body.return_url);
  if (!origin) return reply(400, { error: "bad_request" });
  const name = cleanDomain(String(body.domain ?? ""));
  const problem = nameProblem(name);
  if (problem) return reply(200, { state: "invalid", problem, domain: name });
  if (ourOwnHost(name, origin)) return reply(200, { state: "invalid", problem: "format", domain: name });
  if (!deps.vercel) return reply(503, { error: "not_configured" });
  const { data: id, error } = await deps.db.rpc("domain_connect_start", {
    p_shop_id: shopId, p_hostname: name, p_www: isApex(name), p_site_url: origin,
  });
  if (error) {
    if (error.code === "55000") return reply(200, { state: error.message.includes("Pro") ? "no_plan" : "has_domain", domain: name });
    if (error.code === "23505") return reply(200, { state: "in_use", domain: name });
    throw new Error(error.message);
  }
  await log(deps, String(id), "waiting_dns", true, "connect started");
  await runOne(deps, String(id));
  return reply(200, { state: "started", order_id: id, domain: name });
}

/** "Skontrolovať": the order's next step now (at most once every 30 seconds). */
async function recheckAction(deps: Deps, who: { authorization: string }, body: Json, admin = false): Promise<Response> {
  const id = String(body.order_id ?? "");
  const o = UUID.test(id) ? await load(deps, id) : null;
  if (!o || (!admin && !(await member(deps, who.authorization, o.shop_id)))) return reply(404, { error: "not_found" });
  if (!WORK.includes(o.status)) return reply(200, { status: o.status });
  if (!admin && o.last_check_at && deps.now() - Date.parse(o.last_check_at) < 30_000) return reply(429, { error: "too_soon" });
  await patch(deps, o.id, { next_attempt_at: iso(deps), ...(admin ? { attempts: 0 } : {}) });
  await runOne(deps, o.id);
  const fresh = await load(deps, o.id);
  return reply(200, { status: fresh?.status ?? o.status });
}

/** "Odpojiť doménu" (own domains): removed from Vercel; the website goes back to its Cacadoo address. */
async function disconnectAction(deps: Deps, who: { authorization: string }, body: Json): Promise<Response> {
  const id = String(body.order_id ?? "");
  const o = UUID.test(id) ? await load(deps, id) : null;
  if (!o || !(await member(deps, who.authorization, o.shop_id))) return reply(404, { error: "not_found" });
  if (o.kind !== "connected" || !OPEN.includes(o.status)) return reply(409, { error: "state" });
  const host = o.site_host ?? o.hostname;
  if (deps.vercel) {
    await deps.vercel.remove(host);
    if (o.www && isApex(host)) await deps.vercel.remove(`www.${host}`);
  }
  await patch(deps, o.id, { status: "ended", ended_at: iso(deps), next_attempt_at: null });
  await log(deps, o.id, "ended", true, "Disconnected by the owner");
  return reply(200, { status: "ended" });
}

/** The transfer code of a bought domain: always the shop's (never held back). */
async function authCodeAction(deps: Deps, who: { authorization: string }, body: Json, admin = false): Promise<Response> {
  const id = String(body.order_id ?? "");
  const o = UUID.test(id) ? await load(deps, id) : null;
  if (!o || (!admin && !(await member(deps, who.authorization, o.shop_id)))) return reply(404, { error: "not_found" });
  if (o.kind !== "bought" || !o.registrar_service_id || o.test_mode) return reply(409, { error: "state" });
  if (o.auth_code) return reply(200, { auth_code: o.auth_code });
  const code = deps.registrar ? await deps.registrar.authCode(o.registrar_service_id) : null;
  if (code) {
    await patch(deps, o.id, { auth_code: code });
    await log(deps, o.id, "auth code", true, null);
    return reply(200, { auth_code: code });
  }
  // Not given by the API: the admin gets it from Websupport and saves it on the admin page.
  await log(deps, o.id, "auth code", false, "Not in the API answer: asked the admin");
  await adminMail(deps, `Kód na prevod domény: ${o.hostname}`,
    `Obchod žiada kód na prevod domény ${o.hostname}. Websupport ho cez API neposlal: zistite ho v administrácii Websupportu a uložte v Predplatné a domény (Kód na prevod).`);
  return reply(200, { auth_code: null, requested: true });
}

/** The Pro price (from Stripe, STRIPE_PRICE_PRO), shown next to the domain to a shop without Pro. */
async function proPriceAction(deps: Deps, who: { authorization: string }, body: Json): Promise<Response> {
  if (!(await member(deps, who.authorization, String(body.shop_id ?? "")))) return reply(403, { error: "not_member" });
  if (!deps.stripe || !deps.prices.pro) return reply(503, { error: "not_configured" });
  const price = await deps.stripe<{ unit_amount?: number | null; currency?: string; recurring?: { interval?: string; interval_count?: number } | null; tax_behavior?: string | null }>(
    "GET", `/prices/${encodeURIComponent(deps.prices.pro)}`);
  return reply(200, {
    cents: price.unit_amount ?? null,
    currency: (price.currency ?? "eur").toUpperCase(),
    interval: price.recurring?.interval ?? null,
    interval_count: price.recurring?.interval_count ?? 1,
    vat_included: price.tax_behavior === "inclusive" ? true : price.tax_behavior === "exclusive" ? false : null,
  });
}

// ---------------------------------------------------------------- admin

async function isAdmin(deps: Deps, authorization: string): Promise<boolean> {
  const { data } = await deps.asCaller(authorization).rpc("is_admin");
  return data === true;
}

async function adminAction(action: string, deps: Deps, who: { authorization: string }, body: Json): Promise<Response> {
  if (!(await isAdmin(deps, who.authorization))) return reply(403, { error: "not_admin" });
  const id = String(body.order_id ?? "");
  switch (action) {
    case "admin_retry":
      return await recheckAction(deps, who, body, true);
    case "admin_email": {
      const o = UUID.test(id) ? await load(deps, id) : null;
      if (!o || o.status !== "live") return reply(409, { error: "state" });
      return reply(200, { sent: await sendLiveMail(deps, o, true) });
    }
    case "admin_auth_code":
      return await authCodeAction(deps, who, body, true);
    case "admin_save_auth_code": {
      const code = String(body.auth_code ?? "").replace(/[\x00-\x1f]/g, "").trim().slice(0, 100);
      if (!UUID.test(id) || !code) return reply(400, { error: "bad_request" });
      await patch(deps, id, { auth_code: code });
      await log(deps, id, "auth code", true, "saved by the admin");
      return reply(200, { saved: true });
    }
    case "admin_credit": {
      if (!deps.registrar) return reply(503, { error: "not_configured" });
      const credit = await deps.registrar.credit();
      await deps.db.rpc("domain_set_credit", { p_credit: credit });
      return reply(200, { credit });
    }
  }
  return reply(400, { error: "bad_request" });
}

// ---------------------------------------------------------------- entry

function sameSecret(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return reply(405, { error: "method" });
  let body: Json;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return reply(400, { error: "bad_request" });
  }
  const action = String(body?.action ?? "");
  try {
    const cron = req.headers.get("x-ppi-cron");
    if (cron !== null) {
      const { data: ok } = await deps.db.rpc("assistant_cron_ok", { p_secret: cron });
      if (ok !== true) return reply(401, { error: "secret" });
      if (action === "tick") return reply(200, await tick(deps));
      if (action === "daily") return reply(200, { ...(await daily(deps)), ...(await tick(deps)) });
      return reply(400, { error: "bad_request" });
    }
    if (action === "run") {
      // stripe-webhook after a confirmed payment: the service role key proves it.
      const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!sameSecret(bearer, deps.serviceKey)) return reply(401, { error: "secret" });
      const id = String(body.order_id ?? "");
      if (!UUID.test(id)) return reply(400, { error: "bad_request" });
      deps.background(runOne(deps, id).then(() => refundOrphan(deps, id)));
      return reply(202, { queued: true });
    }
    const who = await caller(req, deps);
    if (!who) return reply(401, { error: "login" });
    if (action.startsWith("admin_")) return await adminAction(action, deps, who, body);
    switch (action) {
      case "check":
        return await checkAction(deps, who, body);
      case "pay":
        return await payAction(deps, who, body);
      case "connect":
        return await connectAction(deps, who, body);
      case "recheck":
        return await recheckAction(deps, who, body);
      case "disconnect":
        return await disconnectAction(deps, who, body);
      case "auth_code":
        return await authCodeAction(deps, who, body);
      case "pro_price":
        return await proPriceAction(deps, who, body);
      case "cancel_payment":
        return await cancelPaymentAction(deps, who, body);
    }
    return reply(400, { error: "bad_request" });
  } catch (e) {
    console.error("domains:", action, failText(e).slice(0, 200));
    const status = e instanceof RegistrarError || e instanceof StripeError ? 502 : 500;
    // Stripe's and Websupport's own reasons hold no keys: the page may show them.
    const message = e instanceof RegistrarError || e instanceof StripeError ? e.message.slice(0, 200) : undefined;
    return reply(status, { error: e instanceof RegistrarError ? "registrar" : e instanceof StripeError ? "stripe" : "failed", message });
  }
}

export function handler(req: Request): Promise<Response> {
  const env = (name: string) => Deno.env.get(name)?.trim() || null;
  const url = env("SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return Promise.resolve(reply(500, { error: "config" }));
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const wsKey = env("WEBSUPPORT_API_KEY");
  const wsSecret = env("WEBSUPPORT_API_SECRET");
  const wsUser = env("WEBSUPPORT_USER_ID");
  const mode = env("REGISTRAR_MODE") === "live" ? "live" : "test";
  // *_API_BASE: only for local tests against stand-ins.
  const real = wsKey && wsSecret && wsUser ? websupport({ apiKey: wsKey, secret: wsSecret, userId: wsUser, base: env("WEBSUPPORT_API_BASE") ?? undefined }) : null;
  const vercelToken = env("VERCEL_API_TOKEN");
  const vercelProject = env("VERCEL_PROJECT_ID");
  const stripeKey = env("STRIPE_SECRET_KEY");
  const brevo = env("BREVO_API_KEY");
  const from = env("ALERT_EMAIL_FROM");
  return handle(req, {
    db: createClient(url, serviceKey, options),
    asCaller: (authorization) => createClient(url, anonKey, { ...options, global: { headers: { Authorization: authorization } } }),
    registrar: real ? (mode === "live" ? real : testRegistrar(real)) : null,
    vercel: vercelToken && vercelProject
      ? vercelApi({ token: vercelToken, projectId: vercelProject, teamId: env("VERCEL_TEAM_ID"), base: env("VERCEL_API_BASE") ?? undefined })
      : null,
    stripe: stripeKey ? stripeApi(stripeKey, fetch, env("STRIPE_API_BASE") ?? undefined) : null,
    prices: { pro: env("STRIPE_PRICE_PRO"), domain: env("STRIPE_PRICE_DOMAIN") },
    mode,
    email: brevo && from ? { apiKey: brevo, from } : null,
    adminEmail: env("ADMIN_EMAIL"),
    serviceKey,
    fetch,
    now: () => Date.now(),
    background: (task) => (runtime ? runtime.waitUntil(task) : void task),
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
