// Unit tests of inventory-connect: the key encrypted and never stored or logged in clear, the connectors against
// answers recorded from their official documentation (no live calls), safe addresses, the preview, a run that applies
// only a complete snapshot, partial / empty / failed data never applied, fields changed → asked again, the owner's
// actions, the job's secret and the 24-hour e-mail. Run: npm run test:functions
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  ADAPTERS,
  ALERT_SUBJECT,
  applyMapping,
  bindOf,
  ConnectError,
  type Context,
  cryptoKey,
  decryptCredentials,
  type Deps,
  encryptCredentials,
  fieldsFor,
  guessMapping,
  handle,
  isPrivateField,
  jsonItems,
  keyHint,
  parseCsv,
  publicRows,
  runOne,
  safeUrl,
  superfakturaRow,
  wooRow,
} from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}
function ok(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
}
async function rejects(work: () => Promise<unknown>, code: string, label: string) {
  try {
    await work();
  } catch (e) {
    if (e instanceof ConnectError && e.code === code) return;
    throw new Error(`${label}: wrong error ${e instanceof ConnectError ? e.code : e}`);
  }
  throw new Error(`${label}: no error`);
}

const SHOP = "11111111-2222-4333-8444-555555555555";
const SECRET = "inventory-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const CRON = "cron-secret-0123456789abcdef0123456789abcdef";
const SF_KEY = "c0a4cdcdfe98ca660942d60cf7896de6";
const WC_KEY = "ck_0123456789abcdef0123";
const WC_SECRET = "cs_fedcba9876543210fedcba";

// ---------------------------------------------------------------- recorded answers (shapes from the official docs)

/** superfaktura/docs stock.md "Success with listing information": one StockItem, with the fields we must never keep. */
function sfItem(i: number, stock: number | null = 10 + i) {
  return {
    StockItem: {
      created: "2050-01-01 23:59:59", description: "Public description", hide_in_autocomplete: true, id: String(i),
      import_id: null, import_type: null, internal_comment: "Secret comment", modified: "2050-01-01 23:59:59",
      name: `Item ${i}`, purchase_currency: "EUR", purchase_unit_price: 5.5, purchase_vat: 20, sku: `itemb${i}`,
      stock, unit: "ks", unit_price: 10, user_id: "1", user_profile_id: "1", vat: 20, watch_stock: true,
    },
  };
}
function sfPage(page: number, perPage: number, total: number, opts: { lie?: number } = {}) {
  const from = (page - 1) * perPage;
  const items = Array.from({ length: Math.max(0, Math.min(perPage, total - from)) }, (_, k) => sfItem(from + k + 1));
  return { itemCount: total + (opts.lie ?? 0), items, page, pageCount: Math.max(1, Math.ceil(total / perPage)), perPage };
}

/** woocommerce-rest-api-docs _products.md "List all products" (trimmed to the fields asked for with _fields). */
const WC_PRODUCTS = [
  { id: 799, name: "Ship Your Idea", type: "simple", status: "publish", sku: "SYI", global_unique_id: "8580000000010", price: "21.99",
    regular_price: "21.99", manage_stock: true, stock_quantity: 4, stock_status: "instock", categories: [{ id: 9, name: "Clothing" }],
    meta_data: [{ key: "_cost", value: "9.00" }] },
  { id: 794, name: "Premium Quality", type: "variable", status: "publish", sku: "PQ", price: "", regular_price: "",
    manage_stock: false, stock_quantity: null, stock_status: "instock", categories: [{ id: 9, name: "Clothing" }] },
];
/** _product-variations.md "List all product variations". */
const WC_VARIATIONS = [
  { id: 733, sku: "PQ-B", price: "9.00", regular_price: "9.00", manage_stock: true, stock_quantity: 2, stock_status: "instock",
    attributes: [{ id: 6, name: "Color", option: "Black" }] },
  { id: 732, sku: "PQ-G", price: "9.00", regular_price: "9.00", manage_stock: true, stock_quantity: 0, stock_status: "outofstock",
    attributes: [{ id: 6, name: "Color", option: "Green" }] },
];

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, init });
    return await handler(url, init);
  }) as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const ctx = (f: typeof fetch, credentials: Record<string, string>, settings: Record<string, string>, ms = 60_000): Context => ({
  credentials, settings, fetch: f, deadline: Date.now() + ms, now: () => Date.now(),
});

