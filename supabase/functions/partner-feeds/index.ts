/// <reference lib="deno.ns" />
// PPI · partner-feeds Edge Function (database update 35, Prompt 11 phase B)
//
// Reads partner shops' product feeds into partner_products and partner_store_stock: their own tables, never mixed
// with the shops' stock (shop_items, inventory). Formats: Google Merchant XML (RSS or Atom) and CSV/TSV, Google's
// local inventory feed (XML or CSV/TSV: stock per store), Heureka XML, a plain CSV (columns by name). The rows are
// kept as the partner sent them: nothing is corrected, translated or completed. Stock per store comes only from a
// local inventory feed — never from the store list, never guessed.
//
// How a big feed fits into an Edge Function (2 seconds of CPU per call):
//   1. download — the feed (its https address, or the file the admin uploaded) is streamed, unpacked on the way
//      when it is gzip, into parts of 4 MB in the private bucket partner-feeds ("imports/<import>/00000.part").
//      Over PARTNER_FEED_MAX_MB (default 50, at most 500) the import stops with "too_big": the parts are removed
//      and nothing changes — a feed is never cut. "Not modified" (304) from the partner's server changes nothing.
//   2. parse — one part per call: its rows, in batches of 1000, through partner_import_rows(); an item cut by the
//      part's end waits in the import (carry) for the next part. Each call starts the next one itself.
//   3. finish — every part read: partner_import_finish() removes the rows the feed no longer has; the parts go.
//
// Who calls it:
//   - pg_cron every 5 minutes (header x-ppi-cron = the Vault secret ppi_assistant_cron): tick
//   - itself, for the next step (the service role key): work
//   - the admin page (the admin's login, is_admin()): run ("Importovať teraz"), admin_status
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "partner-feeds" → paste this file →
// Deploy, then switch OFF "Verify JWT" (it checks its callers itself). Secret: PARTNER_FEED_MAX_MB (optional).
// Feed addresses may carry a partner's token: they are never logged.

import { createClient } from "npm:@supabase/supabase-js@2";

type Fetch = typeof fetch;
type Json = Record<string, unknown>;

export const PART_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_MB = 50;
export const CEILING_MAX_MB = 500;
const BATCH = 1000;
const MAX_CARRY = 1_500_000;
const LEASE_SECONDS = 170;
const DOWNLOAD_MS = 120_000;
const MAX_REDIRECTS = 5;
const BUCKET = "partner-feeds";
const USER_AGENT = "CacadooPPI-PartnerFeeds/1.0";
const MB = 1024 * 1024;

export type Format = "google_xml" | "google_csv" | "heureka_xml" | "csv" | "google_local_xml" | "google_local_csv";

export interface ProductRow {
  id: string;
  title: string;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  category: string | null;
  price: number | null;
  sale_price: number | null;
  sale_from: string | null;
  sale_to: string | null;
  currency: string | null;
  availability: string | null;
  state: string;
  days: number | null;
  link: string | null;
  image: string | null;
}

export interface StockRow {
  id: string;
  store: string;
  availability: string | null;
  state: string;
  quantity: number | null;
}

type Row = ProductRow | StockRow;
/** One record's fields: local names in lower case ("g:price" → "price", "PRICE_VAT" → "price_vat"). */
type Fields = Map<string, string>;

/** A reason the admin can act on (shown on the admin page). */
export class FeedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------- text helpers

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Control characters and line breaks become spaces; nothing else changes. */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.replace(CONTROL, " ").replace(/[\r\n\t]+/g, " ").trim();
  return text || null;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[entity] ?? whole;
  });
}

/** An XML element's text: CDATA as it is, entities decoded, inner tags dropped. */
export function xmlText(raw: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const start = raw.indexOf("<![CDATA[", pos);
    const plain = start === -1 ? raw.slice(pos) : raw.slice(pos, start);
    out += decodeEntities(plain.replace(/<[^>]*>/g, ""));
    if (start === -1) break;
    const end = raw.indexOf("]]>", start + 9);
    if (end === -1) {
      out += raw.slice(start + 9);
      break;
    }
    out += raw.slice(start + 9, end);
    pos = end + 3;
  }
  return out;
}

/** "Image link" / "g:image_link" / "Názov produktu" → "image_link" / "image_link" / "nazov_produktu". */
export function columnKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^\s*g:/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const CURRENCIES = new Set([
  "EUR", "CZK", "HUF", "PLN", "GBP", "CHF", "SEK", "NOK", "DKK", "RON", "BGN", "RSD", "BAM", "MKD", "ALL", "ISK",
  "UAH", "MDL", "TRY", "GEL", "USD", "CAD", "AUD", "JPY",
]);

