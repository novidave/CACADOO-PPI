// Run: npm run test:functions   (sets PPI_STOCK_PULL_TEST so the server does not start)
import * as XLSX from "npm:@e965/xlsx@0.20.3";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  applyMapping, approvalSample, batches, columnSamples, currencyForCountry, decodeText, detectEncoding, detectFormat, guessLanguageColumns, guessMapping,
  isValidMapping, languageField, languageRows, previewFile,
  importReport, indexNowPayload, indexNowSettings, indexNowUrls, isPrivateColumn, mappedColumns, onlyColumns, parseFile, parseNumber,
  pingIndexNow, rawFilesUpTo, readTranslations, receiveUpload, revalidateSettings, revalidateSite, type IndexNowHostClaim, type Mapping, type NameTranslation, type Translator,
} from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}\n  expected ${e}\n  got      ${a}`);
}

function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
}

Deno.test("numbers in European and English formats", () => {
  eq(["12,90", "1 234,50 €", "1.234,5", "1,234.50", "12.9", "0", "-3", "abc", "", " 7 ks"].map(parseNumber),
    [12.9, 1234.5, 1234.5, 1234.5, 12.9, 0, -3, null, null, 7], "parseNumber");
});

Deno.test("CSV in Windows-1250 with semicolons, quotes and decimal commas (Slovak export)", () => {
  const text = 'Kód;Názov tovaru;EAN;Množstvo;Cena s DPH\r\nP001;"Káva zrnková; 1 kg";8000070012345;14;18,90\r\nP002;Čokoláda horká;;2;1,49\r\n\r\n';
  // encode as Windows-1250 bytes
  const map: Record<string, number> = { "á": 0xe1, "ó": 0xf3, "ž": 0x9e, "Č": 0xc8, "č": 0xe8, "Ž": 0x8e, "é": 0xe9, "í": 0xed };
  const bytes = Uint8Array.from([...text].map((c) => map[c] ?? c.charCodeAt(0)));
  eq(decodeText(bytes).slice(0, 4), "Kód;", "falls back to Windows-1250");
  eq(detectFormat(bytes, "csv"), "csv", "format");
  const rows = parseFile(bytes, "csv");
  eq(rows.length, 2, "row count (empty line ignored)");
  eq(rows[0]["Názov tovaru"], "Káva zrnková; 1 kg", "quoted field keeps the separator");
  const mapping = guessMapping(Object.keys(rows[0]));
  eq(mapping, { source_code: "Kód", name: "Názov tovaru", ean: "EAN", brand: null, quantity: "Množstvo", price: "Cena s DPH", currency: null, description: null, category: null }, "Slovak mapping");
  const { good, bad } = applyMapping(rows, mapping, currencyForCountry("SK"));
  eq(bad, 0, "no bad rows");
  eq(good[1], { source_code: "P002", name: "Čokoláda horká", ean: null, brand: null, quantity: 2, price: 1.49, currency: "EUR" }, "mapped row");
});

Deno.test("XML with item elements, attributes and nested values (Hungarian export)", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<keszlet export="2026-10-04T10:15:00">
  <termek cikkszam="H001"><megnevezes>Kávé őrölt 250 g</megnevezes><vonalkod>4006067012359</vonalkod><mennyiseg>9</mennyiseg><ar penznem="HUF">1890</ar></termek>
  <termek cikkszam="H002"><megnevezes>Tej 2,8% 1 l</megnevezes><vonalkod/><mennyiseg>1</mennyiseg><ar penznem="HUF">399</ar></termek>
</keszlet>`;
  const bytes = new TextEncoder().encode(xml);
  eq(detectFormat(bytes, "csv"), "xml", "XML detected from content even if configured as CSV");
  const rows = parseFile(bytes, "xml");
  eq(rows.length, 2, "two items");
  const sorted = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort());
  eq(sorted(rows[0]), sorted({ "@cikkszam": "H001", megnevezes: "Kávé őrölt 250 g", vonalkod: "4006067012359", mennyiseg: "9", ar: "1890", "ar/@penznem": "HUF" }), "flattened item");
  const mapping = guessMapping(Object.keys(rows[0]));
  eq([mapping.source_code, mapping.name, mapping.ean, mapping.quantity, mapping.price, mapping.currency],
    ["@cikkszam", "megnevezes", "vonalkod", "mennyiseg", "ar", "ar/@penznem"], "Hungarian mapping");
  const { good } = applyMapping(rows, mapping, currencyForCountry("HU"));
  eq(good.map((g) => `${g.source_code} ${g.price} ${g.currency} ${g.quantity}`), ["H001 1890 HUF 9", "H002 399 HUF 1"], "mapped");
});

Deno.test("Excel (xlsx) first sheet", () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Code", "Name", "Brand", "Stock", "Price"],
    ["A1", "Hammer 500 g", "Fiskars", 0, 19.9],
    ["A2", "Screws 4x40", "", 50, "5,90"],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Stock");
  const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }));
  eq(detectFormat(bytes, "xml"), "xlsx", "xlsx detected from ZIP header");
  const rows = parseFile(bytes, "xlsx");
  const mapping = guessMapping(Object.keys(rows[0]));
  eq([mapping.source_code, mapping.name, mapping.brand, mapping.quantity, mapping.price], ["Code", "Name", "Brand", "Stock", "Price"], "English mapping");
  const { good } = applyMapping(rows, mapping, "EUR");
  eq(good.map((g) => [g.quantity, g.price, g.brand]), [[0, 19.9, "Fiskars"], [50, 5.9, null]], "values");
});

