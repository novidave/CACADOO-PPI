/// <reference lib="deno.ns" />
// PPI · inventory-connect Edge Function
//
// "Pripojiť skladový program (API)" (database update 49): a shop links its inventory program with an API key and
// Cacaduu pulls its stock automatically — read only, from verified connectors only. One file, pasted into the Supabase
// editor with "Verify JWT" OFF: it checks every caller itself.
//
//   The shop's owners (their login; membership, the plan's rule and the provider checked in SQL):
//     connect   {shop_id, provider, credentials, settings} → the key is tested, kept ONLY encrypted, everything is
//               fetched once for the preview (nothing is published before the owner approves the mapping)
//     test      {shop_id}  "Otestovať pripojenie"
//     preview   {shop_id}  fetch again for the mapping step
//     sync_now  {shop_id}  "Synchronizovať teraz" (4 an hour, owner_inventory_sync_now)
//   ("Odpojiť" is owner_inventory_disconnect() in SQL: the key is deleted at once.)
//   The job (pg_cron ppi-inventory-tick every 5 min, header x-ppi-cron = the Vault secret ppi_inventory_cron):
//     tick      the due shops (inventory_claim), then one e-mail per key invalid for 24 hours
//
// A run: fetch everything → the same rows as a stock file (the approved mapping) → apply_stock_file() through
// inventory_apply() ONLY when the snapshot is provably complete (every page, the provider's total, no error). Partial,
// empty or failed data never sets anything to 0: the old stock stays and ages normally. Changed fields → the owner is
// asked again. Back-off and the e-mail are decided in SQL (inventory_finish, inventory_alerts_due).
//
// Connectors, each from the provider's official public API documentation (no others; Shoptet and Dotykačka are
// "Pripravujeme" until their documentation could be checked):
//   superfaktura  https://github.com/superfaktura/docs (intro.md: SFAPI header, base URLs, limit headers;
//                 stock.md: GET /stock_items/index.json with listinfo, page, per_page) — 1000 requests a day per account
//   woocommerce   https://woocommerce.github.io/woocommerce-rest-api-docs/ (source: github.com/woocommerce/
//                 woocommerce-rest-api-docs, wp-api-v3: _authentication.md read keys + HTTP Basic over HTTPS,
//                 _introduction.md X-WP-Total / X-WP-TotalPages, _products.md, _product-variations.md,
//                 _data.md /data/currencies/current)
//   custom        "Vlastné API": one JSON or CSV address of the shop's own system with its API key in a header
//
// Never: the key in a log, an error, a reply or the database unencrypted; purchase prices, suppliers, margins or
// internal comments stored (the adapters keep only the fields they list; any private-looking field is dropped before
// anything is stored); a write to the shop's inventory program (GET requests only).
//
// Secrets: INVENTORY_TOKEN_ENCRYPTION_KEY (32+ characters; required), BREVO_API_KEY + ALERT_EMAIL_FROM (the e-mail,
// optional), SITE_URL + REVALIDATE_SECRET + INDEXNOW_KEY (optional, as stock-pull).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// ---------------------------------------------------------------- types

export type Row = Record<string, string>;
export const MAPPING_FIELDS = ["source_code", "name", "ean", "brand", "quantity", "price", "currency", "description", "category"] as const;
export type MappingField = (typeof MAPPING_FIELDS)[number];
export type Mapping = Partial<Record<MappingField, string | null>>;
export type ProviderCode = "superfaktura" | "woocommerce" | "custom";
type Json = Record<string, unknown>;

/** What a connector says about itself (shown in the preview). */
export interface Capabilities {
  /** It can list every product, so a complete snapshot can be proven. */
  canFullSnapshot: boolean;
  hasQuantity: boolean;
  hasPrice: boolean;
  /** The fields it ever returns (nothing else is kept). */
  fields: string[];
}

/** One fetch of everything. `complete` only when every page came and the count matches the provider's total. */
export interface Listing {
  rows: Row[];
  complete: boolean;
  /** The provider's own count of products (null when it gives none). */
  total: number | null;
  /** The store's currency when the provider tells it. */
  currency: string | null;
  /** Why the listing is not complete (for the owner). */
  reason?: string;
}

export interface Context {
  credentials: Record<string, string>;
  settings: Record<string, string>;
  fetch: typeof fetch;
  /** Stop starting new requests after this moment (the listing is then incomplete). */
  deadline: number;
  now: () => number;
}

export interface Adapter {
  code: ProviderCode;
  name: string;
  docs: string;
  capabilities: Capabilities;
  /** The owner's form → what is secret (encrypted), what is not, and the key's last characters. */
  parse(input: { credentials?: unknown; settings?: unknown }): { credentials: Record<string, string>; settings: Record<string, string>; hint: string };
  testConnection(ctx: Context): Promise<void>;
  listProducts(ctx: Context): Promise<Listing>;
  proposeMapping(fields: string[], rows: Row[]): Mapping;
}