/** "24.99 EUR", "EUR 24,99", "1 234,56 €", "1.890 Ft" → the number and the currency the text names (else null). */
export function parsePrice(raw: string | null | undefined): { amount: number | null; currency: string | null } {
  if (!raw) return { amount: null, currency: null };
  const text = raw.replace(/\u00a0/g, " ").trim();
  let currency: string | null = null;
  for (const m of text.matchAll(/[A-Z]{3}/g)) {
    if (CURRENCIES.has(m[0])) {
      currency = m[0];
      break;
    }
  }
  if (!currency) {
    if (text.includes("€")) currency = "EUR";
    else if (/kč/i.test(text)) currency = "CZK";
    else if (/(^|[^a-z])ft([^a-z]|$)/i.test(text)) currency = "HUF";
    else if (/zł/i.test(text)) currency = "PLN";
    else if (text.includes("£")) currency = "GBP";
  }
  const found = /-?\d[\d\s.,']*/.exec(text);
  if (!found || found[0].startsWith("-")) return { amount: null, currency };
  let n = found[0].replace(/[\s']/g, "").replace(/[.,]+$/, "");
  const lastDot = n.lastIndexOf(".");
  const lastComma = n.lastIndexOf(",");
  const sep = Math.max(lastDot, lastComma);
  if (sep !== -1) {
    const decimals = n.length - sep - 1;
    const separators = (n.match(/[.,]/g) ?? []).length;
    if (lastDot !== -1 && lastComma !== -1) n = n.slice(0, sep).replace(/[.,]/g, "") + "." + n.slice(sep + 1);
    // "1.890" or "1,234,567": thousands, no decimals
    else if (decimals === 3 || separators > 1) n = n.replace(/[.,]/g, "");
    else n = n.slice(0, sep) + "." + n.slice(sep + 1);
  }
  const amount = Number(n);
  return { amount: Number.isFinite(amount) && amount >= 0 && amount < 1e10 ? Math.round(amount * 10_000) / 10_000 : null, currency };
}

/** A plain number ("12", "12,5", "-1"), else null. */
export function parseNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && Math.abs(n) < 1e11 ? n : null;
}

/** An ISO time, or null. */
function isoTime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function linkOf(raw: string | null, httpsOnly: boolean): string | null {
  const value = raw?.trim();
  if (!value || value.length > 2000 || /[\s<>"]/.test(value)) return null;
  return (httpsOnly ? /^https:\/\/\S+$/i : /^https?:\/\/\S+$/i).test(value) ? value : null;
}

// ---------------------------------------------------------------- availability, as the feed says it

const key = (raw: string) => raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[\s-]+/g, "_");

/** Google's values (in_stock, out_of_stock, preorder, backorder; older "in stock"). */
export function googleState(raw: string | null): string {
  switch (raw ? key(raw) : "") {
    case "in_stock":
      return "in_stock";
    case "out_of_stock":
      return "out_of_stock";
    case "preorder":
      return "preorder";
    case "backorder":
    case "available_for_order":
      return "backorder";
  }
  return "unknown";
}

/** Google's local inventory values per store. */
export function localState(raw: string | null): string | null {
  switch (raw ? key(raw) : "") {
    case "in_stock":
      return "in_stock";
    case "limited_availability":
      return "limited";
    case "out_of_stock":
      return "out_of_stock";
    case "on_display_to_order":
      return "on_display";
    case "preorder":
      return "preorder";
    case "backorder":
      return "backorder";
  }
  return null;
}

const CSV_IN = new Set(["in_stock", "instock", "skladom", "na_sklade", "dostupne", "ano", "yes", "true", "available", "raktaron", "keszleten", "elerheto", "igen", "van"]);
const CSV_OUT = new Set(["out_of_stock", "vypredane", "nie_je_skladom", "nedostupne", "nie", "no", "false", "unavailable", "nincs", "elfogyott", "nem", "nincs_keszleten"]);
const CSV_ORDER = new Set(["na_objednavku", "backorder", "rendelesre", "preorder", "predobjednavka", "elorendeles"]);

/** A plain CSV's availability word (sk, hu, en, Google's) or quantity. */
export function csvState(raw: string | null, quantity: number | null): string {
  if (raw) {
    const k = key(raw);
    if (CSV_IN.has(k)) return "in_stock";
    if (CSV_OUT.has(k)) return "out_of_stock";
    if (CSV_ORDER.has(k)) return k === "preorder" || k === "predobjednavka" || k === "elorendeles" ? "preorder" : "backorder";
    const n = parseNumber(raw);
    if (n !== null) return n > 0 ? "in_stock" : "out_of_stock";
  }
  if (quantity !== null) return quantity > 0 ? "in_stock" : "out_of_stock";
  return "unknown";
}

/** Heureka's DELIVERY_DATE: 0 = in stock, a number = days; a date stays as written (unknown). */
export function heurekaState(raw: string | null): { state: string; days: number | null } {
  const value = raw?.trim() ?? "";
  if (/^\d{1,4}$/.test(value)) {
    const days = Number(value);
    return days === 0 ? { state: "in_stock", days: null } : { state: "in_days", days: Math.min(days, 3650) };
  }
  return { state: "unknown", days: null };
}

// ---------------------------------------------------------------- rows from fields

const PLAIN_CSV: Record<string, string[]> = {
  id: ["id", "code", "kod", "item_id", "sku", "product_id", "cikkszam", "kod_produktu"],
  title: ["title", "name", "nazov", "nazov_produktu", "produkt", "product", "product_name", "nev", "termek", "termeknev", "megnevezes"],
  price: ["price", "cena", "ar", "cena_s_dph", "price_vat", "brutto_ar", "predajna_cena"],
  currency: ["currency", "mena", "penznem", "valuta"],
  availability: ["availability", "dostupnost", "stav", "elerhetoseg", "stock_status"],
  quantity: ["quantity", "qty", "mnozstvo", "pocet", "stock", "sklad", "na_sklade", "keszlet", "mennyiseg"],
  link: ["link", "url", "odkaz", "product_url", "hivatkozas"],
  image: ["image", "image_link", "image_url", "obrazok", "foto", "kep"],
  brand: ["brand", "znacka", "vyrobca", "manufacturer", "marka", "gyarto"],
  gtin: ["ean", "gtin", "ean13", "barcode", "vonalkod", "ean_kod"],
  mpn: ["mpn", "kod_vyrobcu"],
  category: ["category", "kategoria", "kategoria_produktu", "product_type"],
};

/** A plain CSV's header → the canonical field of each column (first column that fits wins). */
export function plainColumns(columns: string[]): (string | null)[] {
  const taken = new Set<string>();
  return columns.map((c) => {
    const k = columnKey(c);
    for (const [field, names] of Object.entries(PLAIN_CSV)) {
      if (!taken.has(field) && names.includes(k)) {
        taken.add(field);
        return field;
      }
    }
    return null;
  });
}

const get = (f: Fields, ...names: string[]) => {
  for (const name of names) {
    const value = cleanText(f.get(name));
    if (value) return value;
  }
  return null;
};

function salePeriod(raw: string | null): { from: string | null; to: string | null } {
  if (!raw) return { from: null, to: null };
  const [from, to] = raw.split("/");
  return { from: isoTime(from), to: isoTime(to) };
}

/** A product row of any product format, or null when it cannot be stored as sent. */
export function productRow(format: Format, f: Fields, partnerCurrency: string | null): ProductRow | null {
  let row: ProductRow;
  if (format === "heureka_xml") {
    const price = parsePrice(get(f, "price_vat", "price"));
    const delivery = get(f, "delivery_date");
    const { state, days } = heurekaState(delivery);
    row = {
      id: get(f, "item_id") ?? "",
      title: get(f, "productname", "product") ?? "",
      brand: get(f, "manufacturer"),
      gtin: get(f, "ean"),
      mpn: get(f, "productno"),
      category: get(f, "categorytext"),
      price: price.amount,
      sale_price: null,
      sale_from: null,
      sale_to: null,
      // Heureka feeds name no currency: the partner's (required for this format).
      currency: partnerCurrency,
      availability: delivery,
      state,
      days,
      link: linkOf(get(f, "url"), false),
      image: linkOf(get(f, "imgurl"), true),
    };
  } else if (format === "csv") {
    const price = parsePrice(get(f, "price"));
    const availability = get(f, "availability");
    const quantity = parseNumber(get(f, "quantity"));
    const currency = get(f, "currency")?.toUpperCase() ?? null;
    row = {
      id: get(f, "id") ?? "",
      title: get(f, "title") ?? "",
      brand: get(f, "brand"),
      gtin: get(f, "gtin"),
      mpn: get(f, "mpn"),
      category: get(f, "category"),
      price: price.amount,
      sale_price: null,
      sale_from: null,
      sale_to: null,
      currency: (currency && /^[A-Z]{3}$/.test(currency) ? currency : null) ?? price.currency ?? partnerCurrency,
      availability,
      state: csvState(availability, quantity),
      days: null,
      link: linkOf(get(f, "link"), false),
      image: linkOf(get(f, "image"), true),
    };
  } else {
    // Google Merchant, XML or CSV/TSV
    const price = parsePrice(get(f, "price"));
    const sale = parsePrice(get(f, "sale_price"));
    const period = salePeriod(get(f, "sale_price_effective_date"));
    const availability = get(f, "availability");
    row = {
      id: get(f, "id") ?? "",
      title: get(f, "title") ?? "",
      brand: get(f, "brand"),
      gtin: get(f, "gtin"),
      mpn: get(f, "mpn"),
      category: get(f, "product_type", "google_product_category"),
      price: price.amount,
      sale_price: sale.amount,
      sale_from: period.from,
      sale_to: period.to,
      currency: price.currency ?? sale.currency ?? partnerCurrency,
      availability,
      state: googleState(availability),
      days: null,
      link: linkOf(get(f, "link"), false),
      image: linkOf(get(f, "image_link"), true),
    };
  }
  // The database's limits: a row over them is counted as unreadable, never cut.
  if (!row.id || row.id.length > 200 || !row.title || row.title.length > 500) return null;
  if ((row.brand?.length ?? 0) > 200 || (row.gtin?.length ?? 0) > 50 || (row.mpn?.length ?? 0) > 100) return null;
  if ((row.availability?.length ?? 0) > 100) return null;
  if ((row.category?.length ?? 0) > 500) row.category = null;
  if (row.currency && !/^[A-Z]{3}$/.test(row.currency)) row.currency = null;
  return row;
}

/** A row of Google's local inventory feed: one item in one store. */
export function stockRow(f: Fields): StockRow | null {
  const id = get(f, "id", "itemid", "item_id");
  const store = get(f, "store_code", "storecode", "store");
  if (!id || id.length > 200 || !store || store.length > 64) return null;
  const availability = get(f, "availability");
  if ((availability?.length ?? 0) > 100) return null;
  const quantity = parseNumber(get(f, "quantity"));
  const state = localState(availability) ?? (quantity !== null ? (quantity > 0 ? "in_stock" : "out_of_stock") : "unknown");
  return { id, store, availability, state, quantity };
}

// ---------------------------------------------------------------- XML

/** The records of a format's item tag in text; the rest waits for the next part (empty at the end of the file). */
export function xmlRecords(text: string, tag: string, final: boolean): { records: string[]; rest: string; cut: number } {
  const records: string[] = [];
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let pos = 0;
  let pending = -1;
  for (;;) {
    let start = text.indexOf(open, pos);
    // "<item>" or "<item attr…>", never "<items>" or "<item_group_id>"
    while (start !== -1 && !/[\s>]/.test(text.charAt(start + open.length))) {
      if (start + open.length >= text.length) break;
      start = text.indexOf(open, start + 1);
    }
    if (start === -1) break;
    if (start + open.length >= text.length) {
      pending = start;
      break;
    }
    const end = text.indexOf(close, start);
    if (end === -1) {
      pending = start;
      break;
    }
    records.push(text.slice(start, end + close.length));
    pos = end + close.length;
  }
  if (final) return { records, rest: "", cut: pending === -1 ? 0 : 1 };
  // An item that goes on in the next part; else the last few characters (a tag cut in the middle).
  const rest = pending !== -1 ? text.slice(pending) : text.slice(Math.max(pos, text.length - open.length - 1));
  return { records, rest, cut: 0 };
}

const OPEN_TAG = /<([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/y;

/** The direct children of one record, by local name in lower case (the first of each name). */
export function xmlFields(record: string): Fields {
  const fields: Fields = new Map();
  const inner = record.slice(record.indexOf(">") + 1, record.lastIndexOf("</"));
  let pos = 0;
  while (pos < inner.length) {
    const lt = inner.indexOf("<", pos);
    if (lt === -1) break;
    if (inner.startsWith("<!--", lt)) {
      const end = inner.indexOf("-->", lt + 4);
      pos = end === -1 ? inner.length : end + 3;
      continue;
    }
    if (inner.startsWith("<![CDATA[", lt)) {
      const end = inner.indexOf("]]>", lt + 9);
      pos = end === -1 ? inner.length : end + 3;
      continue;
    }
    OPEN_TAG.lastIndex = lt;
    const m = OPEN_TAG.exec(inner);
    if (!m) {
      pos = lt + 1;
      continue;
    }
    const name = m[1];
    const local = name.slice(name.indexOf(":") + 1).toLowerCase();
    const after = lt + m[0].length;
    let value = "";
    if (m[3] === "/") {
      pos = after;
    } else {
      const closeTag = `</${name}>`;
      const end = inner.indexOf(closeTag, after);
      if (end === -1) {
        pos = after;
        continue;
      }
      value = xmlText(inner.slice(after, end));
      pos = end + closeTag.length;
    }
    // Atom: <link href="…"/>
    if (!value.trim() && local === "link") value = decodeEntities(/\bhref\s*=\s*["']([^"']*)["']/.exec(m[2])?.[1] ?? "");
    if (!fields.has(local)) fields.set(local, value);
  }
  return fields;
}

/** The item tag of an XML feed: SHOPITEM for Heureka; <entry> (Atom) or <item> (RSS) for Google's. */
export function xmlTag(format: Format, text: string): string | null {
  if (format === "heureka_xml") return /<SHOPITEM[\s>]/.test(text) ? "SHOPITEM" : null;
  const entry = text.search(/<entry[\s>]/);
  const item = text.search(/<item[\s>]/);
  if (entry === -1 && item === -1) return null;
  return entry !== -1 && (item === -1 || entry < item) ? "entry" : "item";
}

// ---------------------------------------------------------------- CSV / TSV

/** The first line of a CSV (to its newline outside quotes), or null when it is not complete yet. */
function firstLine(text: string): { line: string; end: number } | null {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34) quoted = !quoted;
    else if (c === 10 && !quoted) return { line: text.slice(0, i).replace(/\r$/, ""), end: i + 1 };
  }
  return null;
}

/** The delimiter of a header line: the most frequent of tab, semicolon, comma and bar outside quotes. */
export function csvDelimiter(line: string): string {
  const counts: Record<string, number> = { "\t": 0, ";": 0, ",": 0, "|": 0 };
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c in counts) counts[c]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ",";
}

/** Records of a CSV text ("" quotes, quoted line breaks); the rest is a record that goes on in the next part. */
export function csvRecords(text: string, delimiter: string, final: boolean): { records: string[][]; rest: string } {
  const records: string[][] = [];
  const d = delimiter.charCodeAt(0);
  const n = text.length;
  let i = 0;
  let recordStart = 0;
  let fields: string[] = [];
  while (i < n) {
    // one field
    let value: string;
    if (text.charCodeAt(i) === 34) {
      let j = i + 1;
      let parts = "";
      let from = j;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q === -1) {
          j = -1;
          break;
        }
        if (text.charCodeAt(q + 1) === 34) {
          parts += text.slice(from, q + 1);
          j = q + 2;
          from = j;
          continue;
        }
        parts += text.slice(from, q);
        j = q + 1;
        break;
      }
      if (j === -1) break; // the closing quote is in the next part
      // anything up to the delimiter or line end after the closing quote is kept as written
      let k = j;
      while (k < n && text.charCodeAt(k) !== d && text.charCodeAt(k) !== 10) k++;
      value = parts + text.slice(j, k).replace(/\r$/, "");
      i = k;
    } else {
      let k = i;
      while (k < n && text.charCodeAt(k) !== d && text.charCodeAt(k) !== 10) k++;
      value = text.slice(i, k).replace(/\r$/, "");
      i = k;
    }
    if (i >= n) {
      // the text ends inside this record
      if (final) {
        fields.push(value);
        if (fields.some((v) => v !== "")) records.push(fields);
        fields = [];
        recordStart = n;
      }
      break;
    }
    fields.push(value);
    if (text.charCodeAt(i) === d) {
      i++;
      if (i >= n && final) {
        fields.push("");
        records.push(fields);
        fields = [];
        recordStart = n;
      }
      continue;
    }
    // line end
    i++;
    if (fields.length > 1 || fields[0] !== "") records.push(fields);
    fields = [];
    recordStart = i;
  }
  return { records, rest: final ? "" : text.slice(recordStart) };
}

