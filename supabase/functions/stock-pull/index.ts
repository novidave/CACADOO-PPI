/// <reference lib="deno.ns" />
// PPI · stock-pull Edge Function
//
// Receives a shop's stock file. The only way in is an upload with the shop owner's own
// login (?shop_id=…&file_time=…&file_name=…[&gzip=1], body = the file): the PPI window
// on the shop PC (/sync page in Edge or Chrome) sends the newest file from the folder the
// stock software exports to, or the owner picks one with "Upload file". PPI downloads
// nothing itself (no schedule, no cloud links). Then:
//   1. read XML, CSV or Excel into rows
//   2. no approved field mapping yet → propose one (Claude, or a rule-based guess),
//      save it as "proposed" with 3 sample rows and stop: the shop owner approves it.
//      Claude sees only the column names and up to 3 values per column, and only the
//      names of columns that look private (purchase price, supplier, margin, invoice)
//   3. approved mapping → check the rows; if more than 5 % cannot be read, keep the
//      old stock and propose a new mapping; otherwise apply the whole file in one
//      transaction (apply_stock_file). The file's time becomes the freshness.
//   4. keep the raw file 7 days in the private "raw-files" bucket — the only place the
//      file's private columns (any column not in the approved mapping) are ever kept
//   5. record a report of the file for the owner (stock_imports: counts, status and the
//      first 5 rows of the mapped columns only; the last 10 files are kept)
//   6. after the reply, in the background: names without a translation (or renamed) get
//      their Slovak, Hungarian and English names from Claude Haiku; never touches stock,
//      and whatever fails is tried again with the next file
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor →
// name "stock-pull" → paste this file → Deploy, then switch OFF "Verify JWT"
// (this function checks its callers itself). Secret: ANTHROPIC_API_KEY (optional:
// AI mapping proposals and the item-name translations).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { XMLParser } from "npm:fast-xml-parser@5.11.2";
// SheetJS 0.20.3 (official release, republished on npm by e965).
import * as XLSX from "npm:@e965/xlsx@0.20.3";
import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";

// ---------------------------------------------------------------- types

export type Row = Record<string, string>;
export const MAPPING_FIELDS = ["source_code", "name", "ean", "brand", "quantity", "price", "currency"] as const;
export type MappingField = (typeof MAPPING_FIELDS)[number];
/** Which file column holds each field (null = not in the file). */
export type Mapping = Record<MappingField, string | null>;

export interface StockRow {
  source_code: string;
  name: string;
  ean: string | null;
  brand: string | null;
  quantity: number;
  price: number;
  currency: string;
}

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_BAD_SHARE = 0.05;
const RAW_FILE_DAYS = 7;
const TRANSLATE_MODEL = "claude-haiku-5-5";
const TRANSLATE_BATCH = 200;
const TRANSLATE_PARALLEL = 3;
/** Per received file; the rest is translated with the next files. */
const TRANSLATE_MAX_ITEMS = 1200;

// ---------------------------------------------------------------- reading files

/** UTF-8 if valid, otherwise Windows-1250 (common in Slovak/Hungarian/Czech shop software). */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1250").decode(bytes);
  }
}