// ---------------------------------------------------------------- the key

Deno.test("The key: encrypted, bound to its shop and provider, never in clear; only its last 4 shown", async () => {
  const key = await cryptoKey(SECRET);
  const cipher = await encryptCredentials(key, { email: "a@b.sk", apikey: SF_KEY }, bindOf(SHOP, "superfaktura"));
  ok(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cipher), "the database's format");
  ok(!cipher.includes(SF_KEY) && !cipher.includes("a@b.sk"), "nothing in clear");
  eq(await decryptCredentials(key, cipher, bindOf(SHOP, "superfaktura")), { email: "a@b.sk", apikey: SF_KEY }, "opens");
  let refused = false;
  try {
    await decryptCredentials(key, cipher, bindOf("99999999-2222-4333-8444-555555555555", "superfaktura"));
  } catch {
    refused = true;
  }
  ok(refused, "another shop's binding does not open it");
  eq(keyHint(SF_KEY), "6de6", "••••6de6");
  let short = false;
  try {
    await cryptoKey("too short");
  } catch {
    short = true;
  }
  ok(short, "a weak secret is refused");
});

Deno.test("Private fields: purchase prices, suppliers, margins, internal notes never kept", () => {
  for (const f of ["purchase_unit_price", "purchase_currency", "Nákupná cena", "supplier", "margin", "internal_comment", "NC"]) ok(isPrivateField(f), f);
  for (const f of ["price", "unit_price", "stock", "sku", "name", "price_with_vat"]) ok(!isPrivateField(f), f);
  eq(publicRows([{ sku: "A", purchase_price: "5", Dodávateľ: "X" }]), [{ sku: "A" }], "dropped before anything is stored");
});

Deno.test("Addresses: public https only (no http, IP, local names, user:password)", () => {
  ok(safeUrl("https://obchod.example.sk/wp"), "ok");
  for (const bad of ["http://obchod.sk", "https://127.0.0.1/x", "https://localhost/x", "https://intranet.local/x", "https://user:pw@obchod.sk", "https://[::1]/x", "ftp://a.sk"]) {
    ok(!safeUrl(bad), bad);
  }
});

// ---------------------------------------------------------------- SuperFaktúra

Deno.test("SuperFaktúra: the documented header, every page, only allowed fields, price with VAT, complete by itemCount", async () => {
  const sf = ADAPTERS.superfaktura;
  const parsed = sf.parse({ credentials: { email: "api@example.com", apikey: SF_KEY, company_id: "123" }, settings: { country: "sk" } });
  eq(parsed.hint, "6de6", "hint");
  eq(parsed.settings, { country: "sk" }, "nothing secret in settings");
  const { f, calls } = fakeFetch((url) => {
    const page = Number(/page:(\d+)/.exec(url.pathname)?.[1] ?? 1);
    const perPage = Number(/per_page:(\d+)/.exec(url.pathname)?.[1] ?? 100);
    return json(sfPage(page, perPage, 150), 200, { "X-RateLimit-DailyRemaining": "900" });
  });
  await sf.testConnection(ctx(f, parsed.credentials, parsed.settings));
  const listing = await sf.listProducts(ctx(f, parsed.credentials, parsed.settings));
  eq(calls[0].url, "https://moja.superfaktura.sk/stock_items/index.json/listinfo:1/page:1/per_page:1", "the test");
  eq(calls.slice(1).map((c) => new URL(c.url).pathname), [
    "/stock_items/index.json/listinfo:1/page:1/per_page:100",
    "/stock_items/index.json/listinfo:1/page:2/per_page:100",
  ], "two pages");
  const auth = new Headers(calls[1].init.headers).get("Authorization");
  eq(auth, `SFAPI email=api%40example.com&apikey=${SF_KEY}&module=Cacaduu%20PPI%201.0&company_id=123`, "SFAPI header (intro.md)");
  ok(calls.every((c) => (c.init.method ?? "GET") === "GET"), "read only");
  eq(listing.rows.length, 150, "all");
  ok(listing.complete && listing.total === 150, "complete");
  const row = listing.rows[0];
  ok(!("purchase_unit_price" in row) && !("internal_comment" in row) && !("purchase_currency" in row), "never the private fields");
  eq(row.price_with_vat, "12.00", "10 + 20 % VAT");
  eq(sf.proposeMapping(fieldsFor(sf, listing.rows), listing.rows), {
    source_code: "sku", name: "name", quantity: "stock", price: "price_with_vat", description: "description",
  }, "proposal");
  eq(superfakturaRow({ id: "1", name: "x", unit_price: "1,50", vat: 10 }).price_with_vat, "1.65", "number text");
});