Deno.test("rows that cannot be read are counted, not guessed", () => {
  const mapping: Mapping = { source_code: "c", name: "n", ean: null, brand: null, quantity: "q", price: "p", currency: null };
  const { good, bad } = applyMapping(
    [
      { c: "1", n: "ok", q: "1", p: "2" },
      { c: "", n: "no code", q: "1", p: "2" },
      { c: "3", n: "bad price", q: "1", p: "n/a" },
      { c: "4", n: "negative price", q: "1", p: "-1" },
      { c: "5", n: "no quantity", q: "", p: "1" },
    ],
    mapping,
    "EUR",
  );
  eq([good.length, bad], [1, 4], "1 good, 4 bad");
});

// ---------------------------------------------------------------- item names in three languages

Deno.test("names are translated in batches of about 200", () => {
  const names = Array.from({ length: 450 }, (_, i) => ({ item_id: `i${i}`, name: `Item ${i}` }));
  eq(batches(names, 200).map((b) => b.length), [200, 200, 50], "batch sizes");
});

Deno.test("only complete translations of the asked names are kept", () => {
  const batch = [
    { item_id: "a", name: "Farba fas. biela 5L" },
    { item_id: "b", name: "Valcek 25cm" },
    { item_id: "c", name: "Tmel" },
  ];
  const answer = JSON.stringify({
    items: [
      { i: 0, lang: "SK", sk: " Fasádna farba biela 5 l ", hu: "Homlokzatfesték fehér 5 l", en: "White facade paint 5 l" },
      { i: 0, lang: "sk", sk: "duplicate", hu: "x", en: "x" },
      { i: 1, lang: "slovak", sk: "Valček 25 cm", hu: "Festőhenger 25 cm", en: "Paint roller 25 cm" },
      { i: 2, lang: "sk", sk: "Tmel", hu: "", en: "Putty" },
      { i: 7, lang: "sk", sk: "x", hu: "x", en: "x" },
    ],
  });
  eq(readTranslations(answer, batch), [
    { item_id: "a", source: "Farba fas. biela 5L", lang: "sk", sk: "Fasádna farba biela 5 l", hu: "Homlokzatfesték fehér 5 l", en: "White facade paint 5 l" },
    { item_id: "b", source: "Valcek 25cm", lang: null, sk: "Valček 25 cm", hu: "Festőhenger 25 cm", en: "Paint roller 25 cm" },
  ], "kept translations");
});

const SHOP = "00000000-0000-4000-8000-000000000001";
const CSV = "Kod;Nazov;Mnozstvo;Cena\nC1;Farba fas. biela 5L;4;24,90\nC2;Valcek 25 cm;3;6,90\n";

/** Just enough of the Supabase client for one upload; records every database call. */
function fakeSupabase(override: Partial<{ field_mapping: Mapping | null; mapping_status: string; latest_file_time: string | null }> = {}, claim: IndexNowHostClaim | null = null) {
  const rpc: { name: string; args: Record<string, unknown> }[] = [];
  const updates: Record<string, unknown>[] = [];
  const source = {
    shop_id: SHOP,
    file_format: "csv",
    field_mapping: { source_code: "Kod", name: "Nazov", ean: null, brand: null, quantity: "Mnozstvo", price: "Cena", currency: null },
    mapping_status: "confirmed",
    latest_file_time: null,
    shops: { slug: "test", name: "Test", country: "SK" },
    ...override,
  };
  const db = {
    rpc(name: string, args: Record<string, unknown>) {
      rpc.push({ name, args });
      if (name === "apply_stock_file") return Promise.resolve({ data: { items: (args.p_rows as unknown[]).length, zeroed: 0 }, error: null });
      if (name === "items_to_translate") return Promise.resolve({ data: [{ item_id: "item-1", name: "Farba fas. biela 5L" }], error: null });
      if (name === "apply_item_translations") return Promise.resolve({ data: (args.p_items as unknown[]).length, error: null });
      // Like the database: the same host again within the hour gets "hour".
      if (name === "indexnow_claim_host") {
        const first = rpc.filter((c) => c.name === name).length === 1;
        return Promise.resolve({ data: claim && (first ? claim : { host: claim.host, kind: claim.kind, skip: "hour" }), error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: source, error: null }) }) }),
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ error: null }),
        list: () => Promise.resolve({ data: [] }),
        remove: () => Promise.resolve({}),
      }),
    },
  };
  const asCaller = { rpc: () => Promise.resolve({ data: { ok: true }, error: null }) };
  return { db: db as unknown as SupabaseClient, asCaller: asCaller as unknown as SupabaseClient, rpc, updates };
}

async function upload(
  translate: Translator,
  csv = CSV,
  override: Parameters<typeof fakeSupabase>[0] = {},
  indexnow: { claim: IndexNowHostClaim; fetch: typeof fetch } | null = null,
) {
  const { db, asCaller, rpc, updates } = fakeSupabase(override, indexnow?.claim ?? null);
  const tasks: Promise<unknown>[] = [];
  const url = new URL(`http://localhost/stock-pull?shop_id=${SHOP}&file_time=2026-10-08T10:15:00Z&file_name=stock.csv`);
  const response = await receiveUpload(new Request(url, { method: "POST", body: csv }), url.searchParams, asCaller, db, {
    translate,
    background: (task) => tasks.push(task),
    ...(indexnow ? { indexnow: { key: KEY, mainHost: "ppi.example.com", fetch: indexnow.fetch, endpoint: "https://indexnow.test/indexnow" } } : {}),
  });
  const body = await response.json();
  const background = await Promise.all(tasks);
  return {
    body, background, calls: rpc.map((c) => c.name), rpc, updates,
    lastError: updates.map((u) => u.last_error).filter(Boolean).at(-1),
  };
}

