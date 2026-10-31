// Unit tests (Deno) of the translation files on the shop PC (update 45): the .xlsx writer and reader (also files as
// Excel saves them), the files' columns, and the owner's edits read back against what Cacaduu wrote (an empty cell
// changes nothing, read-only columns are only listed, unknown rows are ignored, rows matched by Kód then EAN).
// Run: npm run test:export
import {
  buildSheets,
  editsOf,
  fileName,
  isExportFileName,
  langColumns,
  mainColumns,
  numberCell,
  readEdits,
  buildWorkbook,
  type ExportFileLabels,
  type ExportInfo,
  type ExportRow,
} from "./exportFiles.ts";
import { columnIndex, columnName, readXlsx, unzip, writeXlsx, zip } from "./xlsx.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

/** The edits without "before" (what Cacaduu wrote, only for the preview). */
const plain = (edits: { code: string; ean: string | null; field: string; text: string }[]) =>
  edits.map(({ code, ean, field, text }) => ({ code, ean, field, text }));

const text = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

const labels: ExportFileLabels = {
  sheet_data: "Sklad",
  sheet_help: "Návod",
  col_code: "Kód",
  col_original: "Pôvodný názov",
  col_name: "Názov",
  col_desc: "Popis",
  col_cat: "Kategória",
  col_state: "Stav",
  col_popis: "Popis",
  col_popis_state: "Stav popisu",
  state_name: "Názov",
  state_desc: "Popis",
  state_cat: "Kategória",
  tr_missing: "chýba",
  tr_ai: "automaticky",
  tr_manual: "upravené ručne",
  tr_shop: "od obchodu",
  tr_stale: "zastaraný",
  tr_original: "originál",
  desc_shop: "zo súboru obchodu",
  desc_published: "zverejnený",
  desc_draft: "návrh",
  desc_none: "bez popisu",
  help_main_1: "Hlavný súbor.",
  help_main_2: "Meniť sa dá len Popis.",
  help_main_3: "",
  help_lang_1: "Preklady.",
  help_lang_2: "Meniť sa dá Názov, Popis a Kategória.",
  help_lang_3: "",
  help_all_1: "Prázdna bunka nič nemení.",
  help_all_2: "",
  help_all_3: "",
};

const info: ExportInfo = {
  main_lang: "sk",
  langs: ["hu"],
  columns: [
    { field: "source_code", column: "Kod" },
    { field: "name", column: "Nazov" },
    { field: "ean", column: "EAN" },
    { field: "quantity", column: "Mnozstvo" },
    { field: "price", column: "Cena" },
  ],
  confirmed: true,
  items: 3,
  delete_files_at: null,
  version: "v1",
};

const row = (code: string, extra: Partial<ExportRow> = {}): ExportRow => ({
  item_id: `id-${code}`,
  code,
  ean: null,
  name: `Tovar ${code}`,
  brand: null,
  quantity: 2,
  price: 12.5,
  currency: "EUR",
  description: null,
  category: null,
  d_text: null,
  d_state: "none",
  tr_name: null,
  st_name: null,
  tr_desc: null,
  st_desc: null,
  tr_cat: null,
  st_cat: null,
  ...extra,
});

const ROWS = [
  row("A1", { ean: "8580000000011", d_text: "Biela farba.", d_state: "published" }),
  row("A2", { ean: "8580000000028" }),
  row("A3"),
];
const SHOP = "11111111-1111-1111-1111-111111111111";

function mainSheets() {
  return buildSheets({ shopId: SHOP, lang: null, mainLang: "sk", columns: mainColumns(info, labels, "sk"), rows: ROWS, labels, writtenAt: "2026-10-27T08:00:00Z" });
}

/** The data sheet as the owner left it, with the other sheets as written. */
function edited(sheets: ReturnType<typeof mainSheets>, rows: string[][]) {
  return sheets.map((s, i) => ({ name: s.name, hidden: Boolean(s.hidden), rows: i === 0 ? rows : s.rows }));
}