Deno.test("SuperFaktúra: a wrong count is incomplete; 401 = invalid key; the daily limit is never run into", async () => {
  const sf = ADAPTERS.superfaktura;
  const creds = { email: "a@b.sk", apikey: SF_KEY };
  const lying = fakeFetch((url) => json(sfPage(Number(/page:(\d+)/.exec(url.pathname)?.[1]), 100, 120, { lie: 5 })));
  const listing = await sf.listProducts(ctx(lying.f, creds, { country: "sk" }));
  ok(!listing.complete && listing.reason === "count", "120 of 125: incomplete");
  await rejects(() => sf.testConnection(ctx(fakeFetch(() => json({ error: 1 }, 401)).f, creds, { country: "sk" })), "invalid_key", "401");
  const limited = fakeFetch((url) => json(sfPage(Number(/page:(\d+)/.exec(url.pathname)?.[1]), 100, 500), 200, { "X-RateLimit-DailyRemaining": "1" }));
  await rejects(() => sf.listProducts(ctx(limited.f, creds, { country: "sk" })), "rate_limited", "stops before the limit");
  for (const bad of [{ email: "x", apikey: SF_KEY }, { email: "a@b.sk", apikey: "short" }, { email: "a@b.sk", apikey: SF_KEY, company_id: "abc" }]) {
    let refused = false;
    try {
      sf.parse({ credentials: bad, settings: {} });
    } catch (e) {
      refused = e instanceof ConnectError && e.code === "missing";
    }
    ok(refused, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- WooCommerce

Deno.test("WooCommerce: Basic auth over HTTPS, published products, variations as items, X-WP-Total, the store's currency", async () => {
  const wc = ADAPTERS.woocommerce;
  const parsed = wc.parse({ credentials: { consumer_key: WC_KEY, consumer_secret: WC_SECRET }, settings: { store_url: "https://shop.example.com/" } });
  eq(parsed.settings, { store_url: "https://shop.example.com" }, "address");
  const { f, calls } = fakeFetch((url) => {
    if (url.pathname.endsWith("/data/currencies/current")) return json({ code: "EUR", name: "Euro", symbol: "€" });
    if (url.pathname.endsWith("/products/794/variations")) return json(WC_VARIATIONS, 200, { "X-WP-Total": "2", "X-WP-TotalPages": "1" });
    if (url.pathname.endsWith("/wp-json/wc/v3/products")) {
      if (url.searchParams.get("per_page") === "1") return json([{ id: 799 }], 200, { "X-WP-Total": "2", "X-WP-TotalPages": "2" });
      return json(WC_PRODUCTS, 200, { "X-WP-Total": "2", "X-WP-TotalPages": "1" });
    }
    return json({}, 404);
  });
  await wc.testConnection(ctx(f, parsed.credentials, parsed.settings));
  const listing = await wc.listProducts(ctx(f, parsed.credentials, parsed.settings));
  eq(new Headers(calls[0].init.headers).get("Authorization"), `Basic ${btoa(`${WC_KEY}:${WC_SECRET}`)}`, "HTTP Basic (_authentication.md)");
  const list = calls.find((c) => c.url.includes("status=publish"))!;
  const q = new URL(list.url).searchParams;
  eq([q.get("per_page"), q.get("page"), q.get("status")], ["100", "1", "publish"], "pages of 100, published only");
  ok(!(q.get("_fields") ?? "").includes("meta_data"), "plugins' meta data (costs) never asked for");
  eq(listing.currency, "EUR", "data/currencies/current");
  ok(listing.complete && listing.total === 2, "2 of 2 products");
  eq(listing.rows.map((r) => [r.sku, r.name, r.stock_quantity ?? null]), [
    ["SYI", "Ship Your Idea", "4"], ["PQ-B", "Premium Quality – Black", "2"], ["PQ-G", "Premium Quality – Green", "0"],
  ], "the variable product's variations are the items");
  ok(listing.rows.every((r) => !Object.keys(r).some((k) => k.includes("meta") || k.includes("cost"))), "no costs");
  eq(listing.rows[0].categories, "Clothing", "categories");
  eq(wc.proposeMapping(fieldsFor(wc, listing.rows), listing.rows), {
    source_code: "sku", name: "name", ean: "global_unique_id", quantity: "stock_quantity", price: "price", category: "categories",
  }, "proposal");
  eq(wooRow({ id: 5, name: "x", stock_quantity: null }).stock_quantity, undefined, "no stock management: no quantity (never 0)");
});

Deno.test("WooCommerce: 401 → invalid key, 404 → not a WooCommerce address, 429 → Retry-After; a missing page is incomplete", async () => {
  const wc = ADAPTERS.woocommerce;
  const c = { consumer_key: WC_KEY, consumer_secret: WC_SECRET };
  const s = { store_url: "https://shop.example.com" };
  await rejects(() => wc.testConnection(ctx(fakeFetch(() => json({ code: "woocommerce_rest_cannot_view" }, 401)).f, c, s)), "invalid_key", "401");
  await rejects(() => wc.testConnection(ctx(fakeFetch(() => json({}, 404)).f, c, s)), "not_found", "plain permalinks");
  try {
    await wc.testConnection(ctx(fakeFetch(() => new Response("", { status: 429, headers: { "Retry-After": "120" } })).f, c, s));
    throw new Error("no error");
  } catch (e) {
    ok(e instanceof ConnectError && e.code === "rate_limited" && e.retryAfter === 120, "Retry-After kept");
  }
  const short = fakeFetch((url) => url.pathname.endsWith("current") ? json({ code: "EUR" }) : json([WC_PRODUCTS[0]], 200, { "X-WP-Total": "3", "X-WP-TotalPages": "1" }));
  ok(!(await wc.listProducts(ctx(short.f, c, s))).complete, "1 of 3: incomplete");
  for (const bad of [{ store_url: "http://shop.example.com" }, { store_url: "https://192.168.1.2" }]) {
    let refused = false;
    try {
      wc.parse({ credentials: c, settings: bad });
    } catch (e) {
      refused = e instanceof ConnectError && e.code === "url";
    }
    ok(refused, bad.store_url);
  }
});

// ---------------------------------------------------------------- "Vlastné API"

Deno.test("Vlastné API: JSON (nested list) or CSV, the key in a header, private fields dropped, forwards checked", async () => {
  const cu = ADAPTERS.custom;
  const parsed = cu.parse({ credentials: { url: "https://erp.example.sk/export?token=SECRETTOKEN1234", header_name: "X-Api-Key", header_value: "k3y-abcdef9876" }, settings: { format: "auto" } });
  eq(parsed.settings, { host: "erp.example.sk", format: "auto" }, "only the host is shown");
  eq(parsed.hint, "9876", "the header's key");
  const body = { data: { products: [
    { code: "A1", title: "Farba", qty: "3", price: "9,90", nakupna_cena: "5", supplier: "X" },
    { code: "A2", title: "Štetec", qty: "0", price: "2.50" },
  ] } };
  const { f, calls } = fakeFetch(() => json(body));
  const listing = await cu.listProducts(ctx(f, parsed.credentials, parsed.settings));
  eq(new Headers(calls[0].init.headers).get("X-Api-Key"), "k3y-abcdef9876", "the key in its header");
  ok(listing.complete && listing.rows.length === 2, "one document = complete");
  ok(listing.rows.every((r) => !("nakupna_cena" in r) && !("supplier" in r)), "private fields dropped");
  eq(guessMapping(fieldsFor(cu, listing.rows)), { source_code: "code", name: "title", quantity: "qty", price: "price" }, "proposal");
  const csv = "Kód;Názov;Množstvo;Cena;Nákupná cena\nA1;Farba;3;9,90;5\n";
  eq(parseCsv(csv)[0], { Kód: "A1", Názov: "Farba", Množstvo: "3", Cena: "9,90", "Nákupná cena": "5" }, "CSV");
  const csvListing = await cu.listProducts(ctx(fakeFetch(() => new Response(csv)).f, { url: "https://erp.example.sk/x.csv" }, { format: "csv" }));
  ok(!("Nákupná cena" in csvListing.rows[0]), "private CSV column dropped");
  eq(jsonItems({ items: [{ a: 1 }, { a: 2 }], other: [{ a: 1 }] }, ""), [{ a: 1 }, { a: 2 }], "the largest list");
  eq(jsonItems({ a: { b: [3] } }, "a.b"), [3], "the given path");
  const forward = fakeFetch(() => new Response("", { status: 302, headers: { Location: "https://10.0.0.1/admin" } }));
  await rejects(() => cu.listProducts(ctx(forward.f, { url: "https://erp.example.sk/x" }, {})), "url", "a forward to a private address");
  await rejects(() => cu.testConnection(ctx(fakeFetch(() => json([])).f, { url: "https://erp.example.sk/x" }, {})), "no_items", "empty");
  let refused = false;
  try {
    cu.parse({ credentials: { url: "https://erp.example.sk/x", header_name: "Host", header_value: "x" } });
  } catch {
    refused = true;
  }
  ok(refused, "no Host header");
});

// ---------------------------------------------------------------- mapping

Deno.test("Mapping: rows without code, name, price or quantity are counted bad; without quantities only by choice", () => {
  const rows = [{ c: "A", n: "Farba", q: "3", p: "9,90" }, { c: "", n: "x", q: "1", p: "1" }, { c: "B", n: "Lak", q: "", p: "4" }];
  const m = { source_code: "c", name: "n", quantity: "q", price: "p" };
  const r = applyMapping(rows, m, "EUR", false);
  eq(r.good.map((g) => [g.source_code, g.quantity, g.price]), [["A", 3, 9.9]], "good");
  eq(r.bad, 2, "bad");
  const w = applyMapping(rows, { source_code: "c", name: "n", price: "p" }, "EUR", true);
  eq(w.good.map((g) => [g.source_code, g.quantity]), [["A", null], ["B", null]], "no quantity ever invented");
});

// ---------------------------------------------------------------- a run

interface Rpc {
  name: string;
  args: Record<string, unknown>;
}
function fakeDb(answers: Record<string, unknown> = {}) {
  const calls: Rpc[] = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      const a = answers[name];
      const data = typeof a === "function" ? (a as (x: Record<string, unknown>) => unknown)(args) : a ?? null;
      return Promise.resolve({ data, error: null });
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { slug: "farby" }, error: null }) }) }) }),
  };
  return { db: db as unknown as SupabaseClient, calls };
}