Deno.test("a failed translation leaves the stock applied", async () => {
  const { body, background, calls, lastError } = await upload(() => Promise.reject(new Error("Claude is unavailable")));
  eq(body.result, { status: "updated", items: 2, zeroed: 0, skipped: 0 }, "stock applied");
  eq(calls, ["apply_stock_file", "record_stock_import", "items_to_translate"], "translations not saved");
  // IndexNow (no key: nothing), the website's cache (not set up: nothing), the translations
  eq(background, [{ host: null, sent: 0, status: null, skipped: "no key" }, null, { saved: 0, failed: 1 }, 0], "failure caught in the background");
  eq(lastError, "Item names could not be translated (the stock is fine): Claude is unavailable", "the owner sees why");
});

Deno.test("translations are saved after the stock, in the background", async () => {
  const { body, background, calls, rpc } = await upload((batch) =>
    Promise.resolve(batch.map((b) => ({ item_id: b.item_id, source: b.name, lang: "sk", sk: "Fasádna farba biela 5 l", hu: "Homlokzatfesték fehér 5 l", en: "White facade paint 5 l" }))),
  );
  eq(body.result.status, "updated", "stock applied");
  eq(calls, ["apply_stock_file", "record_stock_import", "items_to_translate", "apply_item_translations"], "order of database calls");
  eq((rpc[3].args.p_items as NameTranslation[])[0].en, "White facade paint 5 l", "saved translation");
  eq(background, [{ host: null, sent: 0, status: null, skipped: "no key" }, null, { saved: 1, failed: 0 }, 0], "one item translated (no IndexNow key, no cache settings: no request)");
});

// ---------------------------------------------------------------- IndexNow (update 36)

const ITEM_A = "11111111-1111-4111-8111-111111111111";
const ITEM_B = "22222222-2222-4222-8222-222222222222";
const KEY = "0123456789abcdef0123456789abcdef";
const SETTINGS = { key: KEY, mainHost: "ppi.example.com" };
const SITE_CLAIM: IndexNowHostClaim = {
  host: "potraviny.sk", kind: "site", lang: "sk", upto: "2026-10-14T08:00:00.123456+00:00", upto_id: ITEM_B,
  items: [{ id: ITEM_A, slug: "potraviny" }, { id: ITEM_B, slug: "potraviny" }],
};
const MAIN_CLAIM: IndexNowHostClaim = { ...SITE_CLAIM, host: "ppi.example.com", kind: "main", lang: null, items: [{ id: ITEM_A, slug: "drogeria" }] };

/** Records every IndexNow request; answers with the given status (or fails like a network error). */
function fakeIndexNow(status: number | "fail" = 202) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const f = ((url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return status === "fail" ? Promise.reject(new TypeError("connection refused")) : Promise.resolve(new Response(null, { status }));
  }) as unknown as typeof fetch;
  return { f, sent };
}

/** A database that answers indexnow_claim_host with `claim` and records the rest. */
function claimDb(claim: unknown, error: unknown = null) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db = { rpc: (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "indexnow_claim_host") return Promise.resolve({ data: error ? null : claim, error });
    return Promise.resolve({ data: null, error: null });
  } } as unknown as SupabaseClient;
  return { db, calls };
}

Deno.test("IndexNow: INDEXNOW_KEY and the host of SITE_URL; anything else means no request", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  eq(indexNowSettings(env({ INDEXNOW_KEY: ` ${KEY} `, SITE_URL: "https://PPI.Example.com/" })), { key: KEY, mainHost: "ppi.example.com" }, "both");
  eq(indexNowSettings(env({ INDEXNOW_KEY: "short", SITE_URL: "http://ppi.example.com" })), { key: null, mainHost: null }, "a short key, no https");
  eq(indexNowSettings(env({ INDEXNOW_KEY: "a/b/c/d/e/f/g/h", SITE_URL: "https://localhost" })), { key: null, mainHost: null }, "a key with slashes, no dot");
  eq(indexNowSettings(env({})), { key: null, mainHost: null }, "nothing set");
});

