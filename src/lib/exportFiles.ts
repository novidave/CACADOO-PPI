import { readXlsx, writeXlsx, type SheetIn, type SheetOut } from "./xlsx";

/**
 * The translation files Cacaduu writes into the shop PC's translations folder (update 45) and how the owner's edits
 * come back: sklad.<main>.xlsx (the approved columns as the stock file names them + "Popis" + "Stav popisu") and
 * sklad.<lang>.xlsx (Kód, Pôvodný názov, Názov, Popis, Kategória, Stav). Each file also holds a "Návod" sheet and a
 * very hidden sheet with what was written (the keys of the columns, their headers and every value), so an edit is
 * exactly a cell that differs from what Cacaduu wrote — wherever the file was opened, sorted or filtered.
 * Only the approved columns are ever in a file (private columns are never stored by PPI).
 */

export const HIDDEN_SHEET = "_cacaduu";
export const FORMAT = "cacaduu-ppi-export";
export const VERSION = "1";

/** owner_export_info() */
export interface ExportInfo {
  main_lang: string;
  langs: string[];
  columns: { field: MappedField; column: string }[];
  confirmed: boolean;
  items: number;
  delete_files_at: string | null;
  version: string;
}

export type MappedField = "source_code" | "name" | "ean" | "brand" | "quantity" | "price" | "currency" | "description" | "category";
export type TrState = "shop" | "ai" | "manual" | "stale" | "missing" | "none" | "original" | "no_source";
export type DescState = "shop" | "published" | "draft" | "none";

/** owner_export_rows() */
export interface ExportRow {
  item_id: string;
  code: string;
  ean: string | null;
  name: string;
  brand: string | null;
  quantity: number | null;
  price: number | null;
  currency: string | null;
  description: string | null;
  category: string | null;
  d_text: string | null;
  d_state: DescState;
  tr_name: string | null;
  st_name: TrState | null;
  tr_desc: string | null;
  st_desc: TrState | null;
  tr_cat: string | null;
  st_cat: TrState | null;
}

/** The texts of the files (the owner's page language). */
export interface ExportFileLabels {
  sheet_data: string;
  sheet_help: string;
  col_code: string;
  col_original: string;
  col_name: string;
  col_desc: string;
  col_cat: string;
  col_state: string;
  col_popis: string;
  col_popis_state: string;
  state_name: string;
  state_desc: string;
  state_cat: string;
  [key: `tr_${string}` | `desc_${string}` | `help_${string}`]: string;
}

/** An edit for owner_apply_export_edits(). */
export interface Edit {
  code: string;
  ean: string | null;
  field: "description" | "name" | "category";
  text: string;
  /** what Cacaduu wrote into that cell (shown in the preview before saving; never sent to the database) */
  before?: string;
}

export interface FileEdits {
  shopId: string;
  /** null = the main file */
  lang: string | null;
  edits: Edit[];
  /** cells of columns that cannot be changed here (only listed) */
  readonly: { code: string; column: string }[];
  /** rows whose code (or EAN) is in no product of the file */
  unknown: string[];
}

export const fileName = (lang: string) => `sklad.${lang}.xlsx`;

/** A name Cacaduu gives its files (also ignored by the stock folder's watcher). */
export function isExportFileName(name: string): boolean {
  return /^sklad\.[a-z]{2,3}(-[a-z]{2,4})?\.xlsx$/i.test(name);
}

const norm = (value: string | null | undefined) => (value ?? "").replace(/\r\n?/g, "\n").trim();

/** A number as the file shows it (no grouping; the decimal sign of the page language). */
export function numberCell(value: number | null, lang: string): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  return Number(value).toLocaleString(lang, { useGrouping: false, maximumFractionDigits: 6 });
}

interface Column {
  key: string;
  header: string;
  width: number;
  value: (row: ExportRow) => string;
}

const EDITABLE_MAIN: Record<string, Edit["field"]> = { popis: "description" };
const EDITABLE_LANG: Record<string, Edit["field"]> = { tr_name: "name", tr_desc: "description", tr_cat: "category" };

/** The main file's columns: the approved ones as the stock file names them, then "Popis" and "Stav popisu". */
export function mainColumns(info: ExportInfo, labels: ExportFileLabels, lang: string): Column[] {
  const fieldValue = (field: MappedField) => (row: ExportRow): string => {
    switch (field) {
      case "source_code":
        return row.code;
      case "quantity":
        return numberCell(row.quantity, lang);
      case "price":
        return numberCell(row.price, lang);
      default:
        return row[field] ?? "";
    }
  };
  const widths: Partial<Record<MappedField, number>> = { source_code: 14, name: 40, ean: 16, description: 40 };
  return [
    ...info.columns.map((c) => ({ key: `f:${c.field}`, header: c.column, width: widths[c.field] ?? 14, value: fieldValue(c.field) })),
    { key: "popis", header: labels.col_popis, width: 60, value: (r: ExportRow) => r.d_text ?? "" },
    { key: "popis_state", header: labels.col_popis_state, width: 24, value: (r: ExportRow) => labels[`desc_${r.d_state}`] ?? r.d_state },
  ];
}