async function depsFor(fetchHandler: Handler, answers: Record<string, unknown>, extra: Partial<Deps> = {}) {
  const { db, calls } = fakeDb(answers);
  const { f, calls: requests } = fakeFetch(fetchHandler);
  const deps: Deps = {
    db,
    asCaller: () => db,
    adapters: ADAPTERS,
    secret: SECRET,
    fetch: f,
    background: () => {},
    now: () => Date.now(),
    email: null,
    site: { url: null, revalidateSecret: null, indexNowKey: null },
    ...extra,
  };
  return { deps, calls, requests };
}

const CUSTOM_FIELDS = ["code", "price", "qty", "title"];
async function connection(fields = CUSTOM_FIELDS, mapping: Record<string, string> = { source_code: "code", name: "title", quantity: "qty", price: "price" }) {
  const key = await cryptoKey(SECRET);
  return [{
    provider: "custom", key_cipher: await encryptCredentials(key, { url: "https://erp.example.sk/x", header_name: "X-Api-Key", header_value: "k3y-secret-value" }, bindOf(SHOP, "custom")),
    settings: { format: "json" }, mapping, mapping_status: "confirmed", publish_without_quantity: false, last_source_time: null, status: "active", fields,
  }];
}
const DUE = { shop_id: SHOP, provider: "custom", shop_country: "SK" };
const PRODUCTS = [{ code: "A1", title: "Farba", qty: "3", price: "9,90" }, { code: "A2", title: "Štetec", qty: "0", price: "2.5" }];