Deno.test("IndexNow: only the changed item pages on their canonical host, every language, at most 10 000 in one request", () => {
  eq(indexNowUrls(SITE_CLAIM), [
    `https://potraviny.sk/sk/items/${ITEM_A}`, `https://potraviny.sk/hu/items/${ITEM_A}`, `https://potraviny.sk/en/items/${ITEM_A}`,
    `https://potraviny.sk/sk/items/${ITEM_B}`, `https://potraviny.sk/hu/items/${ITEM_B}`, `https://potraviny.sk/en/items/${ITEM_B}`,
  ], "the own domain: its language first, nothing but the changed items");
  eq(indexNowUrls({ ...SITE_CLAIM, lang: "hu", items: [{ id: ITEM_A, slug: "x" }] })[0], `https://potraviny.sk/hu/items/${ITEM_A}`, "a Hungarian domain");
  eq(indexNowUrls(MAIN_CLAIM), [
    `https://ppi.example.com/sk/items/${ITEM_A}`, `https://ppi.example.com/hu/items/${ITEM_A}`, `https://ppi.example.com/en/items/${ITEM_A}`,
  ], "the main host: the Cacaduu item page");
  eq(indexNowUrls({ ...SITE_CLAIM, items: [] }), [], "nothing changed: no address");
  eq(indexNowUrls({ ...SITE_CLAIM, items: [{ id: "../../admin", slug: "x" }] }), [], "only item ids");
  const many = Array.from({ length: 5000 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, slug: "x" }));
  eq(indexNowUrls({ ...SITE_CLAIM, items: many }).length, 10_000, "one request holds at most 10 000");
  const payload = indexNowPayload("potraviny.sk", KEY, indexNowUrls(SITE_CLAIM));
  eq(Object.keys(payload), ["host", "key", "keyLocation", "urlList"], "IndexNow's fields");
  eq([payload.host, payload.key, payload.keyLocation], ["potraviny.sk", KEY, `https://potraviny.sk/${KEY}.txt`], "one host, its key file");
  eq(indexNowPayload("x.sk", KEY, Array(12_000).fill("https://x.sk/sk/items/1")).urlList.length, 10_000, "the payload is capped too");
});

Deno.test("IndexNow: one request after an applied upload, with the key file on that host; the answer is noted", async () => {
  const net = fakeIndexNow(202);
  const { body, background, calls, rpc } = await upload(() => Promise.resolve([]), CSV, {}, { claim: SITE_CLAIM, fetch: net.f });
  eq(body.result.status, "updated", "stock applied");
  eq(net.sent.length, 1, "exactly one request");
  eq(net.sent[0].url, "https://indexnow.test/indexnow", "to the endpoint");
  eq([net.sent[0].body.host, net.sent[0].body.key, net.sent[0].body.keyLocation], ["potraviny.sk", KEY, `https://potraviny.sk/${KEY}.txt`], "host and key");
  eq((net.sent[0].body.urlList as string[]).length, 6, "only the changed item pages");
  const claimed = rpc.find((c) => c.name === "indexnow_claim_host")!;
  eq([claimed.args.p_shop_id, claimed.args.p_main_host, claimed.args.p_max_items], [SHOP, "ppi.example.com", 3333], "claimed for this shop");
  const noted = rpc.find((c) => c.name === "indexnow_done")!;
  eq(noted.args, { p_host: "potraviny.sk", p_kind: "site", p_upto: SITE_CLAIM.upto, p_upto_id: ITEM_B, p_urls: 6, p_status: 202, p_result: "202" }, "the answer noted");
  eq(background[0], { host: "potraviny.sk", sent: 6, status: 202 }, "in the background");
  eq(calls.filter((c) => c === "indexnow_claim_host").length, 1, "claimed once per upload");
});

Deno.test("IndexNow: at most once an hour per host; nothing for a file already applied or an upload that changed nothing", async () => {
  const net = fakeIndexNow();
  const same = await upload(() => Promise.resolve([]), CSV, { latest_file_time: "2026-10-08T10:15:00Z" }, { claim: SITE_CLAIM, fetch: net.f });
  eq(same.body.result.status, "unchanged", "the same file again");
  eq([net.sent.length, same.calls.includes("indexnow_claim_host")], [0, false], "no claim, no request");

  const hour = claimDb({ host: "potraviny.sk", kind: "site", skip: "hour" });
  eq(await pingIndexNow(hour.db, SHOP, { ...SETTINGS, fetch: net.f }), { host: "potraviny.sk", sent: 0, status: null, skipped: "hour" }, "pinged this hour: waits");
  const nothing = claimDb({ host: "potraviny.sk", kind: "site", skip: "nothing" });
  eq((await pingIndexNow(nothing.db, SHOP, { ...SETTINGS, fetch: net.f })).skipped, "nothing", "nothing changed");
  const none = claimDb(null);
  eq((await pingIndexNow(none.db, SHOP, { ...SETTINGS, mainHost: null, fetch: net.f })).skipped, "no host", "no own domain and no SITE_URL");
  // before database update 36 the function does not exist: nothing happens
  const old = claimDb(null, { code: "PGRST202", message: "not found" });
  eq((await pingIndexNow(old.db, SHOP, { ...SETTINGS, fetch: net.f })).skipped, "database", "no update 36");
  const nokey = claimDb(SITE_CLAIM);
  eq((await pingIndexNow(nokey.db, SHOP, { key: null, mainHost: "ppi.example.com", fetch: net.f })).skipped, "no key", "no INDEXNOW_KEY");
  eq(nokey.calls.length, 0, "not even claimed");
  eq(net.sent.length, 0, "never a request");
  for (const c of [hour, nothing, none, old]) assert(!c.calls.some((x) => x.name === "indexnow_done"), "nothing noted");

  // two uploads in a row: the second one's changes wait for the next ping (the fake answers "hour" the second time)
  const two = fakeSupabase({}, SITE_CLAIM);
  eq((await pingIndexNow(two.db, SHOP, { ...SETTINGS, fetch: net.f })).sent, 6, "the first");
  eq((await pingIndexNow(two.db, SHOP, { ...SETTINGS, fetch: net.f })).skipped, "hour", "the second waits");
  eq(net.sent.length, 1, "one request");
});