function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim() || `column_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}

/** CSV with ; , tab or | as separator (guessed from the header line) and "quoted" fields. */
export function parseCsv(text: string): Row[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [";", ",", "\t", "|"]
    .map((d) => ({ d, n: firstLine.split(d).length }))
    .sort((a, b) => b.n - a.n)[0].d;

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
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

  const nonEmpty = records.filter((r) => r.some((v) => v.trim() !== ""));
  if (nonEmpty.length < 2) return [];
  const headers = uniqueHeaders(nonEmpty[0]);
  return nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
}

/** Leaf values of one record, nested names joined with "/" and attributes prefixed with "@". */
function flatten(value: unknown, prefix = "", out: Row = {}): Row {
  if (value === null || value === undefined) return out;
  if (typeof value !== "object") {
    out[prefix || "value"] = String(value).trim();
    return out;
  }
  if (Array.isArray(value)) {
    value.slice(0, 1).forEach((v) => flatten(v, prefix, out));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    flatten(v, k === "#text" ? prefix : prefix ? `${prefix}/${k}` : k, out);
  }
  return out;
}

/** The largest list of repeated elements in the XML is taken as the item list. */
export function parseXml(text: string): Row[] {
  const tree = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  }).parse(text);

  let best: unknown[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      const objects = node.filter((n) => n && typeof n === "object");
      if (objects.length > best.length) best = objects;
      node.forEach(visit);
    } else if (node && typeof node === "object") {
      Object.values(node).forEach(visit);
    }
  };
  visit(tree);
  // A file with exactly one item has no array: fall back to the deepest single record.
  if (best.length === 0) {
    const findRecord = (node: unknown): unknown => {
      if (!node || typeof node !== "object") return null;
      const values = Object.values(node as Record<string, unknown>);
      if (values.every((v) => v === null || typeof v !== "object")) return node;
      for (const v of values) {
        const found = findRecord(v);
        if (found) return found;
      }
      return null;
    };
    const one = findRecord(tree);
    if (one) best = [one];
  }
  return best.map((item) => flatten(item));
}

/** First sheet of an Excel file; the first row holds the column names. */
export function parseXlsx(bytes: Uint8Array): Row[] {
  const book = XLSX.read(bytes, { type: "array", cellDates: false });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "" });
  const nonEmpty = rows.filter((r) => r.some((v) => String(v ?? "").trim() !== ""));
  if (nonEmpty.length < 2) return [];
  const headers = uniqueHeaders(nonEmpty[0].map((h) => String(h ?? "")));
  return nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? "").trim()])));
}

export type FileFormat = "xml" | "csv" | "xlsx";

/** Trust the file's content over the configured format (shops change exports). */
export function detectFormat(bytes: Uint8Array, configured: string | null): FileFormat {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "xlsx"; // ZIP container = .xlsx
  const head = decodeText(bytes.slice(0, 512)).trimStart();
  if (head.startsWith("<")) return "xml";
  if (configured === "xlsx" || configured === "xml") return "csv";
  return "csv";
}

export function parseFile(bytes: Uint8Array, format: FileFormat): Row[] {
  if (format === "xlsx") return parseXlsx(bytes);
  const text = decodeText(bytes);
  return format === "xml" ? parseXml(text) : parseCsv(text);
}

// ---------------------------------------------------------------- numbers and mapping

/** "12,90" · "1 234,50 €" · "1.234,5" · "1,234.50" · "12.9" → number; anything else → null. */
export function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = String(value ?? "").replace(/[\s  ']/g, "").replace(/[^\d.,+-]/g, "");
  if (!s || !/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // The later separator is the decimal one.
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    s = s.replace(/,(?=.*,)/g, "").replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const HINTS: Record<MappingField, string[]> = {
  source_code: ["kod", "kodtovaru", "plu", "code", "sku", "artikel", "artnr", "cislo", "cikkszam", "id", "katalog"],
  name: ["nazov", "nazev", "name", "nev", "megnevezes", "popis", "description", "bezeichnung", "tovar", "text"],
  ean: ["ean", "barcode", "gtin", "carovykod", "vonalkod", "ean13"],
  brand: ["znacka", "brand", "vyrobca", "vyrobce", "marka", "gyarto", "hersteller"],
  quantity: ["mnozstvo", "mnozstvi", "stav", "zasoba", "qty", "quantity", "pocet", "stock", "keszlet", "mennyiseg", "bestand", "ks"],
  price: ["cenasdph", "predajnacena", "cena", "price", "eladasiar", "ar", "preis", "mocena", "pc"],
  currency: ["mena", "currency", "penznem", "wahrung", "waehrung"],
};

/** Rule-based proposal from column names (used when Claude is not configured or unavailable). */
export function guessMapping(columns: string[]): Mapping {
  const used = new Set<string>();
  const mapping = Object.fromEntries(MAPPING_FIELDS.map((f) => [f, null])) as Mapping;
  for (const field of MAPPING_FIELDS) {
    let best: { col: string; score: number } | null = null;
    for (const col of columns) {
      if (used.has(col)) continue;
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

/** Turns file rows into stock rows; counts rows that cannot be read. */
export function applyMapping(rows: Row[], mapping: Mapping, defaultCurrency: string) {
  const good: StockRow[] = [];
  let bad = 0;
  for (const row of rows) {
    const code = mapping.source_code ? row[mapping.source_code]?.trim() : "";
    const name = mapping.name ? row[mapping.name]?.trim() : "";
    const quantity = mapping.quantity ? parseNumber(row[mapping.quantity]) : null;
    const price = mapping.price ? parseNumber(row[mapping.price]) : null;
    if (!code || !name || quantity === null || price === null || price < 0) {
      bad++;
      continue;
    }
    const currency = (mapping.currency ? row[mapping.currency]?.trim().toUpperCase() : "") || defaultCurrency;
    good.push({
      source_code: code,
      name,
      ean: mapping.ean ? row[mapping.ean]?.replace(/\s/g, "") || null : null,
      brand: mapping.brand ? row[mapping.brand]?.trim() || null : null,
      quantity,
      price,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : defaultCurrency,
    });
  }
  return { good, bad };
}

/** Currency to assume when the file has no currency column. */
export function currencyForCountry(country: string | null | undefined): string {
  const map: Record<string, string> = {
    HU: "HUF", CZ: "CZK", PL: "PLN", RO: "RON", CH: "CHF", LI: "CHF", GB: "GBP", SE: "SEK", DK: "DKK",
    NO: "NOK", IS: "ISK", RS: "RSD", BA: "BAM", MK: "MKD", AL: "ALL", MD: "MDL", UA: "UAH", TR: "TRY",
  };
  return map[(country ?? "").toUpperCase()] ?? "EUR";
}

export function isValidMapping(mapping: Mapping, columns: string[]): boolean {
  return MAPPING_FIELDS.every((f) => mapping[f] === null || columns.includes(mapping[f] as string));
}

// ---------------------------------------------------------------- private columns

/**
 * A column whose name points to purchase prices, suppliers, margins or invoices (the same
 * list as is_private_column() in the database). Its values never leave the raw file.
 */
export function isPrivateColumn(name: string): boolean {
  const n = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /(nakup|purchase|cost|beszerz|dodavatel|supplier|vendor|lieferant|szallit|marz|margin|arres|haszon|zisk|profit|faktur|invoice|rechnung|szamla)/
    .test(n) || /(^|[^\p{L}\p{N}_])nc($|[^\p{L}\p{N}_])/u.test(n);
}

/** The file columns a mapping uses, in field order. */
export function mappedColumns(mapping: Mapping | null | undefined): string[] {
  if (!mapping) return [];
  return [...new Set(MAPPING_FIELDS.map((f) => mapping[f]).filter((c): c is string => Boolean(c)))];
}

/** The first rows with only the given columns, values exactly as in the file. */
export function onlyColumns(rows: Row[], columns: string[], limit: number): Row[] {
  return rows.slice(0, limit).map((row) => Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]])));
}

/** Sample rows for the owner before the columns are approved: 3 rows, no private-looking column. */
export function approvalSample(rows: Row[], columns: string[]): Row[] {
  return onlyColumns(rows, columns.filter((c) => !isPrivateColumn(c)), 3);
}

export interface ColumnSample {
  column: string;
  samples: string[];
}

/** What the AI may see to propose the mapping: every column name, up to 3 values, none for private columns. */
export function columnSamples(columns: string[], rows: Row[], max = 3): ColumnSample[] {
  return columns.map((column) => {
    const samples: string[] = [];
    if (!isPrivateColumn(column)) {
      for (const row of rows.slice(0, 200)) {
        const value = String(row[column] ?? "").trim().slice(0, 100);
        if (value && !samples.includes(value)) samples.push(value);
        if (samples.length >= max) break;
      }
    }
    return { column, samples };
  });
}

// ---------------------------------------------------------------- Claude proposal

/**
 * Asks Claude which column is which. Structured outputs pin the answer to a JSON
 * object whose values can only be real column names (or null), so it is always
 * usable. Returns null when no API key is set or the call fails — the caller then
 * falls back to guessMapping(). Never auto-approved: the shop owner confirms it.
 */
export async function proposeWithClaude(samples: ColumnSample[]): Promise<Mapping | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const columns = samples.map((s) => s.column);
  if (!apiKey || columns.length === 0) return null;
  const column = { anyOf: [{ type: "string", enum: columns }, { type: "null" }] };
  const schema = {
    type: "object",
    properties: Object.fromEntries(MAPPING_FIELDS.map((f) => [f, column])),
    required: [...MAPPING_FIELDS],
    additionalProperties: false,
  };
  try {
    const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 8000,
      // If a safety classifier declines, Anthropic re-runs the request on its recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      system:
        "You map columns of a shop's stock export to PPI fields. Fields: source_code = the shop's own item code " +
        "(unique per item), name = product name, ean = EAN/GTIN barcode, brand = brand or manufacturer, " +
        "quantity = units in stock now, price = selling price per unit for customers (incl. VAT when both exist), " +
        "currency = currency code column. Column names may be Slovak, Hungarian, Czech, German or English. " +
        "You get each column's name and up to 3 of its values (no values for columns that may be private). " +
        "Use null when a field is not in the file or you are not sure.",
      messages: [{ role: "user", content: JSON.stringify({ columns: samples }) }],
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return null;
    const mapping = JSON.parse(text.text) as Mapping;
    return isValidMapping(mapping, columns) ? mapping : null;
  } catch (e) {
    console.error("Claude mapping proposal failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

// ---------------------------------------------------------------- item names in three languages

/** A name the database asks to translate (items_to_translate). */
export interface NameToTranslate {
  item_id: string;
  name: string;
}

/** What apply_item_translations() saves: source is the name that was translated. */
export interface NameTranslation {
  item_id: string;
  source: string;
  lang: string | null;
  sk: string;
  hu: string;
  en: string;
}

export type Translator = (batch: NameToTranslate[]) => Promise<NameTranslation[]>;

export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const TRANSLATION_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          lang: { type: "string" },
          sk: { type: "string" },
          hu: { type: "string" },
          en: { type: "string" },
        },
        required: ["i", "lang", "sk", "hu", "en"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const TRANSLATION_PROMPT =
  "You turn product names from a shop's stock list into plain product names in Slovak, Hungarian and English, " +
  "for a product search that works in all three languages.\n" +
  'You get a JSON list of {"i": number, "name": text}. For every name return {"i", "lang", "sk", "hu", "en"}:\n' +
  "- lang: the language the name is written in, as an ISO 639-1 code (sk, hu, cs, de, pl, en, ...).\n" +
  "- sk, hu, en: the name in plain Slovak, Hungarian and English, the way a shopper would search for it.\n" +
  "Rules:\n" +
  "- Expand the shop's abbreviations into full words, e.g. \"Farba fas. biela 5L\" becomes " +
  "sk \"Fasádna farba biela 5 l\", hu \"Homlokzatfesték fehér 5 l\", en \"White facade paint 5 l\".\n" +
  "- Keep brand names, sizes and quantities, model numbers and part numbers unchanged; only write units the usual " +
  "way, with a space (\"5L\" becomes \"5 l\", \"250G\" becomes \"250 g\").\n" +
  "- Translate only what the name says; add nothing.\n" +
  "- A name that is only a code, a brand or a model stays the same in all three languages.\n" +
  "Return every i exactly once.";

/** Claude's answer for one batch: one complete translation per name; anything else is dropped. */
export function readTranslations(text: string, batch: NameToTranslate[]): NameTranslation[] {
  const parsed = JSON.parse(text) as { items?: Record<string, unknown>[] };
  const seen = new Set<number>();
  const out: NameTranslation[] = [];
  for (const row of parsed.items ?? []) {
    const i = Number(row.i);
    if (!Number.isInteger(i) || i < 0 || i >= batch.length || seen.has(i)) continue;
    const [sk, hu, en] = [row.sk, row.hu, row.en].map((v) => (typeof v === "string" ? v.trim().slice(0, 300) : ""));
    if (!sk || !hu || !en) continue;
    seen.add(i);
    const lang = typeof row.lang === "string" ? row.lang.trim().toLowerCase() : "";
    out.push({ item_id: batch[i].item_id, source: batch[i].name, lang: /^[a-z]{2}$/.test(lang) ? lang : null, sk, hu, en });
  }
  return out;
}

/** One batch through Claude Haiku. Structured output keeps the answer valid JSON. */
export const translateWithClaude: Translator = async (batch) => {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey || batch.length === 0) return [];
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  const message = await client.messages
    .stream({
      model: TRANSLATE_MODEL,
      max_tokens: 32000,
      output_config: { effort: "low", format: { type: "json_schema", schema: TRANSLATION_SCHEMA } },
      system: TRANSLATION_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(batch.map((item, i) => ({ i, name: item.name }))) }],
    })
    .finalMessage();
  if (message.stop_reason !== "end_turn") throw new Error(`translation stopped: ${message.stop_reason}`);
  const text = message.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") throw new Error("translation returned no text");
  return readTranslations(text.text, batch);
};

/**
 * After a file was applied: translate the shop's names that have no translation yet or
 * were renamed (never the owner's corrections) and save them. Runs after the reply, never
 * throws and never touches stock; whatever fails is tried again with the next file.
 */
export async function translateShopItems(
  db: SupabaseClient,
  shopId: string,
  translate: Translator = translateWithClaude,
): Promise<{ saved: number; failed: number }> {
  let saved = 0;
  let failed = 0;
  let firstError: string | null = null;
  const fail = (e: unknown) => {
    failed++;
    const message = e instanceof Error ? e.message : String(e);
    firstError ??= message;
    console.error("translation failed:", message);
  };
  try {
    if (translate === translateWithClaude && !Deno.env.get("ANTHROPIC_API_KEY")) return { saved, failed };
    const { data, error } = await db.rpc("items_to_translate", { p_shop_id: shopId, p_limit: TRANSLATE_MAX_ITEMS });
    if (error) throw new Error(error.message);
    const groups = batches((data ?? []) as NameToTranslate[], TRANSLATE_BATCH);
    for (let i = 0; i < groups.length; i += TRANSLATE_PARALLEL) {
      const results = await Promise.allSettled(groups.slice(i, i + TRANSLATE_PARALLEL).map((group) => translate(group)));
      for (const result of results) {
        if (result.status === "rejected") {
          fail(result.reason);
          continue;
        }
        if (result.value.length === 0) continue;
        const { data: count, error: saveError } = await db.rpc("apply_item_translations", {
          p_shop_id: shopId,
          p_items: result.value,
        });
        if (saveError) throw new Error(saveError.message);
        saved += Number(count ?? 0);
      }
    }
  } catch (e) {
    fail(e);
  }
  // The owner sees it as the last error in My shop; the next applied file clears it.
  if (firstError) {
    await Promise.resolve(
      db.from("sync_sources")
        .update({ last_error: `Item names could not be translated (the stock is fine): ${firstError}`.slice(0, 500) })
        .eq("shop_id", shopId),
    ).catch(() => {});
  }
  return { saved, failed };
}

/** Keeps work running after the reply (Supabase Edge Runtime); elsewhere it just runs on. */
function inBackground(task: Promise<unknown>): void {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime) runtime.waitUntil(task);
  else task.catch(() => {});
}

// ---------------------------------------------------------------- one shop

interface Source {
  shop_id: string;
  file_format: string | null;
  field_mapping: Mapping | null;
  mapping_status: "proposed" | "confirmed";
  latest_file_time: string | null;
  shops: { slug: string; name: string; country: string | null } | null;
}

export type Outcome =
  | { status: "unchanged" }
  | { status: "proposed" | "waiting_for_approval"; rows: number }
  | { status: "layout_changed"; rows: number; skipped: number }
  | { status: "updated"; items: number; zeroed: number; skipped: number; rows?: number; preview?: Row[] }
  | { status: "error"; error: string };

export interface ImportReport {
  status: "ok" | "errors" | "waiting";
  total: number;
  imported: number;
  zeroed: number;
  skipped: number;
  error: string | null;
}

/** The owner's report of one received file (stock_imports); none for a file already applied. */
export function importReport(result: Outcome): ImportReport | null {
  switch (result.status) {
    case "unchanged":
      return null;
    case "updated":
      return {
        status: result.skipped > 0 ? "errors" : "ok",
        total: result.rows ?? result.items + result.skipped,
        imported: result.items,
        zeroed: result.zeroed,
        skipped: result.skipped,
        error: null,
      };
    case "proposed":
    case "waiting_for_approval":
      return { status: "waiting", total: result.rows, imported: 0, zeroed: 0, skipped: 0, error: null };
    case "layout_changed":
      return {
        status: "errors",
        total: result.rows,
        imported: 0,
        zeroed: 0,
        skipped: result.skipped,
        error: `${result.skipped} of ${result.rows} rows could not be read — the file layout may have changed.`,
      };
    case "error":
      return { status: "errors", total: 0, imported: 0, zeroed: 0, skipped: 0, error: result.error.slice(0, 500) };
  }
}

/** What the uploader gets back: the outcome without the preview rows. */
function publicResult(result: Outcome): Record<string, unknown> {
  const { preview: _preview, ...rest } = result as Outcome & { preview?: unknown };
  if (rest.status === "updated") delete (rest as { rows?: number }).rows;
  return rest;
}

async function keepRawFile(db: SupabaseClient, shopId: string, bytes: Uint8Array, format: FileFormat) {
  const bucket = db.storage.from("raw-files");
  const { error } = await bucket.upload(`${shopId}/${Date.now()}.${format}`, bytes, {
    contentType: format === "xml" ? "application/xml" : format === "csv" ? "text/csv" : "application/octet-stream",
  });
  if (error) {
    console.warn("raw file not stored:", error.message);
    return;
  }
  const { data: files } = await bucket.list(shopId, { limit: 1000 });
  const cutoff = Date.now() - RAW_FILE_DAYS * 24 * 3600 * 1000;
  const old = (files ?? []).filter((f) => Number(f.name.split(".")[0]) < cutoff).map((f) => `${shopId}/${f.name}`);
  if (old.length) await bucket.remove(old);
}

type Update = (values: Record<string, unknown>) => PromiseLike<unknown>;

function sourceUpdater(db: SupabaseClient, shopId: string): Update {
  return (values) =>
    db.from("sync_sources").update({ last_checked_at: new Date().toISOString(), ...values }).eq("shop_id", shopId);
}

async function failed(update: Update, e: unknown): Promise<Outcome> {
  const message = e instanceof Error ? e.message : String(e);
  await update({ last_error: message.slice(0, 500) });
  return { status: "error", error: message };
}

const isApproved = (src: Source) => src.mapping_status === "confirmed" && Boolean(src.field_mapping);

/** A file already applied (or older) is skipped. */
const alreadyApplied = (src: Source, fileTime: Date) =>
  isApproved(src) && Boolean(src.latest_file_time) && fileTime <= new Date(src.latest_file_time as string);

/** Reads the file, proposes or applies the field mapping, saves the stock. */
async function processFile(db: SupabaseClient, src: Source, bytes: Uint8Array, fileTime: Date, update: Update): Promise<Outcome> {
  if (bytes.length === 0) throw new Error("The stock file is empty.");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("The stock file is larger than 50 MB.");
  const format = detectFormat(bytes, src.file_format);
  const rows = parseFile(bytes, format);
  if (rows.length === 0) throw new Error(`No items could be read from the file (read as ${format.toUpperCase()}).`);
  await keepRawFile(db, src.shop_id, bytes, format);

  // Column names are kept (to choose them again); values only of the approved columns
  // (until the owner approves them, every column counts as private: no preview).
  const columns = Object.keys(rows[0]);
  const propose = async () => (await proposeWithClaude(columnSamples(columns, rows))) ?? guessMapping(columns);
  const preview = (mapping: Mapping | null | undefined) => onlyColumns(rows, mappedColumns(mapping), 5);

  if (!isApproved(src)) {
    if (src.field_mapping && isValidMapping(src.field_mapping, columns)) {
      await update({
        sample_rows: approvalSample(rows, columns),
        file_columns: columns,
        last_error: "Waiting for you to approve the file's columns in My shop.",
      });
      return { status: "waiting_for_approval", rows: rows.length };
    }
    const proposal = await propose();
    await update({
      field_mapping: proposal,
      mapping_status: "proposed",
      sample_rows: approvalSample(rows, columns),
      file_columns: columns,
      last_error: "New file layout: check and approve the file's columns in My shop.",
    });
    return { status: "proposed", rows: rows.length };
  }

  const { good, bad } = applyMapping(rows, src.field_mapping as Mapping, currencyForCountry(src.shops?.country));
  if (good.length === 0 || bad / rows.length > MAX_BAD_SHARE) {
    const proposal = await propose();
    await update({
      field_mapping: proposal,
      mapping_status: "proposed",
      sample_rows: approvalSample(rows, columns),
      file_columns: columns,
      last_error:
        `${bad} of ${rows.length} rows could not be read — the file layout may have changed. ` +
        "The previous stock is kept until you approve the new columns in My shop.",
    });
    return { status: "layout_changed", rows: rows.length, skipped: bad };
  }

  const { data, error } = await db.rpc("apply_stock_file", {
    p_shop_id: src.shop_id,
    p_rows: good,
    p_file_time: fileTime.toISOString(),
    p_sample: preview(src.field_mapping),
  });
  if (error) throw new Error(`Saving the stock failed: ${error.message}`);
  await update({ file_columns: columns });
  return {
    status: "updated",
    items: data.items,
    zeroed: data.zeroed,
    skipped: bad,
    rows: rows.length,
    preview: preview(src.field_mapping),
  };
}

/** The owner's report of this file; a failure here never fails the upload. */
async function recordImport(db: SupabaseClient, shopId: string, fileName: string | null, fileTime: Date, result: Outcome) {
  const report = importReport(result);
  if (!report) return;
  const preview = "preview" in result && result.preview ? result.preview : [];
  const { error } = await db.rpc("record_stock_import", {
    p_shop_id: shopId,
    p_file_name: fileName,
    p_file_time: fileTime.toISOString(),
    p_status: report.status,
    p_total: report.total,
    p_imported: report.imported,
    p_zeroed: report.zeroed,
    p_skipped: report.skipped,
    p_error: report.error,
    p_rows: preview,
  });
  if (error) console.warn("import report not saved:", error.message);
}

/** Reads a (possibly gzip-compressed) request body, refusing anything over 50 MB. */
async function readBody(req: Request, gzip: boolean): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array();
  const stream = gzip ? req.body.pipeThrough(new DecompressionStream("gzip")) : req.body;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_FILE_BYTES) {
      await reader.cancel();
      throw new Error("The stock file is larger than 50 MB.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Upload: the PPI window on the shop PC (/sync page) sends the newest file from the
 * shop's export folder, or the owner picks one with "Upload file". POST body = the
 * file (gzip=1: gzip-compressed), query shop_id, file_time (the file's own time, ISO),
 * file_name. Only the shop's owners and the admin, with their own login.
 */
export async function receiveUpload(
  req: Request,
  params: URLSearchParams,
  asCaller: SupabaseClient,
  db: SupabaseClient,
  options: { translate?: Translator; background?: (task: Promise<unknown>) => void } = {},
) {
  const shopId = params.get("shop_id") ?? "";
  if (!UUID.test(shopId)) return reply(400, { error: "shop_id is missing" });

  // Checks membership with the uploader's own login and records "PPI window seen".
  const { error: denied } = await asCaller.rpc("upload_check_in", { p_shop_id: shopId });
  if (denied) return reply(403, { error: "Only this shop's owners or the admin may upload its stock" });

  const { data: src, error } = await db
    .from("sync_sources")
    .select("shop_id, file_format, field_mapping, mapping_status, latest_file_time, shops(slug, name, country)")
    .eq("shop_id", shopId)
    .single();
  if (error || !src) return reply(500, { error: error?.message ?? "Stock source missing" });
  const source = src as unknown as Source;

  const update = sourceUpdater(db, shopId);
  const fileName = (params.get("file_name") ?? "").replace(/[\u0000-\u001f]/g, "").slice(0, 200) || null;
  const declaredTime = Date.parse(params.get("file_time") ?? "");
  const fileTime = new Date(Number.isFinite(declaredTime) ? Math.min(declaredTime, Date.now()) : Date.now());

  let result: Outcome;
  try {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_FILE_BYTES) throw new Error("The stock file is larger than 50 MB.");
    await db.from("sync_sources").update({ last_file_name: fileName }).eq("shop_id", shopId);
    if (alreadyApplied(source, fileTime)) {
      await req.body?.cancel();
      await update({});
      result = { status: "unchanged" };
    } else {
      result = await processFile(db, source, await readBody(req, params.get("gzip") === "1"), fileTime, update);
    }
  } catch (e) {
    result = await failed(update, e);
  }
  await recordImport(db, shopId, fileName, fileTime, result);
  // The new stock is saved; names are translated after the reply, so this never delays it.
  if (result.status === "updated") (options.background ?? inBackground)(translateShopItems(db, shopId, options.translate));
  return reply(200, { result: publicResult(result) });
}

// ---------------------------------------------------------------- HTTP entry

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return reply(200, {});
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !serviceKey || !anonKey) return reply(500, { error: "Function is missing Supabase settings" });

  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // The only way in: an upload from the PPI window on the shop PC or "Upload file".
  return await receiveUpload(req, new URL(req.url).searchParams, asCaller, db);
}

if (!Deno.env.get("PPI_STOCK_PULL_TEST")) Deno.serve(handler);