/** A language file's columns: Kód, Pôvodný názov, Názov, Popis, Kategória, Stav. */
export function langColumns(labels: ExportFileLabels): Column[] {
  const state = (s: TrState | null) => (s ? (labels[`tr_${s}`] ?? s) : "");
  return [
    { key: "code", header: labels.col_code, width: 14, value: (r) => r.code },
    { key: "orig_name", header: labels.col_original, width: 40, value: (r) => r.name },
    { key: "tr_name", header: labels.col_name, width: 40, value: (r) => (r.st_name === "original" ? r.name : (r.tr_name ?? "")) },
    { key: "tr_desc", header: labels.col_desc, width: 60, value: (r) => r.tr_desc ?? "" },
    { key: "tr_cat", header: labels.col_cat, width: 20, value: (r) => r.tr_cat ?? "" },
    {
      key: "state",
      header: labels.col_state,
      width: 44,
      value: (r) =>
        [
          `${labels.state_name}: ${state(r.st_name)}`,
          r.st_desc && r.st_desc !== "no_source" ? `${labels.state_desc}: ${state(r.st_desc)}` : null,
          r.st_cat && r.st_cat !== "no_source" ? `${labels.state_cat}: ${state(r.st_cat)}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
    },
  ];
}

/** The workbook of one file: the data, "Návod" and the hidden sheet with what was written. */
export function buildSheets(input: {
  shopId: string;
  lang: string | null;
  mainLang: string;
  columns: Column[];
  rows: ExportRow[];
  labels: ExportFileLabels;
  writtenAt: string;
}): SheetIn[] {
  const { columns, rows, labels } = input;
  const values = rows.map((r) => columns.map((c) => c.value(r)));
  const keys = input.lang ? (["help_lang_1", "help_lang_2", "help_lang_3"] as const) : (["help_main_1", "help_main_2", "help_main_3"] as const);
  const help = [...keys, "help_all_1", "help_all_2", "help_all_3"].map((k) => [labels[k as `help_${string}`] ?? ""]);
  return [
    { name: labels.sheet_data, rows: [columns.map((c) => c.header), ...values], header: true, widths: columns.map((c) => c.width) },
    { name: labels.sheet_help, rows: help, widths: [120] },
    {
      name: HIDDEN_SHEET,
      hidden: true,
      rows: [
        [FORMAT, VERSION, input.shopId, input.lang ?? "", input.mainLang, input.writtenAt, labels.sheet_data],
        columns.map((c) => c.key),
        columns.map((c) => c.header),
        // the EAN of each row too (matching when the owner removed a code)
        ...rows.map((r, i) => [...values[i], `ean:${r.ean ?? ""}`]),
      ],
    },
  ];
}

export async function buildWorkbook(input: Parameters<typeof buildSheets>[0]): Promise<Uint8Array> {
  return writeXlsx(buildSheets(input));
}

/** The owner's edits of a file, against what Cacaduu wrote (its hidden sheet). */
export function editsOf(sheets: SheetOut[]): FileEdits {
  const hidden = sheets.find((s) => s.name === HIDDEN_SHEET);
  const meta = hidden?.rows[0] ?? [];
  if (!hidden || meta[0] !== FORMAT) throw new Error("not_ours");
  const shopId = meta[2] ?? "";
  const lang = meta[3] ? meta[3] : null;
  const keys = hidden.rows[1] ?? [];
  const headers = (hidden.rows[2] ?? []).map(norm);
  const data = sheets.find((s) => !s.hidden && s.name === meta[6]) ?? sheets.find((s) => !s.hidden && s.name !== HIDDEN_SHEET);
  if (!data) throw new Error("not_ours");
  const editable = lang ? EDITABLE_LANG : EDITABLE_MAIN;
  const codeKey = lang ? "code" : "f:source_code";
  const codeAt = keys.indexOf(codeKey);
  const eanAt = keys.indexOf("f:ean");

  // what was written, by code and by EAN
  const written = hidden.rows.slice(3).map((r) => {
    const ean = (r[keys.length] ?? "").replace(/^ean:/, "") || null;
    return { values: r.slice(0, keys.length).map(norm), code: norm(r[codeAt]), ean };
  });
  const byCode = new Map(written.map((w) => [w.code, w]));
  const eanCount = new Map<string, number>();
  for (const w of written) if (w.ean) eanCount.set(w.ean, (eanCount.get(w.ean) ?? 0) + 1);
  const byEan = new Map(written.filter((w) => w.ean && eanCount.get(w.ean) === 1).map((w) => [w.ean!, w]));

  // the file's columns: by their header (the owner may move them), else where they were written
  const head = (data.rows[0] ?? []).map(norm);
  const at = new Map<string, number>();
  keys.forEach((key, i) => {
    const found = head.indexOf(headers[i]);
    if (found >= 0) at.set(key, found);
    else if (head.length === keys.length) at.set(key, i);
  });
  if (!at.has(codeKey)) throw new Error("no_code_column");

  const edits: Edit[] = [];
  const readonly: FileEdits["readonly"] = [];
  const unknown: string[] = [];
  data.rows.slice(1).forEach((row, i) => {
    const cell = (key: string) => {
      const c = at.get(key);
      return c === undefined ? "" : norm(row[c]);
    };
    if (!row.some((v) => norm(v))) return; // an empty row
    const code = cell(codeKey);
    const ean = eanAt >= 0 ? cell("f:ean").replace(/\s/g, "") : "";
    const original = (code && byCode.get(code)) || (ean && byEan.get(ean)) || null;
    if (!original) {
      unknown.push(code || ean || `#${i + 2}`);
      return;
    }
    keys.forEach((key, k) => {
      if (!at.has(key) || key === codeKey) return;
      const value = cell(key);
      if (value === "" || value === original.values[k]) return; // an empty cell never changes anything
      const field = editable[key];
      if (field) edits.push({ code: original.code, ean: original.ean, field, text: value, before: original.values[k] });
      else readonly.push({ code: original.code, column: headers[k] || key });
    });
  });
  return { shopId, lang, edits, readonly, unknown };
}

export async function readEdits(bytes: Uint8Array): Promise<FileEdits> {
  return editsOf(await readXlsx(bytes));
}

/** SHA-256 of the file's bytes (whether the owner changed it since it was written). */
export async function fileHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