Deno.test("IndexNow: a shop without its own domain pings the main Cacaduu host", async () => {
  const net = fakeIndexNow(200);
  const main = claimDb(MAIN_CLAIM);
  eq(await pingIndexNow(main.db, SHOP, { ...SETTINGS, fetch: net.f }), { host: "ppi.example.com", sent: 3, status: 200 }, "sent");
  eq([net.sent[0].body.host, net.sent[0].body.keyLocation], ["ppi.example.com", `https://ppi.example.com/${KEY}.txt`], "the main host's key file");
  assert((net.sent[0].body.urlList as string[]).every((u) => u.startsWith("https://ppi.example.com/")), "only Cacaduu addresses");
  eq(main.calls.find((c) => c.name === "indexnow_done")!.args.p_kind, "main", "noted for the main host");
});

Deno.test("IndexNow: a refusal or a network error is noted (sent again next time), never breaks the upload; the key is never logged", async () => {
  const logged: string[] = [];
  const original = { error: console.error, log: console.log };
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  console.log = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    for (const answer of [422, "fail"] as const) {
      const { db, calls } = claimDb(SITE_CLAIM);
      const out = await pingIndexNow(db, SHOP, { ...SETTINGS, fetch: fakeIndexNow(answer).f });
      eq(out, { host: "potraviny.sk", sent: 6, status: answer === "fail" ? null : 422 }, `answer ${answer}`);
      const done = calls.find((c) => c.name === "indexnow_done")!.args;
      eq([done.p_status, done.p_result], answer === "fail" ? [null, "failed: TypeError"] : [422, "422"], "noted (the database keeps the changes for the next ping)");
    }
    // the stock is applied even when IndexNow fails
    const { body, background } = await upload(() => Promise.resolve([]), CSV, {}, { claim: SITE_CLAIM, fetch: fakeIndexNow("fail").f });
    eq(body.result.status, "updated", "stock applied");
    eq(background[0], { host: "potraviny.sk", sent: 6, status: null }, "failed in the background only");
    // a crash inside is caught too
    const broken = { rpc: () => Promise.reject(new Error("database down")) } as unknown as SupabaseClient;
    const tasks: Promise<unknown>[] = [];
    const url = new URL(`http://localhost/stock-pull?shop_id=${SHOP}&file_time=2026-10-08T10:15:00Z&file_name=stock.csv`);
    const { db, asCaller } = fakeSupabase();
    const res = await receiveUpload(new Request(url, { method: "POST", body: CSV }), url.searchParams, asCaller, db, {
      translate: () => Promise.resolve([]),
      background: (task) => tasks.push(task),
      indexnow: { ...SETTINGS, fetch: fakeIndexNow().f },
    });
    eq((await res.json()).result.status, "updated", "applied");
    eq(await pingIndexNow(broken, SHOP, SETTINGS).catch(() => "caught by receiveUpload"), "caught by receiveUpload", "a crash is a rejection");
  } finally {
    console.error = original.error;
    console.log = original.log;
  }
  assert(logged.filter((l) => l.includes("IndexNow")).length >= 3, "each ping logged (host, addresses, answer)");
  assert(logged.every((l) => !l.includes(KEY)), "no key in the log");
});

// ---------------------------------------------------------------- private columns and import reports

Deno.test("columns that point to purchase prices, suppliers, margins or invoices are private", () => {
  eq(["Nákupná cena", "NC bez DPH", "Dodávateľ", "Marža %", "Číslo faktúry", "Beszerzési ár", "Supplier", "Invoice no", "Zisk"]
    .map(isPrivateColumn), Array(9).fill(true), "private");
  eq(["Cena s DPH", "Názov", "Množstvo", "EAN", "Kód", "Popis", "Mena", "Since"].map(isPrivateColumn), Array(8).fill(false), "ordinary");
});

Deno.test("the AI sees column names and at most 3 values, never values of private columns", () => {
  const rows = [
    { Kod: "C1", Nazov: "Farba", "Nákupná cena": "12,00", Dodavatel: "Veľkoobchod" },
    { Kod: "C2", Nazov: "Farba", "Nákupná cena": "3,00", Dodavatel: "Veľkoobchod" },
    { Kod: "C3", Nazov: "", "Nákupná cena": "4,00", Dodavatel: "Iný" },
    { Kod: "C4", Nazov: "Valček", "Nákupná cena": "1,00", Dodavatel: "Iný" },
    { Kod: "C5", Nazov: "Tmel", "Nákupná cena": "2,00", Dodavatel: "Iný" },
  ];
  eq(columnSamples(Object.keys(rows[0]), rows), [
    { column: "Kod", samples: ["C1", "C2", "C3"] },
    { column: "Nazov", samples: ["Farba", "Valček", "Tmel"] },
    { column: "Nákupná cena", samples: [] },
    { column: "Dodavatel", samples: [] },
  ], "names for all, values only for ordinary columns");
  eq(approvalSample(rows, Object.keys(rows[0])), [
    { Kod: "C1", Nazov: "Farba" }, { Kod: "C2", Nazov: "Farba" }, { Kod: "C3", Nazov: "" },
  ], "the owner's sample before approval: 3 rows, no private values");
  const mapping = { source_code: "Kod", name: "Nazov", ean: null, brand: null, quantity: null, price: null, currency: null };
  eq(mappedColumns(mapping), ["Kod", "Nazov"], "mapped columns");
  eq(onlyColumns(rows, mappedColumns(mapping), 2), [{ Kod: "C1", Nazov: "Farba" }, { Kod: "C2", Nazov: "Farba" }], "preview");
});