Deno.test("A run: a complete snapshot is applied through inventory_apply, reported as 'api', the next run planned", async () => {
  const { deps, calls } = await depsFor(() => json(PRODUCTS), {
    inventory_key: await connection(),
    inventory_apply: { status: "updated", items: 2, zeroed: 0, changed: 1 },
  });
  const out = await runOne(deps, DUE);
  eq(out.kind, "ok", JSON.stringify(out));
  const apply = calls.find((c) => c.name === "inventory_apply")!;
  eq(apply.args.p_rows, [
    { source_code: "A1", name: "Farba", ean: null, brand: null, quantity: 3, price: 9.9, currency: "EUR" },
    { source_code: "A2", name: "Štetec", ean: null, brand: null, quantity: 0, price: 2.5, currency: "EUR" },
  ], "the same rows as a stock file");
  const report = calls.find((c) => c.name === "inventory_record_import")!;
  eq([report.args.p_status, report.args.p_imported, report.args.p_name], ["ok", 2, "API · Vlastné API"], "report");
  eq(calls.at(-1)!.name, "inventory_finish", "finished");
  eq((calls.at(-1)!.args.p_outcome as Record<string, unknown>).changed, 1, "Y zmien");
});

Deno.test("A run never applies partial, empty, unreadable or failed data — the old stock stays", async () => {
  // a failed request
  let r = await depsFor(() => json({}, 500), { inventory_key: await connection() });
  let out = await runOne(r.deps, DUE);
  eq([out.kind, out.code], ["error", "network"], "error");
  ok(!r.calls.some((c) => c.name === "inventory_apply"), "nothing applied on error");
  // an empty list
  r = await depsFor(() => json([]), { inventory_key: await connection() });
  out = await runOne(r.deps, DUE);
  eq([out.kind, out.code], ["warning", "incomplete"], "empty = incomplete");
  ok(!r.calls.some((c) => c.name === "inventory_apply"), "never 'everything sold out'");
  // more than 5 % unreadable with the approved fields
  r = await depsFor(() => json([...PRODUCTS, { code: "A3", title: "x", qty: "?", price: "1" }]), { inventory_key: await connection() });
  out = await runOne(r.deps, DUE);
  eq([out.kind, out.code], ["warning", "layout"], "layout");
  ok(!r.calls.some((c) => c.name === "inventory_apply"), "not applied");
  // an invalid key
  r = await depsFor(() => json({}, 401), { inventory_key: await connection() });
  out = await runOne(r.deps, DUE);
  eq(out.code, "invalid_key", "401 → invalid key (SQL stops the runs)");
});

