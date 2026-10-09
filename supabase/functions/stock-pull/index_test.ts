// Run: npm run test:functions   (sets PPI_STOCK_PULL_TEST so the server does not start)
import * as XLSX from "npm:@e965/xlsx@0.20.3";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  applyMapping, approvalSample, batches, columnSamples, currencyForCountry, decodeText, detectFormat, guessMapping,
  importReport, isPrivateColumn, mappedColumns, onlyColumns, parseFile, parseNumber, readTranslations, receiveUpload,
  type Mapping, type NameTranslation, type Translator,
} from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}\n  expected ${e}\n  got      ${a}`);
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
  eq(mapping, { source_code: "Kód", name: "Názov tovaru", ean: "EAN", brand: null, quantity: "Množstvo", price: "Cena s DPH", currency: null }, "Slovak mapping");
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
function fakeSupabase(override: Partial<{ field_mapping: Mapping | null; mapping_status: string }> = {}) {
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

async function upload(translate: Translator, csv = CSV, override: Parameters<typeof fakeSupabase>[0] = {}) {
  const { db, asCaller, rpc, updates } = fakeSupabase(override);
  const tasks: Promise<unknown>[] = [];
  const url = new URL(`http://localhost/stock-pull?shop_id=${SHOP}&file_time=2026-10-08T10:15:00Z&file_name=stock.csv`);
  const response = await receiveUpload(new Request(url, { method: "POST", body: csv }), url.searchParams, asCaller, db, {
    translate,
    background: (task) => tasks.push(task),
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
  eq(background, [{ saved: 0, failed: 1 }], "failure caught in the background");
  eq(lastError, "Item names could not be translated (the stock is fine): Claude is unavailable", "the owner sees why");
});

Deno.test("translations are saved after the stock, in the background", async () => {
  const { body, background, calls, rpc } = await upload((batch) =>
    Promise.resolve(batch.map((b) => ({ item_id: b.item_id, source: b.name, lang: "sk", sk: "Fasádna farba biela 5 l", hu: "Homlokzatfesték fehér 5 l", en: "White facade paint 5 l" }))),
  );
  eq(body.result.status, "updated", "stock applied");
  eq(calls, ["apply_stock_file", "record_stock_import", "items_to_translate", "apply_item_translations"], "order of database calls");
  eq((rpc[3].args.p_items as NameTranslation[])[0].en, "White facade paint 5 l", "saved translation");
  eq(background, [{ saved: 1, failed: 0 }], "one item translated");
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