Deno.test("every received file gets a report; a file already applied does not", () => {
  eq(importReport({ status: "updated", items: 150, zeroed: 2, skipped: 0, rows: 150 }),
    { status: "ok", total: 150, imported: 150, zeroed: 2, skipped: 0, error: null }, "ok");
  eq(importReport({ status: "updated", items: 148, zeroed: 0, skipped: 2, rows: 150 })?.status, "errors", "rows skipped");
  eq(importReport({ status: "proposed", rows: 10 })?.status, "waiting", "columns wait for approval");
  eq(importReport({ status: "layout_changed", rows: 10, skipped: 9 }),
    { status: "errors", total: 10, imported: 0, zeroed: 0, skipped: 9,
      error: "9 of 10 rows could not be read — the file layout may have changed." }, "layout changed");
  eq(importReport({ status: "error", error: "The stock file is empty." })?.error, "The stock file is empty.", "failed");
  eq(importReport({ status: "unchanged" }), null, "nothing new");
});

const PRIVATE_CSV = "Kod;Nazov;Mnozstvo;Cena;Nákupná cena;Dodávateľ\nC1;Farba biela 5L;4;24,90;12,00;Veľkoobchod\nC2;Valček 25 cm;-1;6,90;3,00;Iný\n";

Deno.test("an applied file: the report and the sample keep only the mapped columns", async () => {
  const { body, rpc } = await upload(() => Promise.resolve([]), PRIVATE_CSV);
  eq(body.result, { status: "updated", items: 2, zeroed: 0, skipped: 0 }, "the uploader's answer has no rows");
  const apply = rpc.find((c) => c.name === "apply_stock_file")!;
  eq(apply.args.p_sample, [
    { Kod: "C1", Nazov: "Farba biela 5L", Mnozstvo: "4", Cena: "24,90" },
    { Kod: "C2", Nazov: "Valček 25 cm", Mnozstvo: "-1", Cena: "6,90" },
  ], "sample: mapped columns, as written");
  const report = rpc.find((c) => c.name === "record_stock_import")!.args;
  eq([report.p_status, report.p_total, report.p_imported, report.p_skipped, report.p_file_name],
    ["ok", 2, 2, 0, "stock.csv"], "report counts");
  eq(JSON.stringify(report.p_rows).includes("Veľkoobchod") || JSON.stringify(report.p_rows).includes("12,00"), false,
    "no private value in the report");
});

Deno.test("a new layout: proposed columns, a sample without private values, a waiting report", async () => {
  const { body, rpc, updates } = await upload(() => Promise.resolve([]), PRIVATE_CSV, { field_mapping: null, mapping_status: "proposed" });
  eq(body.result, { status: "proposed", rows: 2 }, "proposed");
  const saved = updates.find((u) => u.mapping_status === "proposed")!;
  eq(saved.file_columns, ["Kod", "Nazov", "Mnozstvo", "Cena", "Nákupná cena", "Dodávateľ"], "every column name is kept");
  eq(saved.sample_rows, [
    { Kod: "C1", Nazov: "Farba biela 5L", Mnozstvo: "4", Cena: "24,90" },
    { Kod: "C2", Nazov: "Valček 25 cm", Mnozstvo: "-1", Cena: "6,90" },
  ], "no private values before approval");
  const report = rpc.find((c) => c.name === "record_stock_import")!.args;
  eq([report.p_status, report.p_imported], ["waiting", 0], "waiting for the owner");
  eq(report.p_rows, [], "no preview rows before the columns are approved");
  eq(rpc.some((c) => c.name === "apply_stock_file"), false, "nothing applied before approval");
});

function ok(value: unknown, label: string) {
  if (!value) throw new Error(label);
}

// ---------------------------------------------------------------- update 40: encodings, texts, languages

/** A string in an 8-bit or Chinese encoding (only the letters these tests need). */
function encode(text: string, table: Record<string, number[]>): Uint8Array {
  return Uint8Array.from([...text].flatMap((c) => table[c] ?? [c.charCodeAt(0)]));
}