Deno.test("xlsx: written cells come back as written; every column is text, the header bold, frozen and filtered", async () => {
  const bytes = await writeXlsx([
    { name: "Sklad", rows: [["Kód", "Názov"], ["007", "Farba „biela“ & <modrá> 5 l"], ["8580000000011", " medzera "], ["", "riadok\ndva"]], header: true, widths: [10, 40] },
    { name: "_cacaduu", rows: [["x"]], hidden: true },
  ]);
  const sheets = await readXlsx(bytes);
  eq(sheets.map((s) => [s.name, s.hidden]), [["Sklad", false], ["_cacaduu", true]], "sheets and the hidden one");
  eq(sheets[0].rows, [["Kód", "Názov"], ["007", "Farba „biela“ & <modrá> 5 l"], ["8580000000011", " medzera "], ["", "riadok\ndva"]], "values");
  const files = await unzip(bytes);
  const sheet = str(files.get("xl/worksheets/sheet1.xml")!);
  const workbook = str(files.get("xl/workbook.xml")!);
  eq(/state="frozen"/.test(sheet) && /<autoFilter ref="A1:B4"\/>/.test(sheet), true, "frozen header + filter");
  eq(/<c r="A1" s="2"/.test(sheet) && /style="1"/.test(sheet), true, "bold header, text columns");
  eq(/numFmtId="49"/.test(str(files.get("xl/styles.xml")!)), true, "the text format");
  eq(/state="veryHidden"/.test(workbook) && /_xlnm\._FilterDatabase/.test(workbook), true, "very hidden sheet, filter name");
  eq([columnName(0), columnName(25), columnName(26), columnName(701), columnIndex("AB")], ["A", "Z", "AA", "ZZ", 27], "column letters");
});