Deno.test("A run whose fields changed asks the owner again and applies nothing", async () => {
  const { deps, calls } = await depsFor(() => json([{ sku: "A1", nazov: "Farba", stav: "3", cena: "9" }]), {
    inventory_key: await connection(),
    inventory_save_preview: "changed",
  });
  const out = await runOne(deps, DUE);
  eq([out.kind, out.code], ["warning", "fields_changed"], "asked again");
  ok(!calls.some((c) => c.name === "inventory_apply"), "nothing applied");
});

Deno.test("Incomplete SuperFaktúra listing: the count does not match → not applied, reported", async () => {
  const key = await cryptoKey(SECRET);
  const sfConn = [{
    provider: "superfaktura", key_cipher: await encryptCredentials(key, { email: "a@b.sk", apikey: SF_KEY }, bindOf(SHOP, "superfaktura")),
    settings: { country: "sk" }, mapping: { source_code: "sku", name: "name", quantity: "stock", price: "price_with_vat" },
    mapping_status: "confirmed", publish_without_quantity: false, last_source_time: null, status: "active",
    fields: fieldsFor(ADAPTERS.superfaktura, []),
  }];
  const { deps, calls } = await depsFor((url) => json(sfPage(Number(/page:(\d+)/.exec(url.pathname)?.[1]), 100, 150, { lie: 1 })), { inventory_key: sfConn });
  const out = await runOne(deps, { shop_id: SHOP, provider: "superfaktura", shop_country: "SK" });
  eq([out.kind, out.code], ["warning", "incomplete"], "150 of 151");
  ok(!calls.some((c) => c.name === "inventory_apply"), "not applied");
  eq(calls.find((c) => c.name === "inventory_record_import")?.args.p_status, "errors", "reported");
});