Deno.test("encodings: BOM, UTF-8, Windows-1250, Windows-1258 (Vietnamese) and GB18030 (Chinese) are told apart", () => {
  const csv = "Mã;Tên;Số lượng;Giá\n";
  eq(detectEncoding(new TextEncoder().encode("﻿Kód;Názov\nA;Káva\n")), "utf-8", "UTF-8 with BOM");
  eq(decodeText(new TextEncoder().encode("﻿Kód;Názov\n")).startsWith("Kód"), true, "the BOM is dropped");
  eq(detectEncoding(Uint8Array.from([0xff, 0xfe, 0x4b, 0x00])), "utf-16le", "UTF-16 BOM");
  eq(detectEncoding(new TextEncoder().encode(csv)), "utf-8", "valid UTF-8");
  // Windows-1258: ă = 0xE3, ơ = 0xF5, ư = 0xFD, đ = 0xF0, combining acute = 0xEC, combining grave = 0xCC
  const viet = encode("Mã;Tên;Số lượng\nV1;Bánh mì;3\nV2;Phở bò;2\nV3;Cà phê sữa đá;5\n", {
    "ã": [0x61, 0xde], "ê": [0xea], "ố": [0xf4, 0xec], "ư": [0xfd], "ợ": [0xf5, 0xf2], "á": [0xe1], "ì": [0x69, 0xcc],
    "ở": [0xf5, 0xd2], "ò": [0x6f, 0xcc], "à": [0xe0], "ữ": [0xfd, 0xde], "đ": [0xf0],
  });
  eq(detectEncoding(viet), "windows-1258", "Vietnamese shop software");
  // GB18030 / GBK: 白 = B0 D7, 色 = C9 AB, 油 = D3 CD, 漆 = C6 E1
  const zh = encode("Code;Name\nZ1;白色油漆\nZ2;白色油漆 5L\n", { "白": [0xb0, 0xd7], "色": [0xc9, 0xab], "油": [0xd3, 0xcd], "漆": [0xc6, 0xe1] });
  eq(detectEncoding(zh), "gb18030", "Chinese shop software");
  eq(decodeText(zh).includes("白色油漆"), true, "read as Chinese");
  const sk = encode("Kód;Názov\nP1;Čokoláda\nP2;Šľahačka\n", { "ó": [0xf3], "á": [0xe1], "Č": [0xc8], "Š": [0x8a], "ľ": [0xbe], "č": [0xe8] });
  eq(detectEncoding(sk), "windows-1250", "Central European stays Windows-1250");
});

Deno.test("preview: the chosen encoding, the columns that will be read, never a private one", () => {
  const zh = encode("Code;Name;Nákupná cena;Price;Qty\nZ1;白色油漆;10;12,90;3\n", { "白": [0xb0, 0xd7], "色": [0xc9, 0xab], "油": [0xd3, 0xcd], "漆": [0xc6, 0xe1], "á": [0xe1] });
  const auto = previewFile(zh, null, null);
  eq([auto.detected, auto.encoding, auto.rows], ["gb18030", "gb18030", 1], "detected");
  eq(auto.sample, [{ Code: "Z1", Name: "白色油漆", Qty: "3", Price: "12,90" }], "only the columns that will be read");
  const forced = previewFile(zh, "windows-1250", null);
  eq(forced.encoding, "windows-1250", "the owner's choice");
  ok(!JSON.stringify(forced.sample).includes("10"), "the purchase price is never shown");
});

Deno.test("description, category and a language per column (option A)", () => {
  const columns = ["Kód", "Názov", "Názov HU", "Popis", "Leírás (HU)", "Kategória", "Name_EN", "Množstvo", "Cena"];
  const mapping = guessMapping(columns);
  eq([mapping.name, mapping.description, mapping.category], ["Názov", "Popis", "Kategória"], "the main columns");
  const langs = guessLanguageColumns(columns, mapping, "sk");
  eq(langs, { "name@hu": "Názov HU", "description@hu": "Leírás (HU)", "name@en": "Name_EN" }, "proposed from the names");
  eq(languageField("name@zh-hans"), ["name", "zh-hans"], "Chinese column");
  eq(languageField("price@hu"), null, "only text fields come in languages");
  const full = { ...mapping, ...langs } as Mapping;
  ok(isValidMapping(full, columns), "valid");
  ok(!isValidMapping({ ...full, "price@hu": "Cena" } as Mapping, columns), "no other fields per language");
  const { good, texts } = applyMapping(
    [{ "Kód": "P1", "Názov": "Farba biela", "Názov HU": "Fehér festék", "Popis": "Na fasády", "Leírás (HU)": "", "Kategória": "Farby", "Name_EN": "White paint", "Množstvo": "3", "Cena": "9,90" }],
    full,
    "EUR",
  );
  eq(good[0], { source_code: "P1", name: "Farba biela", ean: null, brand: null, quantity: 3, price: 9.9, currency: "EUR" }, "stock rows unchanged");
  eq(texts, [{ source_code: "P1", description: "Na fasády", category: "Farby", has_texts: true, i18n: { hu: { name: "Fehér festék" }, en: { name: "White paint" } } }], "texts kept apart");
  eq(applyMapping([{ "Kód": "P1", "Názov": "x", "Množstvo": "1", "Cena": "1" }], { ...mapping, description: null, category: null } as Mapping, "EUR").texts, [], "no text columns: nothing extra");
});

Deno.test("a second file in another language (option B): matched by code or EAN, quantity and price only to compare", () => {
  const rows: Record<string, string>[] = [
    { "Kód": "P1", "EAN": "", "Megnevezés": "Fehér festék", "Készlet": "99", "Ár": "9,90", "Beszerzési ár": "5" },
    { "Kód": "", "EAN": "8590000000011", "Megnevezés": "Kávé", "Készlet": "", "Ár": "", "Beszerzési ár": "" },
    { "Kód": "", "EAN": "", "Megnevezés": "Nincs kódja", "Készlet": "", "Ár": "", "Beszerzési ár": "" },
  ];
  const mapping = guessMapping(Object.keys(rows[0]).filter((c) => !isPrivateColumn(c)));
  eq([mapping.source_code, mapping.ean, mapping.name, mapping.quantity, mapping.price], ["Kód", "EAN", "Megnevezés", "Készlet", "Ár"], "Hungarian file");
  eq(languageRows(rows, mapping), [
    { source_code: "P1", ean: null, name: "Fehér festék", description: null, category: null, quantity: 99, price: 9.9 },
    { source_code: null, ean: "8590000000011", name: "Kávé", description: null, category: null, quantity: null, price: null },
  ], "a row without code and EAN is left out; the purchase price is never read");
});