/** A failure the owner can act on; the message never holds a key or an address with a key. */
export class ConnectError extends Error {
  constructor(
    readonly code: "missing" | "url" | "invalid_key" | "not_found" | "network" | "timeout" | "rate_limited" | "bad_response" | "too_big" | "no_items",
    message: string,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- small helpers

const enc = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_BAD_SHARE = 0.05;
const USER_AGENT = "CacaduuPPI/1.0 (+inventory read-only)";
const REQUEST_MS = 30_000;
/** One run of the job stops starting new shops after this. */
const TICK_BUDGET_MS = 100_000;
/** One fetch of a shop may take this long; then it is incomplete (never applied). */
const RUN_MS = 90_000;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array {
  const b = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

/** Equal strings, compared in constant time. */
export function sameSecret(given: string | null, expected: string | null): boolean {
  if (!given || !expected || expected.length < 20) return false;
  const a = enc.encode(given);
  const b = enc.encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

const text = (value: unknown, max = 500) => (typeof value === "string" ? value.trim().slice(0, max) : typeof value === "number" ? String(value) : "");
const failText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/[\r\n]+/g, " ").slice(0, 300);

/** "ab12" from a key: its last 4 letters or digits ("••••ab12" in Môj obchod). */
export function keyHint(secret: string): string {
  return secret.replace(/[^A-Za-z0-9]/g, "").slice(-4);
}

/**
 * A field that points to purchase prices, suppliers, margins, invoices or internal notes — the same list as
 * is_private_column() in the database (+ the inventory programs' internal comments). Never kept.
 */
export function isPrivateField(name: string): boolean {
  const n = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /(nakup|purchase|cost|beszerz|dodavatel|supplier|vendor|lieferant|szallit|marz|margin|arres|haszon|zisk|profit|faktur|invoice|rechnung|szamla|internal)/
    .test(n) || /(^|[^\p{L}\p{N}_])nc($|[^\p{L}\p{N}_])/u.test(n);
}

/** Only the listed fields, never a private one. */
export function keepFields(row: Record<string, unknown>, fields: string[]): Row {
  const out: Row = {};
  for (const f of fields) {
    if (isPrivateField(f)) continue;
    const v = row[f];
    if (v === null || v === undefined || typeof v === "object") continue;
    out[f] = String(v).trim();
  }
  return out;
}

/** "12,90" · "1 234,50 €" · "1.234,5" · "1,234.50" · "12.9" → number; anything else → null (as stock-pull). */
export function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = String(value ?? "").replace(/[\s\u00a0\u202f']/g, "").replace(/[^\d.,+-]/g, "");
  if (!s || !/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    s = s.replace(/,(?=.*,)/g, "").replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** A public https address (no IP address, no local names, no user:password), else null (as partner-feeds). */
export function safeUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
  if (/\.(local|localhost|internal|intranet|lan|home|corp|arpa|test|invalid)$/.test(host)) return null;
  return url;
}

/** The address without its query (which may hold a key) — the only form an error may show. */
const shown = (url: URL) => `${url.origin}${url.pathname}`;

/**
 * One GET to the provider: a public https address (forwards checked, at most 3), a time limit, read only. Status →
 * the owner's reason: 401/403 key, 404 address, 429 limit (Retry-After), others network. Never puts the key in a
 * message.
 */
export async function getJson(ctx: Context, address: string, headers: Record<string, string>, opts: { csv?: boolean; maxBytes?: number } = {}) {
  const start = safeUrl(address);
  if (!start) throw new ConnectError("url", "The address is not a public https address.");
  let current: URL = start;
  if (ctx.now() > ctx.deadline) throw new ConnectError("timeout", "The inventory program answers too slowly.");
  for (let hop = 0; hop <= 3; hop++) {
    let res: Response;
    try {
      res = await ctx.fetch(current.href, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, Accept: opts.csv ? "text/csv, application/json, */*" : "application/json", ...headers },
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1_000, Math.min(REQUEST_MS, ctx.deadline - ctx.now()))),
      });
    } catch (e) {
      const timeout = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new ConnectError(timeout ? "timeout" : "network", timeout ? "The inventory program did not answer in time." : `The inventory program could not be reached (${shown(current)}).`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      const next: URL | null = location ? safeUrl(new URL(location, current).href) : null;
      if (!next) throw new ConnectError("url", "The address forwards to an address that is not public https.");
      current = next;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new ConnectError("invalid_key", `The inventory program refused the key (HTTP ${res.status}).`);
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw new ConnectError("not_found", `Nothing found at ${shown(current)} (HTTP 404).`);
    }
    if (res.status === 429) {
      const after = Number(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => {});
      throw new ConnectError("rate_limited", "The inventory program's request limit was reached.", Number.isFinite(after) && after > 0 ? Math.min(after, 86_400) : null);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ConnectError("network", `The inventory program answered HTTP ${res.status}.`);
    }
    const bytes = await readCapped(res, opts.maxBytes ?? MAX_BYTES);
    const body = new TextDecoder().decode(bytes);
    if (opts.csv) return { body, json: null as unknown, headers: res.headers };
    try {
      return { body, json: JSON.parse(body) as unknown, headers: res.headers };
    } catch {
      throw new ConnectError("bad_response", "The inventory program's answer is not JSON.");
    }
  }
  throw new ConnectError("url", "The address forwards too many times.");
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new ConnectError("too_big", `The answer is larger than ${Math.round(max / 1024 / 1024)} MB.`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- SuperFaktúra

/** SuperFaktúra's addresses (intro.md "Base URLs"). */
export const SUPERFAKTURA_BASES: Record<string, string> = {
  sk: "https://moja.superfaktura.sk",
  cz: "https://moje.superfaktura.cz",
  at: "https://meine.superfaktura.at",
  sandbox_sk: "https://sandbox.superfaktura.sk",
  sandbox_cz: "https://sandbox.superfaktura.cz",
};
const SF_PER_PAGE = 100;
/** Only these fields of a StockItem are ever kept (stock.md); purchase_*, internal_comment etc. never. */
const SF_FIELDS = ["id", "sku", "name", "description", "unit", "unit_price", "vat", "stock", "watch_stock", "modified"];

function sfHeader(credentials: Record<string, string>): string {
  const parts = [
    `email=${encodeURIComponent(credentials.email)}`,
    `apikey=${encodeURIComponent(credentials.apikey)}`,
    `module=${encodeURIComponent("Cacaduu PPI 1.0")}`,
  ];
  if (credentials.company_id) parts.push(`company_id=${encodeURIComponent(credentials.company_id)}`);
  return `SFAPI ${parts.join("&")}`;
}

/** One StockItem → a row; "price_with_vat" is unit_price with its VAT (labelled so in the preview). */
export function superfakturaRow(item: Record<string, unknown>): Row {
  const row = keepFields(item, SF_FIELDS);
  const unit = parseNumber(item.unit_price);
  const vat = parseNumber(item.vat);
  if (unit !== null) row.price_with_vat = (Math.round(unit * (1 + (vat ?? 0) / 100) * 100) / 100).toFixed(2);
  return row;
}

export function superfaktura(): Adapter {
  return {
    code: "superfaktura",
    name: "SuperFaktúra",
    docs: "https://github.com/superfaktura/docs/blob/master/stock.md",
    capabilities: { canFullSnapshot: true, hasQuantity: true, hasPrice: true, fields: [...SF_FIELDS, "price_with_vat"] },
    parse(input) {
      const c = (input.credentials ?? {}) as Json;
      const st = (input.settings ?? {}) as Json;
      const email = text(c.email, 200);
      const apikey = text(c.apikey, 200);
      const companyId = text(c.company_id, 20);
      const country = text(st.country, 20) || "sk";
      if (!email || !apikey) throw new ConnectError("missing", "E-mail and API key are needed.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[A-Za-z0-9]{8,100}$/.test(apikey)) throw new ConnectError("missing", "E-mail or API key look wrong.");
      if (companyId && !/^\d{1,12}$/.test(companyId)) throw new ConnectError("missing", "The company ID is a number.");
      if (!SUPERFAKTURA_BASES[country]) throw new ConnectError("missing", "Unknown SuperFaktúra country.");
      return { credentials: { email, apikey, ...(companyId ? { company_id: companyId } : {}) }, settings: { country }, hint: keyHint(apikey) };
    },
    async testConnection(ctx) {
      const base = SUPERFAKTURA_BASES[ctx.settings.country] ?? SUPERFAKTURA_BASES.sk;
      const { json } = await getJson(ctx, `${base}/stock_items/index.json/listinfo:1/page:1/per_page:1`, { Authorization: sfHeader(ctx.credentials) });
      if (!json || typeof json !== "object" || !("itemCount" in (json as Json))) {
        throw new ConnectError("bad_response", "SuperFaktúra did not return the stock list.");
      }
    },
    async listProducts(ctx) {
      const base = SUPERFAKTURA_BASES[ctx.settings.country] ?? SUPERFAKTURA_BASES.sk;
      const rows: Row[] = [];
      let total: number | null = null;
      let pages = 1;
      for (let page = 1; page <= pages; page++) {
        if (ctx.now() > ctx.deadline) return { rows, complete: false, total, currency: null, reason: "time" };
        const { json, headers } = await getJson(ctx, `${base}/stock_items/index.json/listinfo:1/page:${page}/per_page:${SF_PER_PAGE}`, {
          Authorization: sfHeader(ctx.credentials),
        });
        const data = json as { itemCount?: unknown; pageCount?: unknown; items?: { StockItem?: Record<string, unknown> }[] };
        if (!data || !Array.isArray(data.items)) throw new ConnectError("bad_response", "SuperFaktúra did not return the stock list.");
        total = Number(data.itemCount);
        pages = Math.max(1, Number(data.pageCount) || 1);
        for (const it of data.items) if (it?.StockItem) rows.push(superfakturaRow(it.StockItem));
        // 1000 requests a day per account (faq.md): stop before the limit, never half a list
        const remaining = headers.get("x-ratelimit-dailyremaining");
        const left = remaining === null || remaining.trim() === "" ? NaN : Number(remaining);
        if (Number.isFinite(left) && left < pages - page) {
          throw new ConnectError("rate_limited", "SuperFaktúra's daily request limit would be reached.", 6 * 3600);
        }
        if (rows.length > MAX_ROWS) throw new ConnectError("too_big", "More than 50 000 items.");
      }
      const complete = Number.isFinite(total) && rows.length === total;
      return { rows, complete, total: Number.isFinite(total) ? total : null, currency: null, reason: complete ? undefined : "count" };
    },
    proposeMapping(_fields, rows) {
      const withSku = rows.filter((r) => r.sku).length;
      return {
        source_code: withSku >= rows.length * 0.9 && withSku > 0 ? "sku" : "id",
        name: "name",
        quantity: "stock",
        price: "price_with_vat",
        description: "description",
      };
    },
  };
}

// ---------------------------------------------------------------- WooCommerce

const WC_PER_PAGE = 100;
/** Only these fields of a product or variation are kept (_products.md); meta_data (plugins' costs) never. */
const WC_FIELDS = ["id", "parent_id", "sku", "name", "global_unique_id", "price", "regular_price", "stock_quantity", "stock_status", "manage_stock", "categories", "type"];
const WC_REQUEST_FIELDS = "id,sku,name,global_unique_id,price,regular_price,stock_quantity,stock_status,manage_stock,categories,type,status,attributes";

function wcAuth(credentials: Record<string, string>): string {
  return `Basic ${btoa(`${credentials.consumer_key}:${credentials.consumer_secret}`)}`;
}

/** A product (or a variation of `parent`) → a row: categories as one text, a variation named "Product – Option". */
export function wooRow(product: Record<string, unknown>, parent?: Record<string, unknown>): Row {
  const categories = Array.isArray(product.categories)
    ? (product.categories as { name?: string }[]).map((c) => c?.name).filter(Boolean).join(", ")
    : parent && Array.isArray(parent.categories)
    ? (parent.categories as { name?: string }[]).map((c) => c?.name).filter(Boolean).join(", ")
    : "";
  let name = typeof product.name === "string" ? product.name : "";
  if (parent) {
    const options = Array.isArray(product.attributes) ? (product.attributes as { option?: string }[]).map((a) => a?.option).filter(Boolean) : [];
    name = [String(parent.name ?? ""), options.join(", ")].filter(Boolean).join(" – ");
  }
  const row = keepFields({ ...product, name, categories, parent_id: parent ? parent.id : product.parent_id ?? "" }, WC_FIELDS);
  if (product.stock_quantity === null || product.stock_quantity === undefined) delete row.stock_quantity;
  return row;
}

export function woocommerce(): Adapter {
  const base = (settings: Record<string, string>) => settings.store_url.replace(/\/+$/, "");
  return {
    code: "woocommerce",
    name: "WooCommerce",
    docs: "https://woocommerce.github.io/woocommerce-rest-api-docs/#list-all-products",
    capabilities: { canFullSnapshot: true, hasQuantity: true, hasPrice: true, fields: WC_FIELDS },
    parse(input) {
      const c = (input.credentials ?? {}) as Json;
      const st = (input.settings ?? {}) as Json;
      const url = safeUrl(text(st.store_url, 300));
      const key = text(c.consumer_key, 200);
      const secret = text(c.consumer_secret, 200);
      if (!url) throw new ConnectError("url", "The shop's address must be a public https address.");
      if (!/^ck_[A-Za-z0-9]{10,}$/.test(key) || !/^cs_[A-Za-z0-9]{10,}$/.test(secret)) throw new ConnectError("missing", "Consumer key (ck_…) and secret (cs_…) are needed.");
      return { credentials: { consumer_key: key, consumer_secret: secret }, settings: { store_url: url.origin + url.pathname.replace(/\/+$/, "") }, hint: keyHint(secret) };
    },
    async testConnection(ctx) {
      const { headers } = await getJson(ctx, `${base(ctx.settings)}/wp-json/wc/v3/products?per_page=1&_fields=id`, { Authorization: wcAuth(ctx.credentials) });
      if (headers.get("x-wp-total") === null) throw new ConnectError("bad_response", "The address does not answer as a WooCommerce shop.");
    },
    async listProducts(ctx) {
      const auth = { Authorization: wcAuth(ctx.credentials) };
      const rows: Row[] = [];
      let currency: string | null = null;
      try {
        const { json } = await getJson(ctx, `${base(ctx.settings)}/wp-json/wc/v3/data/currencies/current`, auth);
        const code = (json as { code?: unknown })?.code;
        if (typeof code === "string" && /^[A-Z]{3}$/.test(code)) currency = code;
      } catch (e) {
        if (e instanceof ConnectError && (e.code === "invalid_key" || e.code === "rate_limited")) throw e;
      }
      let total: number | null = null;
      let pages = 1;
      let expected = 0;
      for (let page = 1; page <= pages; page++) {
        if (ctx.now() > ctx.deadline) return { rows, complete: false, total, currency, reason: "time" };
        const { json, headers } = await getJson(
          ctx,
          `${base(ctx.settings)}/wp-json/wc/v3/products?status=publish&per_page=${WC_PER_PAGE}&page=${page}&orderby=id&order=asc&_fields=${WC_REQUEST_FIELDS}`,
          auth,
        );
        if (!Array.isArray(json)) throw new ConnectError("bad_response", "WooCommerce did not return a product list.");
        total = Number(headers.get("x-wp-total"));
        pages = Math.max(1, Number(headers.get("x-wp-totalpages")) || 1);
        for (const product of json as Record<string, unknown>[]) {
          expected++;
          if (product.type !== "variable") {
            rows.push(wooRow(product));
            continue;
          }
          // a variable product: its variations are the items with their own stock
          let vPages = 1;
          for (let vp = 1; vp <= vPages; vp++) {
            if (ctx.now() > ctx.deadline) return { rows, complete: false, total, currency, reason: "time" };
            const v = await getJson(ctx, `${base(ctx.settings)}/wp-json/wc/v3/products/${encodeURIComponent(String(product.id))}/variations?per_page=${WC_PER_PAGE}&page=${vp}`, auth);
            if (!Array.isArray(v.json)) throw new ConnectError("bad_response", "WooCommerce did not return the variations.");
            vPages = Math.max(1, Number(v.headers.get("x-wp-totalpages")) || 1);
            for (const variation of v.json as Record<string, unknown>[]) rows.push(wooRow(variation, product));
          }
        }
        if (rows.length > MAX_ROWS) throw new ConnectError("too_big", "More than 50 000 items.");
      }
      const complete = Number.isFinite(total) && expected === total;
      return { rows, complete, total: Number.isFinite(total) ? total : null, currency, reason: complete ? undefined : "count" };
    },
    proposeMapping(_fields, rows) {
      const withSku = rows.filter((r) => r.sku).length;
      return {
        source_code: withSku >= rows.length * 0.9 && withSku > 0 ? "sku" : "id",
        name: "name",
        ean: "global_unique_id",
        quantity: "stock_quantity",
        price: "price",
        category: "categories",
      };
    },
  };
}

// ---------------------------------------------------------------- "Vlastné API" (JSON or CSV address)

/** CSV with ; , tab or | as separator (from the header line) and "quoted" fields (as stock-pull). */
export function parseCsv(body: string): Row[] {
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [";", ",", "\t", "|"].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }
  const rows = records.filter((r) => r.some((v) => v.trim() !== ""));
  if (rows.length < 2) return [];
  const seen = new Map<string, number>();
  const headers = rows[0].map((h, i) => {
    const b = h.replace(/^\uFEFF/, "").trim() || `column_${i + 1}`;
    const n = (seen.get(b) ?? 0) + 1;
    seen.set(b, n);
    return n === 1 ? b : `${b}_${n}`;
  });
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
}

/** Leaf values of one record, nested names joined with "/" (only the first element of a list). */
export function flatten(value: unknown, prefix = "", out: Row = {}): Row {
  if (value === null || value === undefined) return out;
  if (typeof value !== "object") {
    if (prefix) out[prefix] = String(value).trim();
    return out;
  }
  if (Array.isArray(value)) {
    value.slice(0, 1).forEach((v) => flatten(v, prefix, out));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}/${k}` : k, out);
  return out;
}

/** The product list in a JSON answer: the array itself, the one at `path` ("data.products"), or the largest one. */
export function jsonItems(json: unknown, path: string): unknown[] | null {
  let node: unknown = json;
  if (path) {
    for (const part of path.split(".").filter(Boolean)) node = node && typeof node === "object" ? (node as Json)[part] : undefined;
    return Array.isArray(node) ? node : null;
  }
  if (Array.isArray(json)) return json;
  // the largest list of objects up to three levels down ({"data": {"products": [...]}})
  let best: unknown[] | null = null;
  const look = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 3) return;
    for (const value of Object.values(node as Json)) {
      if (Array.isArray(value)) {
        if (value.some((v) => v && typeof v === "object") && (!best || value.length > best.length)) best = value;
      } else look(value, depth + 1);
    }
  };
  look(json, 1);
  return best;
}

/** Rows without private-looking fields (their values never leave this function). */
export function publicRows(rows: Row[]): Row[] {
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !isPrivateField(k))));
}

function normalize(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Hints for a proposal from field names (as stock-pull's guessMapping); only proposed, the owner approves. */
const HINTS: Record<MappingField, string[]> = {
  source_code: ["kod", "kodtovaru", "plu", "code", "sku", "artikel", "artnr", "cislo", "cikkszam", "id", "katalog"],
  name: ["nazov", "nazev", "name", "nev", "megnevezes", "title", "bezeichnung", "tovar", "text"],
  ean: ["ean", "barcode", "gtin", "carovykod", "vonalkod", "ean13"],
  brand: ["znacka", "brand", "vyrobca", "vyrobce", "marka", "gyarto", "hersteller"],
  quantity: ["mnozstvo", "mnozstvi", "stav", "zasoba", "qty", "quantity", "pocet", "stock", "keszlet", "mennyiseg", "bestand", "ks"],
  price: ["cenasdph", "predajnacena", "cena", "price", "eladasiar", "ar", "preis", "mocena", "pc"],
  currency: ["mena", "currency", "penznem", "wahrung", "waehrung"],
  description: ["popis", "description", "leiras", "beschreibung", "opis", "desc"],
  category: ["kategoria", "kategorie", "category", "csoport", "skupina", "warengruppe", "group"],
};

export function guessMapping(fields: string[]): Mapping {
  const used = new Set<string>();
  const mapping: Mapping = {};
  for (const field of MAPPING_FIELDS) {
    let best: { col: string; score: number } | null = null;
    for (const col of fields) {
      if (used.has(col) || isPrivateField(col)) continue;
      const n = normalize(col.split("/").pop() ?? col);
      HINTS[field].forEach((hint, rank) => {
        const score = n === hint ? 300 - rank : n.startsWith(hint) ? 200 - rank : n.includes(hint) && hint.length > 2 ? 100 - rank : 0;
        if (score > 0 && (!best || score > best.score)) best = { col, score };
      });
    }
    if (best) {
      mapping[field] = (best as { col: string }).col;
      used.add((best as { col: string }).col);
    }
  }
  return mapping;
}

export function custom(): Adapter {
  const read = async (ctx: Context) => {
    const headers: Record<string, string> = {};
    if (ctx.credentials.header_name && ctx.credentials.header_value) headers[ctx.credentials.header_name] = ctx.credentials.header_value;
    const format = ctx.settings.format || "auto";
    const { body, json } = await getJson(ctx, ctx.credentials.url, headers, { csv: format !== "json" });
    let rows: Row[];
    const trimmed = body.trimStart();
    if (format === "json" || (format === "auto" && (trimmed.startsWith("[") || trimmed.startsWith("{")))) {
      let parsed: unknown = json;
      if (parsed === null) {
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new ConnectError("bad_response", "The answer is not JSON.");
        }
      }
      const items = jsonItems(parsed, ctx.settings.items_path ?? "");
      if (!items) throw new ConnectError("bad_response", "No product list found in the JSON answer.");
      rows = items.map((item) => flatten(item));
    } else {
      rows = parseCsv(body);
    }
    if (rows.length > MAX_ROWS) throw new ConnectError("too_big", "More than 50 000 items.");
    return publicRows(rows);
  };
  return {
    code: "custom",
    name: "Vlastné API",
    docs: "",
    capabilities: { canFullSnapshot: true, hasQuantity: true, hasPrice: true, fields: [] },
    parse(input) {
      const c = (input.credentials ?? {}) as Json;
      const st = (input.settings ?? {}) as Json;
      const url = safeUrl(text(c.url, 1000));
      const headerName = text(c.header_name, 60);
      const headerValue = text(c.header_value, 500);
      const format = ["auto", "json", "csv"].includes(text(st.format, 10)) ? text(st.format, 10) : "auto";
      const itemsPath = text(st.items_path, 100);
      if (!url) throw new ConnectError("url", "The address must be a public https address.");
      if (headerName && !/^[A-Za-z][A-Za-z0-9-]{1,59}$/.test(headerName)) throw new ConnectError("missing", "The header name is not valid.");
      if (headerName && /^(host|cookie|content-length|transfer-encoding|connection)$/i.test(headerName)) throw new ConnectError("missing", "The header name is not allowed.");
      if (headerName && !headerValue) throw new ConnectError("missing", "The key for the header is missing.");
      if (itemsPath && !/^[A-Za-z0-9_.-]{1,100}$/.test(itemsPath)) throw new ConnectError("missing", "The list path is not valid.");
      const secret = headerValue || url.search;
      return {
        // the address may hold the key in its query: it is kept encrypted, only its host is shown
        credentials: { url: url.href, ...(headerName ? { header_name: headerName, header_value: headerValue } : {}) },
        settings: { host: url.hostname, format, ...(itemsPath ? { items_path: itemsPath } : {}) },
        hint: keyHint(secret),
      };
    },
    async testConnection(ctx) {
      const rows = await read(ctx);
      if (!rows.length) throw new ConnectError("no_items", "The address returned no products.");
    },
    async listProducts(ctx) {
      // one document = the whole list: complete when it was read whole (size limit, no error) and is not empty
      const rows = await read(ctx);
      return { rows, complete: rows.length > 0, total: rows.length, currency: null, reason: rows.length ? undefined : "empty" };
    },
    proposeMapping(fields) {
      return guessMapping(fields);
    },
  };
}

export const ADAPTERS: Record<ProviderCode, Adapter> = { superfaktura: superfaktura(), woocommerce: woocommerce(), custom: custom() };

// ---------------------------------------------------------------- from rows to stock

export interface StockRow {
  source_code: string;
  name: string;
  ean: string | null;
  brand: string | null;
  quantity: number | null;
  price: number;
  currency: string;
}

/** The fields the rows have, in a stable order, never a private one. */
export function fieldsOf(rows: Row[]): string[] {
  const seen = new Set<string>();
  for (const r of rows.slice(0, 2000)) for (const k of Object.keys(r)) if (!isPrivateField(k)) seen.add(k);
  return [...seen].sort();
}

/** A connector with a fixed list of fields gives always the same list (an empty value never "changes" the fields). */
export function fieldsFor(adapter: Adapter, rows: Row[]): string[] {
  return adapter.capabilities.fields.length
    ? adapter.capabilities.fields.filter((f) => !isPrivateField(f)).sort()
    : fieldsOf(rows);
}

/** The rows → stock rows with the approved mapping; rows without code, name, price (or quantity) are counted bad. */
export function applyMapping(rows: Row[], mapping: Mapping, currency: string, withoutQuantity: boolean) {
  const good: StockRow[] = [];
  const texts: { source_code: string; description: string | null; category: string | null; has_texts: boolean; i18n: Json }[] = [];
  const hasTexts = Boolean(mapping.description || mapping.category);
  let bad = 0;
  for (const row of rows) {
    const code = mapping.source_code ? row[mapping.source_code]?.trim() : "";
    const name = mapping.name ? row[mapping.name]?.trim() : "";
    const quantity = mapping.quantity ? parseNumber(row[mapping.quantity]) : null;
    const price = mapping.price ? parseNumber(row[mapping.price]) : null;
    if (!code || !name || price === null || price < 0 || (!withoutQuantity && quantity === null)) {
      bad++;
      continue;
    }
    const cur = (mapping.currency ? row[mapping.currency]?.trim().toUpperCase() : "") || currency;
    good.push({
      source_code: code,
      name,
      ean: mapping.ean ? row[mapping.ean]?.replace(/\s/g, "") || null : null,
      brand: mapping.brand ? row[mapping.brand]?.trim() || null : null,
      quantity: withoutQuantity ? null : quantity,
      price,
      currency: /^[A-Z]{3}$/.test(cur) ? cur : currency,
    });
    if (hasTexts) {
      texts.push({
        source_code: code,
        description: mapping.description ? row[mapping.description]?.trim() || null : null,
        category: mapping.category ? row[mapping.category]?.trim() || null : null,
        has_texts: true,
        i18n: {},
      });
    }
  }
  return { good, bad, texts };
}

/** The currency to assume when the provider gives none (as stock-pull). */
export function currencyForCountry(country: string | null | undefined): string {
  const map: Record<string, string> = {
    HU: "HUF", CZ: "CZK", PL: "PLN", RO: "RON", CH: "CHF", LI: "CHF", GB: "GBP", SE: "SEK", DK: "DKK",
    NO: "NOK", IS: "ISK", RS: "RSD", BA: "BAM", MK: "MKD", AL: "ALL", MD: "MDL", UA: "UAH", TR: "TRY",
  };
  return map[(country ?? "").toUpperCase()] ?? "EUR";
}

/** The mapped fields of the first rows (the report and the owner's example rows), never a private one. */
export function sampleRows(rows: Row[], mapping: Mapping | null, limit = 5): Row[] {
  const cols = mapping ? [...new Set(Object.values(mapping).filter((c): c is string => Boolean(c)))] : [];
  return rows.slice(0, limit).map((r) => Object.fromEntries(cols.filter((c) => c in r && !isPrivateField(c)).map((c) => [c, r[c]])));
}

/** Whether the provider sends quantities at all (some rows have a number in the proposed quantity field). */
export function hasQuantities(rows: Row[], mapping: Mapping): boolean {
  const q = mapping.quantity;
  return Boolean(q) && rows.some((r) => parseNumber(r[q as string]) !== null);
}

// ---------------------------------------------------------------- the key, encrypted

/** AES-GCM key from INVENTORY_TOKEN_ENCRYPTION_KEY (32+ characters; HKDF-SHA-256). */
export async function cryptoKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("INVENTORY_TOKEN_ENCRYPTION_KEY must have at least 32 characters");
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("ppi-inventory-connect"), info: enc.encode("credentials v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Ties the encrypted key to its shop and provider: the same text for another shop does not open. */
export const bindOf = (shopId: string, provider: string) => `inventory:${shopId}:${provider}`;

export async function encryptCredentials(key: CryptoKey, credentials: Record<string, string>, bind: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: enc.encode(bind) }, key, enc.encode(JSON.stringify(credentials)));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(data))}`;
}

export async function decryptCredentials(key: CryptoKey, cipher: string, bind: string): Promise<Record<string, string>> {
  const [version, iv, data] = cipher.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("unknown key format");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(iv) as BufferSource, additionalData: enc.encode(bind) },
    key,
    fromB64url(data) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------------------------------------------------------------- dependencies

export interface Deps {
  db: SupabaseClient;
  asCaller: (authorization: string) => SupabaseClient;
  adapters: Partial<Record<string, Adapter>>;
  secret: string | null;
  fetch: typeof fetch;
  background(task: Promise<unknown>): void;
  now: () => number;
  email: { apiKey: string; from: string } | null;
  site: { url: string | null; revalidateSecret: string | null; indexNowKey: string | null };
}

/** The owner's browser calls this function directly (another origin): every answer carries the CORS headers. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
}

const contextOf = (deps: Deps, credentials: Record<string, string>, settings: Record<string, string>, ms = RUN_MS): Context => ({
  credentials,
  settings,
  fetch: deps.fetch,
  deadline: deps.now() + ms,
  now: deps.now,
});

const errorOut = (e: unknown) =>
  e instanceof ConnectError
    ? { code: e.code, message: e.message, retry_after: e.retryAfter }
    : { code: "failed", message: "Unexpected error while reading the inventory program.", retry_after: null };

// ---------------------------------------------------------------- the preview

/** Saves the fields, first rows (no private field), the count and a proposed mapping. */
async function savePreview(deps: Deps, shopId: string, adapter: Adapter, listing: Listing) {
  const rows = publicRows(listing.rows);
  const fields = fieldsFor(adapter, rows);
  const proposal = adapter.proposeMapping(fields, rows);
  const { data, error } = await deps.db.rpc("inventory_save_preview", {
    p_shop_id: shopId,
    p_fields: fields,
    p_sample: rows.slice(0, 5),
    p_count: listing.total ?? rows.length,
    p_has_quantity: hasQuantities(rows, proposal),
    p_proposal: proposal,
  });
  if (error) throw new Error(`preview not saved: ${error.message}`);
  return String(data);
}

// ---------------------------------------------------------------- one run

interface Due {
  shop_id: string;
  provider: string;
  shop_country: string | null;
}

/** One shop's run: fetch, check, apply only a complete snapshot, report, finish. Never throws. */
export async function runOne(deps: Deps, due: Due): Promise<Json> {
  const finish = async (outcome: Json) => {
    await deps.db.rpc("inventory_finish", { p_shop_id: due.shop_id, p_outcome: outcome });
    return outcome;
  };
  const record = async (status: "ok" | "errors", counts: { total: number; imported: number; zeroed: number; skipped: number }, error: string | null, rows: Row[], time: Date) => {
    await deps.db.rpc("inventory_record_import", {
      p_shop_id: due.shop_id,
      p_name: `API · ${deps.adapters[due.provider]?.name ?? due.provider}`,
      p_source_time: time.toISOString(),
      p_status: status,
      p_total: counts.total,
      p_imported: counts.imported,
      p_zeroed: counts.zeroed,
      p_skipped: counts.skipped,
      p_error: error,
      p_rows: rows,
    });
  };
  try {
    const adapter = deps.adapters[due.provider];
    if (!adapter || !deps.secret) return await finish({ kind: "error", code: "config", message: "The connector is not available." });
    const { data, error } = await deps.db.rpc("inventory_key", { p_shop_id: due.shop_id });
    const conn = (Array.isArray(data) ? data[0] : data) as
      | { key_cipher: string; settings: Record<string, string>; mapping: Mapping | null; publish_without_quantity: boolean; fields: string[] }
      | undefined;
    if (error || !conn) return { kind: "skipped" };
    const credentials = await decryptCredentials(await cryptoKey(deps.secret), conn.key_cipher, bindOf(due.shop_id, due.provider));
    const fetchedAt = new Date(deps.now());
    const listing = await adapter.listProducts(contextOf(deps, credentials, conn.settings ?? {}));
    const rows = publicRows(listing.rows);

    // the fields changed: the owner is asked again (never approved by itself), nothing applied
    if (fieldsFor(adapter, rows).join("|") !== [...(conn.fields ?? [])].sort().join("|")) {
      const result = await savePreview(deps, due.shop_id, adapter, listing);
      if (result === "changed") {
        return await finish({ kind: "warning", code: "fields_changed", message: "The inventory program's fields changed: check and approve them again." });
      }
    }
    if (!listing.complete) {
      const message = listing.reason === "time"
        ? "Not every product could be read in time: the previous stock is kept."
        : `The inventory program returned ${rows.length} of ${listing.total ?? "?"} products: the previous stock is kept.`;
      await record("errors", { total: rows.length, imported: 0, zeroed: 0, skipped: 0 }, message, [], fetchedAt);
      return await finish({ kind: "warning", code: "incomplete", message, items: rows.length, total: listing.total });
    }
    const mapping = conn.mapping ?? {};
    const { good, bad, texts } = applyMapping(rows, mapping, listing.currency ?? currencyForCountry(due.shop_country), conn.publish_without_quantity);
    if (good.length === 0 || bad / rows.length > MAX_BAD_SHARE) {
      const message = `${bad} of ${rows.length} products could not be read with the approved fields: the previous stock is kept.`;
      await record("errors", { total: rows.length, imported: 0, zeroed: 0, skipped: bad }, message, [], fetchedAt);
      return await finish({ kind: "warning", code: "layout", message, items: rows.length });
    }
    const sample = sampleRows(rows, mapping);
    const { data: applied, error: applyError } = await deps.db.rpc("inventory_apply", {
      p_shop_id: due.shop_id,
      p_rows: good,
      p_source_time: fetchedAt.toISOString(),
      p_sample: sample,
    });
    if (applyError) throw new Error(`saving the stock failed: ${applyError.message}`);
    const result = applied as { status: string; items?: number; zeroed?: number; changed?: number };
    if (result.status !== "updated") {
      return await finish({ kind: "warning", code: result.status, message: "Nothing was applied." });
    }
    for (let i = 0; i < texts.length; i += 2000) {
      const { error: textError } = await deps.db.rpc("apply_file_texts", { p_shop_id: due.shop_id, p_rows: texts.slice(i, i + 2000) });
      if (textError) console.warn("inventory-connect: texts not saved");
    }
    await record(bad > 0 ? "errors" : "ok", { total: rows.length, imported: result.items ?? good.length, zeroed: result.zeroed ?? 0, skipped: bad }, null, sample, fetchedAt);
    await afterUpdate(deps, due.shop_id);
    return await finish({ kind: "ok", items: good.length, changed: result.changed ?? 0, zeroed: result.zeroed ?? 0, skipped: bad, total: rows.length });
  } catch (e) {
    const out = errorOut(e);
    console.error("inventory-connect: run", due.provider, out.code);
    return await finish({ kind: "error", ...out });
  }
}

/** After applied stock: the website's cache and IndexNow (as stock-pull); failures only mean "within the minute". */
async function afterUpdate(deps: Deps, shopId: string) {
  const { data: shop } = await deps.db.from("shops").select("slug").eq("id", shopId).maybeSingle();
  const slug = (shop as { slug?: string } | null)?.slug;
  if (deps.site.url && deps.site.revalidateSecret && slug) {
    await deps.fetch(`${deps.site.url}/api/revalidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ppi-revalidate": deps.site.revalidateSecret },
      body: JSON.stringify({ slug }),
      signal: AbortSignal.timeout(5_000),
    }).then((r) => r.body?.cancel()).catch(() => {});
  }
  if (deps.site.indexNowKey && deps.site.url) {
    const mainHost = new URL(deps.site.url).hostname;
    const { data } = await deps.db.rpc("indexnow_claim_host", { p_shop_id: shopId, p_main_host: mainHost, p_max_items: 3333 });
    const claim = data as { host: string; kind: string; items?: { id: string }[]; lang?: string | null; upto?: string; upto_id?: string; skip?: string } | null;
    if (!claim || claim.skip || !claim.items?.length) return;
    const langs = claim.kind === "site" && claim.lang ? [claim.lang, ...["sk", "hu", "en"].filter((l) => l !== claim.lang)] : ["sk", "hu", "en"];
    const urls = claim.items.filter((i) => UUID.test(i.id)).flatMap((i) => langs.map((l) => `https://${claim.host}/${l}/items/${i.id}`)).slice(0, 10_000);
    let status: number | null = null;
    let result = "failed";
    try {
      const res = await deps.fetch("https://api.indexnow.org/indexnow", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: claim.host, key: deps.site.indexNowKey, keyLocation: `https://${claim.host}/${deps.site.indexNowKey}.txt`, urlList: urls }),
        signal: AbortSignal.timeout(15_000),
      });
      status = res.status;
      result = String(res.status);
      await res.body?.cancel().catch(() => {});
    } catch {
      // sent again with the next ping
    }
    await deps.db.rpc("indexnow_done", {
      p_host: claim.host, p_kind: claim.kind, p_upto: claim.upto ?? null, p_upto_id: claim.upto_id ?? null,
      p_urls: urls.length, p_status: status, p_result: result,
    });
  }
}

// ---------------------------------------------------------------- the job

export const ALERT_SUBJECT = "Kľúč k skladovému programu je neplatný – sklad sa neaktualizuje";

export function alertText(alert: { shop_name: string; provider: string }, providerName: string): string {
  return [
    "Dobrý deň,",
    "",
    `Cacaduu PPI sa už 24 hodín nevie pripojiť k programu ${providerName} obchodu ${alert.shop_name}: kľúč API je neplatný alebo bol zrušený.`,
    "Sklad na vašej stránke sa preto neaktualizuje; zákazníci vidia posledné údaje s ich časom.",
    "",
    "Čo urobiť: Môj obchod → Priečinok s exportom → Pripojiť skladový program → „Zmeniť kľúč“ (vytvorte nový kľúč len na čítanie).",
    "",
    "Cacaduu PPI",
  ].join("\n");
}

async function sendAlerts(deps: Deps): Promise<number> {
  const { data } = await deps.db.rpc("inventory_alerts_due");
  const due = (data ?? []) as { shop_id: string; shop_name: string; provider: string; emails: string[] }[];
  if (!due.length) return 0;
  if (!deps.email) {
    console.error("inventory-connect: alert e-mail not sent (BREVO_API_KEY or ALERT_EMAIL_FROM missing)");
    return 0;
  }
  let sent = 0;
  for (const alert of due) {
    if (!alert.emails.length) continue;
    const res = await deps.fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": deps.email.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { name: "Cacaduu PPI", email: deps.email.from },
        to: alert.emails.map((email) => ({ email })),
        subject: ALERT_SUBJECT,
        textContent: alertText(alert, deps.adapters[alert.provider]?.name ?? alert.provider),
      }),
    }).catch(() => null);
    if (res?.ok) {
      await deps.db.rpc("inventory_alert_sent", { p_shop_id: alert.shop_id });
      sent++;
    } else {
      console.error("inventory-connect: alert e-mail failed", res?.status ?? "network");
    }
  }
  return sent;
}