// ---------------------------------------------------------------- one part of a feed

export interface Parsed {
  rows: Row[];
  read: number;
  bad: number;
  rest: string;
  header: Json | null;
  error?: { code: string; detail: string };
}

const isXml = (format: Format) => format === "google_xml" || format === "heureka_xml" || format === "google_local_xml";
const isInventory = (format: Format) => format === "google_local_xml" || format === "google_local_csv";

/**
 * The rows of a part's text (the carry of the part before + this part). final: the file's last part. header: what
 * part 0 found (the item tag, or the CSV's columns and delimiter).
 */
export function parseText(format: Format, text: string, final: boolean, header: Json | null, currency: string | null): Parsed {
  const rows: Row[] = [];
  let read = 0;
  let bad = 0;
  const take = (f: Fields) => {
    read++;
    const row = isInventory(format) ? stockRow(f) : productRow(format, f, currency);
    if (row) rows.push(row);
    else bad++;
  };

  if (isXml(format)) {
    const tag = (header?.tag as string | undefined) ?? xmlTag(format, text);
    if (!tag) {
      if (final || text.length >= PART_BYTES / 2) {
        if (!text.includes("<")) return { rows, read, bad, rest: "", header: null, error: { code: "format", detail: "The file is not XML." } };
        if (!final) {
          const expected = format === "heureka_xml" ? "<SHOPITEM>" : "<item> or <entry>";
          return { rows, read, bad, rest: "", header: null, error: { code: "format", detail: `No ${expected} in the first part of the feed.` } };
        }
      }
      return { rows, read, bad, rest: final ? "" : text, header: null };
    }
    const { records, rest, cut } = xmlRecords(text, tag, final);
    for (const record of records) take(xmlFields(record));
    read += cut;
    bad += cut;
    return { rows, read, bad, rest, header: { tag } };
  }

  let columns = header?.columns as string[] | undefined;
  let delimiter = header?.delimiter as string | undefined;
  let body = text;
  if (!columns || !delimiter) {
    const first = firstLine(text) ?? (final ? { line: text.replace(/\r?\n?$/, ""), end: text.length } : null);
    if (!first) return { rows, read, bad, rest: text, header: null };
    delimiter = csvDelimiter(first.line);
    columns = csvRecords(first.line + "\n", delimiter, false).records[0] ?? [];
    body = text.slice(first.end);
    const keys = format === "csv" ? plainColumns(columns) : columns.map(columnKey);
    const need = isInventory(format) ? [["store_code", "storecode", "store"], ["id", "itemid", "item_id"]] : [["id"], ["title"]];
    if (!need.every((names) => names.some((n) => keys.includes(n)))) {
      return {
        rows, read, bad, rest: "", header: null,
        error: {
          code: "columns",
          detail: `Columns found: ${columns.slice(0, 12).map((c) => c.slice(0, 30)).join(", ")}${columns.length > 12 ? ", …" : ""}`,
        },
      };
    }
  }
  const keys = format === "csv" ? plainColumns(columns) : columns.map(columnKey);
  const { records, rest } = csvRecords(body, delimiter, final);
  for (const record of records) {
    const f: Fields = new Map();
    record.forEach((value, i) => {
      const k = keys[i];
      if (k && !f.has(k)) f.set(k, value);
    });
    take(f);
  }
  return { rows, read, bad, rest, header: { columns, delimiter } };
}