Deno.test("the website's cache: SITE_URL + REVALIDATE_SECRET, one POST per shop, never the secret in the address", async () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  const SECRET = "0123456789abcdef0123";
  eq(revalidateSettings(env({ SITE_URL: "https://ppi.example.com/sk", REVALIDATE_SECRET: ` ${SECRET} ` })), { url: "https://ppi.example.com", secret: SECRET }, "both");
  eq(revalidateSettings(env({ SITE_URL: "http://ppi.example.com", REVALIDATE_SECRET: "short" })), { url: null, secret: null }, "no https, a short secret");
  eq(revalidateSettings(env({})), { url: null, secret: null }, "nothing set");

  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  eq(await revalidateSite({ url: "https://ppi.example.com", secret: SECRET, fetch: fake }, "potraviny-centrum"), 200, "sent");
  eq(calls.length, 1, "one request");
  eq(calls[0].url, "https://ppi.example.com/api/revalidate", "the website's address");
  eq((calls[0].init.headers as Record<string, string>)["x-ppi-revalidate"], SECRET, "the secret in a header");
  eq(JSON.parse(String(calls[0].init.body)), { slug: "potraviny-centrum" }, "the shop");
  eq(calls[0].url.includes(SECRET), false, "never in the address");
  eq(await revalidateSite({ url: null, secret: SECRET, fetch: fake }, "x"), null, "no SITE_URL: nothing");
  eq(await revalidateSite({ url: "https://ppi.example.com", secret: SECRET, fetch: fake }, null), null, "no shop: nothing");
  eq(calls.length, 1, "nothing more sent");
  const failing = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
  eq(await revalidateSite({ url: "https://ppi.example.com", secret: SECRET, fetch: failing }, "x"), null, "a failure never throws");
});

// ---------------------------------------------------------------- update 43: deleting the uploaded files

/** A Storage bucket of raw files and the database calls of a "delete_files" request. */
function rawFilesDb(names: string[], before: string | null, member = true) {
  const stored = new Set(names.map((n) => `${SHOP}/${n}`));
  const removed: string[] = [];
  const rpc: { name: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc(name: string, args: Record<string, unknown>) {
      rpc.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
    from: () => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { raw_files_delete_before: before }, error: null }) }) }) }),
    storage: {
      from: (bucket: string) => {
        assert(bucket === "raw-files", "only the raw files bucket");
        return {
          list: (folder: string) => Promise.resolve({ data: [...stored].filter((p) => p.startsWith(`${folder}/`)).map((p) => ({ name: p.split("/")[1] })), error: null }),
          remove: (paths: string[]) => {
            for (const p of paths) {
              stored.delete(p);
              removed.push(p);
            }
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
  const asCaller = {
    rpc: (name: string) => {
      rpc.push({ name, args: {} });
      return Promise.resolve(member ? { data: before, error: null } : { data: null, error: { message: "Not a member of this shop" } });
    },
  };
  return { db: db as unknown as SupabaseClient, asCaller: asCaller as unknown as SupabaseClient, removed, rpc, stored };
}

const BEFORE = "2026-10-23T08:00:00.000Z";
const OLD = `${Date.parse(BEFORE) - 60_000}.csv`;
const SAME = `${Date.parse(BEFORE)}.xlsx`;
const NEWER = `${Date.parse(BEFORE) + 1}.xml`;

Deno.test("deleting the uploaded files: only those saved up to the owner's tap; a newer upload stays", () => {
  eq(rawFilesUpTo([OLD, SAME, NEWER, "notes.txt"], BEFORE), [OLD, SAME], "by the time in the name");
  eq(rawFilesUpTo([OLD], "not a time"), [], "no time: nothing");
});

Deno.test("delete_files: the owner's login decides; the raw files go from Storage and the mark is cleared", async () => {
  const url = new URL(`http://localhost/stock-pull?shop_id=${SHOP}&action=delete_files`);
  const owner = rawFilesDb([OLD, SAME, NEWER], BEFORE);
  const res = await receiveUpload(new Request(url, { method: "POST" }), url.searchParams, owner.asCaller, owner.db);
  eq(res.status, 200, "done");
  eq(await res.json(), { deleted: 2 }, "two files");
  eq([...owner.stored], [`${SHOP}/${NEWER}`], "the newer upload stays");
  eq(owner.rpc.map((c) => c.name), ["owner_raw_files_to_delete", "raw_files_deleted"], "asked with the owner's login, then cleared");
  eq(owner.rpc[1].args, { p_shop_id: SHOP, p_before: BEFORE }, "cleared only for that time");

  const stranger = rawFilesDb([OLD], BEFORE, false);
  const refused = await receiveUpload(new Request(url, { method: "POST" }), url.searchParams, stranger.asCaller, stranger.db);
  eq(refused.status, 403, "another shop's owner");
  eq(stranger.removed, [], "nothing deleted");

  const nothing = rawFilesDb([OLD], null);
  const none = await receiveUpload(new Request(url, { method: "POST" }), url.searchParams, nothing.asCaller, nothing.db);
  eq(await none.json(), { deleted: 0 }, "no deletion asked: nothing deleted");
  eq(nothing.removed, [], "the files stay");
});