/** The due shops, one after another, until the time budget is used (the rest wait for the next tick). */
export async function tick(deps: Deps, shopId: string | null = null): Promise<Json> {
  const started = deps.now();
  const results: Json[] = [];
  while (deps.now() - started < TICK_BUDGET_MS) {
    const { data, error } = await deps.db.rpc("inventory_claim", { p_limit: 1, p_shop_id: shopId });
    const due = (data ?? []) as Due[];
    if (error || !due.length) break;
    results.push({ provider: due[0].provider, ...(await runOne(deps, due[0])) });
    if (shopId) break;
  }
  return { runs: results.length, ok: results.filter((r) => r.kind === "ok").length };
}

// ---------------------------------------------------------------- owners

async function owner(req: Request, deps: Deps): Promise<string | null> {
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data } = await deps.asCaller(authorization).auth.getUser(token);
  return data?.user ? authorization : null;
}

async function ownerAction(action: string, req: Request, deps: Deps, body: Json): Promise<Response> {
  const authorization = await owner(req, deps);
  if (!authorization) return reply(401, { error: "login" });
  const shopId = String(body.shop_id ?? "");
  if (!UUID.test(shopId)) return reply(400, { error: "bad_request" });
  const caller = deps.asCaller(authorization);
  const { data: member } = await caller.rpc("is_shop_member", { p_shop_id: shopId });
  if (member !== true) return reply(403, { error: "not_member" });
  if (!deps.secret) return reply(503, { error: "config" });
  const key = await cryptoKey(deps.secret);

  if (action === "connect") {
    const provider = String(body.provider ?? "");
    const adapter = deps.adapters[provider];
    if (!adapter) return reply(400, { error: "provider" });
    const { data: allowed } = await caller.rpc("owner_inventory_can_connect", { p_shop_id: shopId, p_provider: provider });
    if (allowed !== "ok") return reply(403, { error: allowed === "plan" ? "plan" : "provider" });
    let parsed;
    try {
      parsed = adapter.parse({ credentials: body.credentials, settings: body.settings });
    } catch (e) {
      return reply(400, { error: errorOut(e).code });
    }
    try {
      await adapter.testConnection(contextOf(deps, parsed.credentials, parsed.settings, 30_000));
    } catch (e) {
      // the key that failed is never stored
      return reply(422, { error: errorOut(e).code });
    }
    const cipher = await encryptCredentials(key, parsed.credentials, bindOf(shopId, provider));
    const { error } = await deps.db.rpc("inventory_save_connection", {
      p_shop_id: shopId, p_provider: provider, p_cipher: cipher, p_hint: parsed.hint, p_settings: parsed.settings,
    });
    if (error) throw new Error(`connection not saved: ${error.message}`);
    try {
      const listing = await adapter.listProducts(contextOf(deps, parsed.credentials, parsed.settings));
      await savePreview(deps, shopId, adapter, listing);
      return reply(200, { connected: true, preview: true, complete: listing.complete });
    } catch (e) {
      return reply(200, { connected: true, preview: false, error: errorOut(e).code });
    }
  }

  const { data, error } = await deps.db.rpc("inventory_key", { p_shop_id: shopId });
  const conn = (Array.isArray(data) ? data[0] : data) as { provider: string; key_cipher: string; settings: Record<string, string> } | undefined;
  if (error || !conn) return reply(404, { error: "not_connected" });
  const adapter = deps.adapters[conn.provider];
  if (!adapter) return reply(400, { error: "provider" });
  const credentials = await decryptCredentials(key, conn.key_cipher, bindOf(shopId, conn.provider));

  if (action === "test") {
    try {
      await adapter.testConnection(contextOf(deps, credentials, conn.settings ?? {}, 30_000));
      await deps.db.rpc("inventory_key_state", { p_shop_id: shopId, p_valid: true, p_message: null });
      return reply(200, { ok: true });
    } catch (e) {
      const out = errorOut(e);
      if (out.code === "invalid_key") await deps.db.rpc("inventory_key_state", { p_shop_id: shopId, p_valid: false, p_message: out.message });
      return reply(200, { ok: false, error: out.code });
    }
  }

  if (action === "preview") {
    try {
      const listing = await adapter.listProducts(contextOf(deps, credentials, conn.settings ?? {}));
      const result = await savePreview(deps, shopId, adapter, listing);
      return reply(200, { ok: true, result, complete: listing.complete });
    } catch (e) {
      return reply(200, { ok: false, error: errorOut(e).code });
    }
  }

  if (action === "sync_now") {
    const { error: refused } = await caller.rpc("owner_inventory_sync_now", { p_shop_id: shopId });
    if (refused) return reply(refused.message === "too_many" ? 429 : 409, { error: refused.message === "too_many" ? "too_many" : "not_active" });
    deps.background(tick(deps, shopId));
    return reply(202, { queued: true });
  }

  return reply(400, { error: "bad_request" });
}