/** The text encoding of a feed's first part: the BOM, the XML declaration, else UTF-8 when it is valid, else Windows-1250. */
export function detectEncoding(bytes: Uint8Array, xml: boolean): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return "utf-16";
  if (xml) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 300));
    const declared = /<\?xml[^>]*encoding\s*=\s*["']([\w.-]+)["']/i.exec(head)?.[1]?.toLowerCase();
    if (declared) {
      if (declared === "utf-8" || declared === "utf8") return "utf-8";
      if (declared === "windows-1250" || declared === "cp1250") return "windows-1250";
      if (declared === "iso-8859-2" || declared === "latin2") return "iso-8859-2";
      if (declared === "windows-1252" || declared === "cp1252") return "windows-1252";
      if (declared === "iso-8859-1" || declared === "latin1") return "iso-8859-1";
    }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {
    return "windows-1250";
  }
}

// ---------------------------------------------------------------- download into parts

export class TooBigError extends Error {}

/** Where a part may end: after the last line break, else after the last ">", else after the last ASCII byte. */
export function safeCut(buf: Uint8Array, len: number): number {
  const floor = Math.max(0, len - MB);
  for (let i = len - 1; i >= floor; i--) if (buf[i] === 0x0a) return i + 1;
  for (let i = len - 1; i >= floor; i--) if (buf[i] === 0x3e) return i + 1;
  for (let i = len - 1; i >= floor; i--) if (buf[i] < 0x80) return i + 1;
  return len;
}