// ---------------------------------------------------------------- the owner's actions

function ownerDeps(deps: Deps, member = true, canConnect = "ok") {
  const owner = {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "u1" } }, error: null }) },
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === "is_shop_member") return Promise.resolve({ data: member, error: null });
      if (name === "owner_inventory_can_connect") return Promise.resolve({ data: canConnect, error: null });
      return deps.db.rpc(name, args);
    },
  };
  return { ...deps, asCaller: () => owner as unknown as SupabaseClient };
}
const post = (body: unknown, headers: Record<string, string> = { Authorization: "Bearer owner" }) =>
  new Request("https://x.supabase.co/functions/v1/inventory-connect", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

Deno.test("Connect: tested first (a refused key is never stored), then kept only encrypted; nothing logged", async () => {
  const logged: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    let r = await depsFor(() => json({}, 401), {});
    let res = await handle(post({ action: "connect", shop_id: SHOP, provider: "custom", credentials: { url: "https://erp.example.sk/x", header_name: "X-Api-Key", header_value: "k3y-secret-value" } }), ownerDeps(r.deps));
    eq([res.status, (await res.json()).error], [422, "invalid_key"], "refused");
    ok(!r.calls.some((c) => c.name === "inventory_save_connection"), "a refused key is never stored");

    r = await depsFor(() => json(PRODUCTS), { inventory_save_preview: "ok" });
    res = await handle(post({ action: "connect", shop_id: SHOP, provider: "custom", credentials: { url: "https://erp.example.sk/x", header_name: "X-Api-Key", header_value: "k3y-secret-value" }, settings: { format: "json" } }), ownerDeps(r.deps));
    const answer = await res.json();
    eq([res.status, answer.connected, answer.preview], [200, true, true], JSON.stringify(answer));
    ok(!JSON.stringify(answer).includes("k3y-secret-value"), "the reply has no key");
    const saved = r.calls.find((c) => c.name === "inventory_save_connection")!;
    ok(!JSON.stringify(saved.args).includes("k3y-secret-value"), "stored only encrypted");
    eq(saved.args.p_hint, "alue", "••••alue");
    const preview = r.calls.find((c) => c.name === "inventory_save_preview")!;
    eq(preview.args.p_fields, ["code", "price", "qty", "title"], "fields");
    eq(preview.args.p_proposal, { source_code: "code", name: "title", quantity: "qty", price: "price" }, "a proposal, not approved");
    // not a member / plan / provider
    res = await handle(post({ action: "connect", shop_id: SHOP, provider: "custom", credentials: {} }), ownerDeps(r.deps, false));
    eq(res.status, 403, "not a member");
    res = await handle(post({ action: "connect", shop_id: SHOP, provider: "custom", credentials: {} }), ownerDeps(r.deps, true, "plan"));
    eq([res.status, (await res.json()).error], [403, "plan"], "the plan's rule");
    res = await handle(post({ action: "connect", shop_id: SHOP, provider: "shoptet", credentials: {} }), ownerDeps(r.deps));
    eq(res.status, 400, "a connector that is not built");
    res = await handle(post({ action: "connect", shop_id: SHOP, provider: "custom" }, {}), ownerDeps(r.deps));
    eq(res.status, 401, "a login is needed");
  } finally {
    Object.assign(console, original);
  }
  ok(!logged.some((l) => l.includes("k3y-secret-value") || l.includes(SECRET)), "nothing of a key in the logs");
});