Deno.test("xlsx: a file as Excel saves it (shared strings, rich text, numbers, escapes, absolute targets)", async () => {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const bytes = await zip([
    { name: "xl/workbook.xml", data: text(`<workbook ${ns} xmlns:r="r"><sheets><sheet name="Sklad" sheetId="1" r:id="rId1"/><sheet name="_cacaduu" sheetId="2" state="veryHidden" r:id="rId2"/></sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: text('<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>') },
    { name: "xl/sharedStrings.xml", data: text(`<sst ${ns}><si><t>Kód</t></si><si><r><t>Fehér </t></r><r><rPr><b/></rPr><t>festék</t></r><rPh><t>x</t></rPh></si><si><t xml:space="preserve">A&amp;B_x000D_</t></si></sst>`) },
    { name: "xl/worksheets/sheet1.xml", data: text(`<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="3"><c t="s"><v>2</v></c><c><v>8.58E+12</v></c><c t="b"><v>1</v></c><c t="str"><v>x</v></c></row></sheetData></worksheet>`) },
    { name: "xl/worksheets/sheet2.xml", data: text(`<worksheet ${ns}><sheetData/></worksheet>`) },
  ]);
  const [data, hidden] = await readXlsx(bytes);
  eq(data.rows, [["Kód", "", "Fehér festék"], [], ["A&B\r", "8580000000000", "TRUE", "x"]], "cells");
  eq(hidden.hidden, true, "veryHidden");
  await readXlsx(text("not a zip")).then(() => { throw new Error("read garbage"); }, (e: Error) => eq(e.message, "not_xlsx", "garbage refused"));
});

Deno.test("the files: names, columns, values and the hidden sheet", () => {
  eq([fileName("sk"), fileName("zh-hans")], ["sklad.sk.xlsx", "sklad.zh-hans.xlsx"], "file names");
  eq([isExportFileName("sklad.hu.xlsx"), isExportFileName("sklad.sr-cyrl.xlsx"), isExportFileName("sklad.xlsx"), isExportFileName("export.csv")], [true, true, false, false], "ours");
  eq([numberCell(12.5, "sk"), numberCell(1234.5, "en"), numberCell(null, "sk")], ["12,5", "1234.5", ""], "numbers without grouping");
  const [data, help, hidden] = mainSheets();
  eq(data.rows[0], ["Kod", "Nazov", "EAN", "Mnozstvo", "Cena", "Popis", "Stav popisu"], "the stock file's own column names, then Popis");
  eq(data.rows[1], ["A1", "Tovar A1", "8580000000011", "2", "12,5", "Biela farba.", "zverejnený"], "a row");
  eq(help.rows.slice(0, 2), [["Hlavný súbor."], ["Meniť sa dá len Popis."]], "Návod");
  eq(hidden.hidden && hidden.rows[0].slice(0, 4), ["cacaduu-ppi-export", "1", SHOP, ""], "meta");
  eq(hidden.rows[3].at(-1), "ean:8580000000011", "the EAN of each row");
  const lang = langColumns(labels).map((c) => c.header);
  eq(lang, ["Kód", "Pôvodný názov", "Názov", "Popis", "Kategória", "Stav"], "a language file's columns");
  const state = langColumns(labels).at(-1)!.value(row("B", { st_name: "ai", st_desc: "missing", st_cat: "no_source" }));
  eq(state, "Názov: automaticky · Popis: chýba", "Stav");
});

Deno.test("edits: the owner's changed Popis; empty cells, read-only columns and unknown rows", () => {
  const sheets = mainSheets();
  const [head, a1, a2, a3] = sheets[0].rows;
  const result = editsOf(edited(sheets, [
    head,
    // sorted differently; A3: a new description; A1: the description emptied (no change) and a price typed (read-only)
    [...a3.slice(0, 5), "Valček na farbu.", a3[6]],
    [...a1.slice(0, 4), "9,90", "", a1[6]],
    a2,
    ["ZZ9", "Neznámy", "", "1", "1", "x", ""],
    ["", "", "", "", "", "", ""],
  ]));
  eq(result.lang, null, "the main file");
  eq(result.shopId, SHOP, "its shop");
  eq(plain(result.edits), [{ code: "A3", ean: null, field: "description", text: "Valček na farbu." }], "one edit");
  eq(result.edits[0].before, a3[5], "what was written before (the preview, update 62)");
  eq(result.readonly, [{ code: "A1", column: "Cena" }], "the price is only listed");
  eq(result.unknown, ["ZZ9"], "an unknown row");
});

Deno.test("edits: matched by EAN when the code is gone; columns found by their header when moved", () => {
  const sheets = mainSheets();
  const [head, a1] = sheets[0].rows;
  // Popis moved first, the code removed from A1's row
  const moved = (r: string[]) => [r[5], ...r.slice(0, 5), r[6]];
  const result = editsOf(edited(sheets, [moved(head), moved(["", ...a1.slice(1, 5), "Biela farba na steny.", a1[6]])]));
  eq(plain(result.edits), [{ code: "A1", ean: "8580000000011", field: "description", text: "Biela farba na steny." }], "found by EAN");
});

Deno.test("edits: a language file (Názov, Popis, Kategória editable; Stav only listed)", async () => {
  const rows = [row("A1", { tr_name: "Fehér festék", st_name: "ai", st_desc: "no_source", st_cat: "missing" }), row("A2", { st_name: "missing" })];
  const bytes = await buildWorkbook({ shopId: SHOP, lang: "hu", mainLang: "sk", columns: langColumns(labels), rows, labels, writtenAt: "2026-10-27T08:00:00Z" });
  const sheets = await readXlsx(bytes);
  const [head, a1, a2] = sheets[0].rows;
  sheets[0].rows = [head, [a1[0], a1[1], "Fehér falfesték 5 l", "", "Festékek", "Názov: hotovo"], [a2[0], a2[1], "Ecset", "", "", a2[5]]];
  const result = editsOf(sheets);
  eq(result.lang, "hu", "the language");
  eq(plain(result.edits), [
    { code: "A1", ean: null, field: "name", text: "Fehér falfesték 5 l" },
    { code: "A1", ean: null, field: "category", text: "Festékek" },
    { code: "A2", ean: null, field: "name", text: "Ecset" },
  ], "edits");
  eq(result.readonly, [{ code: "A1", column: "Stav" }], "Stav is only listed");
  // the same bytes unchanged: nothing to do
  eq((await readEdits(bytes)).edits.length, 0, "an unchanged file");
});

Deno.test("edits: a file that is not Cacaduu's is never read as one", async () => {
  const other = await writeXlsx([{ name: "Hárok1", rows: [["Kód", "Názov"], ["A1", "x"]] }]);
  await readEdits(other).then(() => { throw new Error("read another file"); }, (e: Error) => eq(e.message, "not_ours", "refused"));
});