/**
 * Copies a stream into parts of partBytes (never more than maxBytes in all: TooBigError, the stream is cancelled).
 * Parts end at a line break where they can, so no character is cut in two.
 */
export async function splitIntoParts(
  stream: ReadableStream<Uint8Array>,
  opts: { partBytes: number; maxBytes: number; put: (n: number, bytes: Uint8Array) => Promise<void> },
): Promise<{ parts: number; bytes: number }> {
  const reader = stream.getReader();
  let buf = new Uint8Array(opts.partBytes);
  let len = 0;
  let parts = 0;
  let total = 0;
  const flush = async (final: boolean) => {
    const cut = final ? len : safeCut(buf, len);
    await opts.put(parts, buf.slice(0, cut));
    parts++;
    const next = new Uint8Array(opts.partBytes);
    next.set(buf.subarray(cut, len), 0);
    len -= cut;
    buf = next;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > opts.maxBytes) throw new TooBigError(`more than ${Math.round(opts.maxBytes / MB)} MB`);
      let offset = 0;
      while (offset < value.length) {
        const n = Math.min(value.length - offset, buf.length - len);
        buf.set(value.subarray(offset, offset + n), len);
        len += n;
        offset += n;
        if (len === buf.length) await flush(false);
      }
    }
    if (len > 0) await flush(true);
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  return { parts, bytes: total };
}