// ---------------------------------------------------------------- the entry point

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
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
      const { data: ok } = await deps.db.rpc("inventory_cron_ok", { p_secret: cron });
      if (ok !== true) return reply(401, { error: "secret" });
      if (action !== "tick") return reply(400, { error: "bad_request" });
      const runs = await tick(deps);
      const alerts = await sendAlerts(deps);
      return reply(200, { ...runs, alerts });
    }
    return await ownerAction(action, req, deps, body);
  } catch (e) {
    console.error("inventory-connect:", action, failText(e).slice(0, 160));
    return reply(500, { error: "failed" });
  }
}

export async function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return reply(500, { error: "config" });
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const brevo = Deno.env.get("BREVO_API_KEY")?.trim();
  const from = Deno.env.get("ALERT_EMAIL_FROM")?.trim();
  let site: string | null = null;
  try {
    const s = new URL((Deno.env.get("SITE_URL") ?? "").trim());
    if (s.protocol === "https:") site = s.origin;
  } catch {
    // no SITE_URL
  }
  const revalidate = (Deno.env.get("REVALIDATE_SECRET") ?? "").trim();
  const indexNow = (Deno.env.get("INDEXNOW_KEY") ?? "").trim();
  return await handle(req, {
    db: createClient(url, serviceKey, options),
    asCaller: (authorization) => createClient(url, anonKey, { ...options, global: { headers: { Authorization: authorization } } }),
    adapters: ADAPTERS,
    secret: Deno.env.get("INVENTORY_TOKEN_ENCRYPTION_KEY")?.trim() || null,
    fetch,
    background: (task) => (runtime ? runtime.waitUntil(task) : void task),
    now: () => Date.now(),
    email: brevo && from ? { apiKey: brevo, from } : null,
    site: {
      url: site,
      revalidateSecret: revalidate.length >= 16 ? revalidate : null,
      indexNowKey: /^[A-Za-z0-9-]{8,128}$/.test(indexNow) ? indexNow : null,
    },
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