Deno.test("Test, sync now (4 an hour), CORS for the owner's browser, the job's secret", async () => {
  const r = await depsFor(() => json({}, 401), { inventory_key: await connection() });
  let res = await handle(post({ action: "test", shop_id: SHOP }), ownerDeps(r.deps));
  eq(await res.json(), { ok: false, error: "invalid_key" }, "test failed");
  eq(r.calls.find((c) => c.name === "inventory_key_state")?.args.p_valid, false, "marked invalid");
  const pre = await handle(new Request("https://x/functions/v1/inventory-connect", { method: "OPTIONS" }), r.deps);
  eq([pre.status, pre.headers.get("access-control-allow-origin")], [204, "*"], "CORS");
  const refused = await handle(post({ action: "tick" }, { "x-ppi-cron": "wrong" }), r.deps);
  eq(refused.status, 401, "a wrong job secret");
  const owner = ownerDeps(r.deps);
  const tooMany = {
    ...owner,
    asCaller: () => ({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: "u1" } }, error: null }) },
      rpc: (name: string) => Promise.resolve(name === "is_shop_member" ? { data: true, error: null } : { data: null, error: { message: "too_many" } }),
    }) as unknown as SupabaseClient,
  };
  res = await handle(post({ action: "sync_now", shop_id: SHOP }), tooMany);
  eq([res.status, (await res.json()).error], [429, "too_many"], "4 an hour");
});

Deno.test("The job: due shops run, then one e-mail per key invalid for 24 hours", async () => {
  let claimed = false;
  const sent: unknown[] = [];
  const r = await depsFor((url, init) => {
    if (url.hostname === "api.brevo.com") {
      sent.push(JSON.parse(String(init.body)));
      return json({ messageId: "1" }, 201);
    }
    return json(PRODUCTS);
  }, {
    inventory_cron_ok: true,
    inventory_claim: () => {
      if (claimed) return [];
      claimed = true;
      return [DUE];
    },
    inventory_key: await connection(),
    inventory_apply: { status: "updated", items: 2, zeroed: 0, changed: 2 },
    inventory_alerts_due: [{ shop_id: SHOP, shop_name: "Davide paint shop", provider: "woocommerce", emails: ["owner@example.invalid"] }],
  }, { email: { apiKey: "brevo-key", from: "ppi@example.invalid" } });
  const res = await handle(post({ action: "tick" }, { "x-ppi-cron": CRON }), r.deps);
  const answer = await res.json();
  eq([answer.runs, answer.ok, answer.alerts], [1, 1, 1], JSON.stringify(answer));
  const mail = sent[0] as { subject: string; textContent: string; to: { email: string }[] };
  eq(mail.subject, ALERT_SUBJECT, "subject");
  ok(mail.textContent.includes("WooCommerce") && mail.textContent.includes("Zmeniť kľúč"), "what to do");
  eq(r.calls.filter((c) => c.name === "inventory_alert_sent").length, 1, "once");
});