/** The stream as it is, or unpacked when it is gzip. A ZIP file is refused (one feed per file). */
export async function unpacked(stream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader();
  const first = await reader.read();
  const head = first.value ?? new Uint8Array();
  const whole = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length) controller.enqueue(head);
      if (first.done) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    await whole.cancel();
    throw new FeedError("zip", "ZIP files are not read: give the feed as XML or CSV, or packed with gzip (.gz).");
  }
  if (head[0] === 0x1f && head[1] === 0x8b) {
    return whole.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  }
  return whole;
}

/** A public https address (no IP address, no local names, no user:password), else null. */
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

/** The feed from the partner's server, following at most 5 forwards — each one to a public https address too. */
async function fetchFeed(deps: Deps, address: string, previous: { modified?: string | null; etag?: string | null } | null, signal: AbortSignal): Promise<Response> {
  const start = safeUrl(address);
  if (!start) throw new FeedError("url", "The feed address is not a public https address.");
  let current: URL = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/xml, text/xml, text/csv, text/plain, */*" };
    if (previous?.modified) headers["If-Modified-Since"] = previous.modified;
    if (previous?.etag) headers["If-None-Match"] = previous.etag;
    const res: Response = await deps.fetch(current.href, { headers, redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location: string | null = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      const next: URL | null = location ? safeUrl(new URL(location, current).href) : null;
      if (!next) throw new FeedError("redirect", "The feed address forwards to an address that is not public https.");
      current = next;
      continue;
    }
    return res;
  }
  throw new FeedError("redirect", "The feed address forwards too many times.");
}

// ---------------------------------------------------------------- the steps

export interface Store {
  put(path: string, bytes: Uint8Array): Promise<void>;
  get(path: string): Promise<Uint8Array | null>;
  stream(path: string): Promise<ReadableStream<Uint8Array> | null>;
  remove(paths: string[]): Promise<void>;
}

export interface Deps {
  rpc(name: string, args?: Json): Promise<{ data: unknown; error: { message: string } | null }>;
  isAdmin(authorization: string): Promise<boolean>;
  store: Store;
  fetch: Fetch;
  /** Starts the next step of an import in its own call of this function. */
  chain(importId: string): Promise<void>;
  background(task: Promise<unknown>): void;
  serviceKey: string;
  maxBytes: number;
  partBytes: number;
  now(): number;
}

interface Job {
  id: string;
  partner_id: string;
  kind: "products" | "inventory";
  source: "url" | "file";
  status: "download" | "parse" | "error";
  url: string | null;
  file_path: string | null;
  file_at: string | null;
  format: Format;
  currency: string | null;
  parts: number;
  part_index: number;
  carry: string | null;
  encoding: string | null;
  header: Json | null;
  previous: { modified: string | null; etag: string | null; feed_time: string | null } | null;
}

async function call<T = unknown>(deps: Deps, name: string, args: Json): Promise<T> {
  const { data, error } = await deps.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}

export const partPath = (importId: string, n: number) => `imports/${importId}/${String(n).padStart(5, "0")}.part`;

async function removeParts(deps: Deps, importId: string, parts: number) {
  const paths = Array.from({ length: parts }, (_, n) => partPath(importId, n));
  for (let i = 0; i < paths.length; i += 500) await deps.store.remove(paths.slice(i, i + 500)).catch(() => {});
}

