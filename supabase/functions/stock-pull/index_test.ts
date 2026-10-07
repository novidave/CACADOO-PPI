// Run: npm run test:functions   (sets PPI_STOCK_PULL_TEST so the server does not start)
import * as XLSX from "npm:@e965/xlsx@0.20.3";
import {
  applyMapping, currencyForCountry, decodeText, detectFormat, guessMapping, isAllowedFileUrl, parseFile, parseNumber, type Mapping,
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

Deno.test("only public https file addresses are downloaded", () => {
  const ok = ["https://drive.google.com/uc?export=download&id=abc", "https://www.dropbox.com/s/x/stock.csv?dl=1"];
  const bad = ["http://example.com/a.csv", "https://localhost/a.csv", "https://127.0.0.1/a.csv", "https://[::1]/a.csv",
    "https://intranet/a.csv", "https://db.internal/a.csv", "https://user:pw@example.com/a.csv", "file:///etc/passwd", "nonsense"];
  eq(ok.map((u) => isAllowedFileUrl(u)), [true, true], "allowed");
  eq(bad.map((u) => isAllowedFileUrl(u)), bad.map(() => false), "refused");
});
