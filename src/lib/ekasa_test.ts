// Unit tests of "Import z eKasa" (database update 71): reading the export as written — CSV separators, quotes,
// Windows-1250, XLSX, the column guess, numbers, the receipt time in the shop's time zone (also across a clock change),
// and the lines SQL books. Run: npm run test:sklad
import { columnsFit, decodeText, ekasaNumber, ekasaTime, guessColumns, parseCsv, readTable, toLines } from "./ekasa.ts";
import { writeXlsx } from "./xlsx.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

Deno.test("CSV: ; , and tab, quotes, CRLF, empty lines", () => {
  eq(parseCsv('Názov;Množstvo\r\n"Farba ""biela"" 5 l";2\r\n\r\nValček;1'), [["Názov", "Množstvo"], ['Farba "biela" 5 l', "2"], ["Valček", "1"]], ";");
  eq(parseCsv("a,b\n1,\"2,5\""), [["a", "b"], ["1", "2,5"]], ",");
  eq(parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]], "tab");
});

Deno.test("text: UTF-8 with a BOM, else Windows-1250", () => {
  eq(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0xc5, 0xa0])), "Š", "BOM");
  eq(decodeText(new Uint8Array([0x8a, 0x74, 0x65, 0x74, 0x65, 0x63])), "Štetec", "Windows-1250");
});

Deno.test("XLSX and CSV give the same table", async () => {
  const rows = [["Názov", "Množstvo", "Číslo dokladu"], ["Farba", "2", "O-1"]];
  const x = await readTable(await writeXlsx([{ name: "Export", rows }]), "export.xlsx");
  const c = await readTable(new TextEncoder().encode("Názov;Množstvo;Číslo dokladu\nFarba;2;O-1\n"), "export.csv");
  eq(x, c, "same");
  eq(c.headers, rows[0], "headers");
});

Deno.test("the column guess, one column per field; what is usable", () => {
  const h = ["Dátum a čas", "Číslo dokladu", "Názov položky", "PLU", "EAN", "Množstvo", "Jednotková cena", "Pokladník"];
  const g = guessColumns(h);
  eq(g, { ean: "EAN", code: "PLU", doc: "Číslo dokladu", time: "Dátum a čas", qty: "Množstvo", price: "Jednotková cena", product: "Názov položky" }, "guess");
  eq(columnsFit(g, h), true, "fits");
  eq(columnsFit({ product: "Názov položky", qty: "Množstvo" }, h), false, "needs a receipt or a time");
  eq(columnsFit(g, h.slice(1)), false, "a named column is missing");
});

Deno.test("numbers as written", () => {
  eq(ekasaNumber("1 234,50"), "1234.5", "space + comma");
  eq(ekasaNumber("1,234.50"), "1234.5", "comma thousands");
  eq(ekasaNumber("−2"), "-2", "minus sign");
  eq(ekasaNumber("3 ks"), "3", "unit");
  eq(ekasaNumber("24,90 €"), "24.9", "euro");
  eq(ekasaNumber("abc"), null, "text");
  eq(ekasaNumber(""), null, "empty");
});

Deno.test("receipt times in the shop's time zone, across the clock change", () => {
  eq(ekasaTime("01.11.2026 08:10:00", "Europe/Bratislava"), "2026-11-01T07:10:00.000Z", "winter (+1)");
  eq(ekasaTime("1.7.2026 8:10", "Europe/Bratislava"), "2026-07-01T06:10:00.000Z", "summer (+2)");
  eq(ekasaTime("2026-11-01 08:10", "Europe/Budapest"), "2026-11-01T07:10:00.000Z", "ISO without an offset");
  eq(ekasaTime("2026-11-01T08:10:00+01:00", "Europe/London"), "2026-11-01T07:10:00.000Z", "with an offset: as written");
  eq(ekasaTime("25.10.2026 02:30", "Europe/Bratislava"), "2026-10-25T00:30:00.000Z", "the repeated hour: the first one");
  eq(ekasaTime("29.3.2026 02:30", "Europe/Bratislava"), "2026-03-29T01:30:00.000Z", "the skipped hour: still winter time");
  eq(ekasaTime("45962.5", "Europe/Bratislava"), "2025-11-01T11:00:00.000Z", "an Excel date number");
  eq(ekasaTime("včera", "Europe/Bratislava"), null, "not a time");
});

Deno.test("lines by the approved columns; rows without a product or a number are dropped", () => {
  const table = {
    headers: ["Doklad", "Čas", "Položka", "Ks", "Cena", "EAN"],
    rows: [
      ["O-1", "01.11.2026 08:10", "Farba 5 l", "2", "24,90", "858 0000 102315"],
      ["O-1", "01.11.2026 08:10", "", "1", "1", ""],
      ["O-2", "01.11.2026 09:00", "Valček", "x", "", ""],
      ["O-3", "", "Vrátenie valček", "-1", "7,50", ""],
    ],
  };
  eq(
    toLines(table, { doc: "Doklad", time: "Čas", product: "Položka", qty: "Ks", price: "Cena", ean: "EAN" }, "Europe/Bratislava"),
    [
      { doc: "O-1", time: "2026-11-01T07:10:00.000Z", text: "Farba 5 l", code: null, ean: "8580000102315", qty: "2", price: "24.9" },
      { doc: "O-3", time: null, text: "Vrátenie valček", code: null, ean: null, qty: "-1", price: "7.5" },
    ],
    "lines",
  );
});