async function fail(deps: Deps, job: Job, code: string, detail: string, parts = job.parts) {
  await call(deps, "partner_import_fail", { p_import: job.id, p_error: code, p_detail: detail });
  await removeParts(deps, job.id, parts);
}

const maxMb = (deps: Deps) => Math.round(deps.maxBytes / MB);

/** Step 1: the feed into parts (or "not modified", or a reason). */
async function downloadStep(deps: Deps, job: Job): Promise<string> {
  let stream: ReadableStream<Uint8Array> | null = null;
  let feedTime: string | null = null;
  let modified: string | null = null;
  let etag: string | null = null;
  const signal = AbortSignal.timeout(DOWNLOAD_MS);
  let uploaded = 0;
  try {
    if (job.source === "file") {
      // The same uploaded file was read already: its data keeps the time it was uploaded.
      if (job.previous) {
        await call(deps, "partner_import_unchanged", { p_import: job.id });
        return "unchanged";
      }
      stream = job.file_path ? await deps.store.stream(job.file_path) : null;
      if (!stream) throw new FeedError("file_missing", "The uploaded feed file is not in storage: upload it again.");
      feedTime = job.file_at;
    } else {
      const res = await fetchFeed(deps, job.url ?? "", job.previous, signal);
      if (res.status === 304) {
        await res.body?.cancel().catch(() => {});
        await call(deps, "partner_import_unchanged", { p_import: job.id });
        return "unchanged";
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new FeedError("http", `The partner's server answered HTTP ${res.status}.`);
      }
      const length = Number(res.headers.get("content-length"));
      if (!res.headers.get("content-encoding") && Number.isFinite(length) && length > deps.maxBytes) {
        await res.body.cancel().catch(() => {});
        throw new TooBigError(`${Math.ceil(length / MB)} MB`);
      }
      modified = res.headers.get("last-modified");
      etag = res.headers.get("etag");
      const made = modified ? Date.parse(modified) : NaN;
      feedTime = new Date(Number.isFinite(made) && made <= deps.now() ? made : deps.now()).toISOString();
      stream = res.body;
    }
    const { parts, bytes } = await splitIntoParts(await unpacked(stream), {
      partBytes: deps.partBytes,
      maxBytes: deps.maxBytes,
      put: async (n, part) => {
        await deps.store.put(partPath(job.id, n), part);
        uploaded = n + 1;
      },
    });
    await call(deps, "partner_import_downloaded", {
      p_import: job.id, p_parts: parts, p_bytes: bytes, p_feed_time: feedTime, p_modified: modified, p_etag: etag,
    });
    return "parse";
  } catch (e) {
    await stream?.cancel().catch(() => {});
    if (e instanceof TooBigError) {
      await fail(deps, job, "too_big", `The feed is larger than ${maxMb(deps)} MB (${e.message}; PARTNER_FEED_MAX_MB). Nothing was imported or cut.`, uploaded);
    } else if (e instanceof FeedError) {
      await fail(deps, job, e.code, e.message, uploaded);
    } else {
      const timedOut = signal.aborted;
      await fail(deps, job, timedOut ? "timeout" : "download", timedOut ? `Downloading took longer than ${DOWNLOAD_MS / 1000} seconds.` : "The feed could not be downloaded.", uploaded);
    }
    return "error";
  }
}

/** Step 2: one part's rows (step 3 after the last part). */
async function parseStep(deps: Deps, job: Job): Promise<string> {
  if (job.part_index >= job.parts) return await finishStep(deps, job);
  const bytes = await deps.store.get(partPath(job.id, job.part_index));
  if (!bytes) {
    await fail(deps, job, "parts_missing", "A part of the feed is missing in storage; the next import reads it again.");
    return "error";
  }
  const encoding = job.encoding ?? detectEncoding(bytes, isXml(job.format));
  if (encoding === "utf-16") {
    await fail(deps, job, "encoding", "UTF-16 files are not read: save the feed as UTF-8.");
    return "error";
  }
  const text = (job.carry ?? "") + new TextDecoder(encoding).decode(bytes);
  const final = job.part_index === job.parts - 1;
  const parsed = parseText(job.format, text, final, job.header, job.currency);
  if (parsed.error) {
    await fail(deps, job, parsed.error.code, parsed.error.detail);
    return "error";
  }
  if (parsed.rest.length > MAX_CARRY) {
    await fail(deps, job, "record_too_big", "One item of the feed is longer than 1.5 MB.");
    return "error";
  }
  for (let i = 0; i === 0 || i < parsed.rows.length; i += BATCH) {
    const last = i + BATCH >= parsed.rows.length;
    await call(deps, "partner_import_rows", {
      p_import: job.id,
      p_part: job.part_index,
      p_rows: parsed.rows.slice(i, i + BATCH),
      p_last: last,
      p_carry: last ? parsed.rest : null,
      p_read: last ? parsed.read : 0,
      p_bad: last ? parsed.bad : 0,
      p_header: last ? parsed.header : null,
      p_encoding: last ? encoding : null,
    });
  }
  if (final) return await finishStep(deps, job);
  await deps.chain(job.id);
  return "parse";
}

async function finishStep(deps: Deps, job: Job): Promise<string> {
  const result = await call<{ status: string } | null>(deps, "partner_import_finish", { p_import: job.id });
  await removeParts(deps, job.id, job.parts);
  return result?.status ?? "done";
}

/** One step of one import (or of the oldest waiting one). */
export async function step(deps: Deps, importId: string | null): Promise<string> {
  const job = await call<Job | null>(deps, "partner_import_claim", { p_import: importId, p_lease_seconds: LEASE_SECONDS });
  if (!job) return "idle";
  if (job.status === "error") {
    // given up after 30 tries ("stuck")
    await removeParts(deps, job.id, job.parts);
    return "error";
  }
  try {
    if (job.status === "download") {
      const result = await downloadStep(deps, job);
      if (result === "parse") await deps.chain(job.id);
      return result;
    }
    return await parseStep(deps, job);
  } catch (e) {
    // The lock is let go; the job (every 5 minutes) tries again, at most 30 times without progress.
    console.error("partner-feeds: step failed", job.id, e instanceof Error ? e.message.slice(0, 200) : "error");
    await deps.rpc("partner_import_release", { p_import: job.id }).catch(() => {});
    return "retry";
  }
}

/** The due imports and the waiting ones, each to its own call. */
async function dispatch(deps: Deps): Promise<{ started: number; waiting: number }> {
  const started = (await call<string[] | null>(deps, "partner_start_due", {})) ?? [];
  const waiting = (await call<string[] | null>(deps, "partner_imports_waiting", {})) ?? [];
  const ids = [...new Set([...started, ...waiting])];
  await Promise.all(ids.map((id) => deps.chain(id).catch(() => {})));
  return { started: started.length, waiting: ids.length };
}

// ---------------------------------------------------------------- entry

function reply(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

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
      const { data: ok } = await deps.rpc("assistant_cron_ok", { p_secret: cron });
      if (ok !== true) return reply(401, { error: "secret" });
      if (action === "tick") return reply(200, await dispatch(deps));
      return reply(400, { error: "bad_request" });
    }
    const authorization = req.headers.get("Authorization") ?? "";
    if (action === "work") {
      // The next step of an import: only this function itself (the service role key).
      if (!sameSecret(authorization.replace(/^Bearer\s+/i, "").trim(), deps.serviceKey)) return reply(401, { error: "secret" });
      const id = String(body.import_id ?? "");
      if (!/^[0-9a-f-]{36}$/.test(id)) return reply(400, { error: "bad_request" });
      deps.background(step(deps, id));
      return reply(202, { queued: true });
    }
    if (!authorization || !(await deps.isAdmin(authorization))) return reply(403, { error: "not_admin" });
    if (action === "admin_status") {
      return reply(200, { env: { max_mb: maxMb(deps), ceiling_mb: CEILING_MAX_MB, part_mb: Math.round(deps.partBytes / MB) } });
    }
    if (action === "run") return reply(200, await dispatch(deps));
    return reply(400, { error: "bad_request" });
  } catch (e) {
    console.error("partner-feeds:", action, e instanceof Error ? e.message.slice(0, 200) : "error");
    return reply(500, { error: "failed" });
  }
}

/** PARTNER_FEED_MAX_MB: default 50, at most 500 (a whole number of MB). */
export function maxBytesFrom(value: string | null | undefined): number {
  const n = Number(value);
  const mb = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), CEILING_MAX_MB) : DEFAULT_MAX_MB;
  return mb * MB;
}

export function handler(req: Request): Promise<Response> {
  const env = (name: string) => Deno.env.get(name)?.trim() || null;
  const url = env("SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return Promise.resolve(reply(500, { error: "config" }));
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const db = createClient(url, serviceKey, options);
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const storageBase = `${url}/storage/v1/object/${BUCKET}/`;
  const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  return handle(req, {
    rpc: async (name, args) => {
      const { data, error } = await db.rpc(name, args ?? {});
      return { data, error: error ? { message: error.message } : null };
    },
    isAdmin: async (authorization) => {
      const { data } = await createClient(url, anonKey, { ...options, global: { headers: { Authorization: authorization } } }).rpc("is_admin");
      return data === true;
    },
    store: {
      put: async (path, bytes) => {
        const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: "application/octet-stream", upsert: true });
        if (error) throw new Error(`storage: ${error.message}`);
      },
      get: async (path) => {
        const { data, error } = await db.storage.from(BUCKET).download(path);
        return error || !data ? null : new Uint8Array(await data.arrayBuffer());
      },
      // Streamed, so a big uploaded file is never held in memory as a whole.
      stream: async (path) => {
        const res = await fetch(storageBase + encodePath(path), { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } });
        if (!res.ok || !res.body) {
          await res.body?.cancel().catch(() => {});
          return null;
        }
        return res.body;
      },
      remove: async (paths) => {
        await db.storage.from(BUCKET).remove(paths);
      },
    },
    fetch,
    chain: async (importId) => {
      const res = await fetch(`${url}/functions/v1/partner-feeds`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "work", import_id: importId }),
        signal: AbortSignal.timeout(15_000),
      });
      await res.body?.cancel().catch(() => {});
    },
    background: (task) => (runtime ? runtime.waitUntil(task) : void task),
    serviceKey,
    maxBytes: maxBytesFrom(env("PARTNER_FEED_MAX_MB")),
    partBytes: PART_BYTES,
    now: () => Date.now(),
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
