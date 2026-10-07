/// <reference lib="deno.ns" />
// PPI · stock-pull Edge Function
//
// Two ways a shop's stock file arrives:
//   * upload — the PPI window on the shop PC (/sync page in Edge or Chrome) watches the
//     folder the stock software exports to and POSTs the newest file here, with the
//     owner's own login (?shop_id=…&file_time=…&file_name=…, body = the file)
//   * pull — every 15 minutes (pg_cron, SETUP.md part G) for shops with a file address
//     (or a manual call): download the file, only if it changed
// Then, for both:
//   1. read XML, CSV or Excel into rows
//   2. no approved field mapping yet → propose one (Claude, or a rule-based guess),
//      save it as "proposed" with 10 sample rows and stop: the shop owner approves it
//   3. approved mapping → check the rows; if more than 5 % cannot be read, keep the
//      old stock and propose a new mapping; otherwise apply the whole file in one
//      transaction (apply_stock_file). The file's time becomes the freshness.
//   4. keep the raw file 7 days in the private "raw-files" bucket
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor →
// name "stock-pull" → paste this file → Deploy, then switch OFF "Verify JWT"
// (this function checks its callers itself). Secrets: PPI_CRON_SECRET (required),
// ANTHROPIC_API_KEY (optional, for AI mapping proposals).

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
const FETCH_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;

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

// ---------------------------------------------------------------- Claude proposal

/**
 * Asks Claude which column is which. Structured outputs pin the answer to a JSON
 * object whose values can only be real column names (or null), so it is always
 * usable. Returns null when no API key is set or the call fails — the caller then
 * falls back to guessMapping(). Never auto-approved: the shop owner confirms it.
 */
export async function proposeWithClaude(columns: string[], sample: Row[]): Promise<Mapping | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
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
        "Use null when a field is not in the file or you are not sure.",
      messages: [{ role: "user", content: JSON.stringify({ columns, sample_rows: sample.slice(0, 20) }) }],
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

// ---------------------------------------------------------------- one shop

interface Source {
  shop_id: string;
  file_format: string | null;
  file_url: string | null;
  field_mapping: Mapping | null;
  mapping_status: "proposed" | "confirmed";
  latest_file_time: string | null;
  last_file_hash: string | null;
  shops: { slug: string; name: string; country: string | null } | null;
}

type Outcome =
  | { status: "unchanged" }
  | { status: "proposed" | "waiting_for_approval" | "layout_changed"; rows: number }
  | { status: "updated"; items: number; zeroed: number; skipped: number }
  | { status: "error"; error: string };

function basicAuth(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
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
  const message = e instanceof Error ? (e.name === "TimeoutError" ? "The shop's computer did not answer within 30 seconds." : e.message) : String(e);
  await update({ last_error: message.slice(0, 500) });
  return { status: "error", error: message };
}

const isApproved = (src: Source) => src.mapping_status === "confirmed" && Boolean(src.field_mapping);

/** A file already applied (or older) is skipped, unless the admin forces a pull. */
const alreadyApplied = (src: Source, fileTime: Date, force: boolean) =>
  isApproved(src) && Boolean(src.latest_file_time) && !force && fileTime <= new Date(src.latest_file_time as string);

/**
 * Only public internet addresses: https with a host name, never localhost, an IP
 * address or an internal name (owners type these links themselves).
 */
export function isAllowedFileUrl(value: string, allowLocalHttp = false): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (allowLocalHttp && url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) return true;
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    host.includes(".") &&
    /[a-z]/.test(host) &&
    !/^[0-9.]+$/.test(host) &&
    !host.startsWith("[") &&
    host !== "localhost" &&
    !host.endsWith(".localhost") &&
    !host.endsWith(".internal") &&
    !host.endsWith(".local")
  );
}

/**
 * Addresses to try for one file link, best first. A OneDrive personal share link opens a
 * web page, so the file itself is asked for through OneDrive's share API (works for links
 * shared with "anyone with the link"), then with download=1, then as given.
 */
export function downloadCandidates(fileUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(fileUrl);
  } catch {
    return [fileUrl];
  }
  const host = url.hostname.toLowerCase();
  if (host === "1drv.ms" || host === "onedrive.live.com") {
    url.searchParams.delete("download");
    const share = url.toString();
    const encoded = btoa(share).replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
    const withDownload = new URL(share);
    withDownload.searchParams.set("download", "1");
    const candidates = [`https://api.onedrive.com/v1.0/shares/u!${encoded}/root/content`, withDownload.toString()];
    if (url.pathname.includes("/redir")) candidates.push(share.replace("/redir", "/download"));
    return [...candidates, share];
  }
  return [fileUrl];
}

/** A web page (e.g. a cloud viewer or login page) rather than a stock file. */
export function looksLikeWebPage(contentType: string | null, bytes: Uint8Array): boolean {
  if ((contentType ?? "").toLowerCase().includes("text/html")) return true;
  const head = new TextDecoder().decode(bytes.slice(0, 200)).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pull mode: download the file from the shop's file address (e.g. a cloud share link). */
async function pullShop(db: SupabaseClient, src: Source, force: boolean): Promise<Outcome> {
  const update = sourceUpdater(db, src.shop_id);
  try {
    if (!isAllowedFileUrl(src.file_url ?? "", Deno.env.get("PPI_ALLOW_LOCAL_HTTP") === "1")) {
      throw new Error("The file address must be a public https:// link.");
    }
    const { data: creds } = await db.rpc("sync_credentials", { p_shop_id: src.shop_id });
    const headers: Record<string, string> = { "User-Agent": "PPI stock-pull" };
    if (creds?.cf_client_id && creds?.cf_client_secret) {
      headers["CF-Access-Client-Id"] = creds.cf_client_id;
      headers["CF-Access-Client-Secret"] = creds.cf_client_secret;
    }
    if (creds?.basic_user && creds?.basic_password) headers.Authorization = basicAuth(creds.basic_user, creds.basic_password);
    if (isApproved(src) && src.latest_file_time && !force) headers["If-Modified-Since"] = new Date(src.latest_file_time).toUTCString();

    // Try each address for this link until one gives a file (not a web page).
    let response: Response | null = null;
    let firstBytes: Uint8Array | null = null;
    let sawWebPage = false;
    for (const candidate of downloadCandidates(src.file_url as string)) {
      const attempt = await fetch(candidate, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (attempt.status === 304) {
        response = attempt;
        break;
      }
      if (!attempt.ok) {
        response ??= attempt;
        await attempt.body?.cancel();
        continue;
      }
      const bytes = new Uint8Array(await attempt.arrayBuffer());
      if (looksLikeWebPage(attempt.headers.get("content-type"), bytes)) {
        sawWebPage = true;
        continue;
      }
      response = attempt;
      firstBytes = bytes;
      break;
    }
    if (!firstBytes && sawWebPage && response?.status !== 304) {
      throw new Error(
        "The link opens a web page, not the file. Share the file itself with \"Anyone with the link\" and paste that link (not a folder).",
      );
    }
    if (!response) throw new Error("Could not download the stock file.");
    if (response.status === 304) {
      await update({});
      return { status: "unchanged" };
    }
    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? " Check the shop's file access credentials."
          : response.status === 404
            ? " Check the file address and that the export file exists."
            : "";
      throw new Error(`Could not download the stock file (HTTP ${response.status}).${hint}`);
    }

    const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
    const fileTime = new Date(Number.isFinite(lastModified) ? Math.min(lastModified, Date.now()) : Date.now());
    if (alreadyApplied(src, fileTime, force)) {
      if (!firstBytes) await response.body?.cancel();
      await update({});
      return { status: "unchanged" };
    }
    const bytes = firstBytes ?? new Uint8Array(await response.arrayBuffer());
    // Cloud links often send no file date: then only changed content counts as a new
    // file, so an export that stopped does not look fresh.
    const hash = await sha256(bytes);
    if (!Number.isFinite(lastModified) && isApproved(src) && !force && hash === src.last_file_hash) {
      await update({});
      return { status: "unchanged" };
    }
    const outcome = await processFile(db, src, bytes, fileTime, update);
    if (outcome.status === "updated") await update({ last_file_hash: hash });
    return outcome;
  } catch (e) {
    return await failed(update, e);
  }
}

/** Both modes: read the file, propose or apply the field mapping, save the stock. */
async function processFile(db: SupabaseClient, src: Source, bytes: Uint8Array, fileTime: Date, update: Update): Promise<Outcome> {
  if (bytes.length === 0) throw new Error("The stock file is empty.");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("The stock file is larger than 50 MB.");
  const format = detectFormat(bytes, src.file_format);
  const rows = parseFile(bytes, format);
  if (rows.length === 0) throw new Error(`No items could be read from the file (read as ${format.toUpperCase()}).`);
  await keepRawFile(db, src.shop_id, bytes, format);

  const columns = Object.keys(rows[0]);
  const sample = rows.slice(0, 10);
  const propose = async () => (await proposeWithClaude(columns, rows.slice(0, 20))) ?? guessMapping(columns);

  if (!isApproved(src)) {
    if (src.field_mapping && isValidMapping(src.field_mapping, columns)) {
      await update({ sample_rows: sample, last_error: "Waiting for you to approve the file's columns in My shop." });
      return { status: "waiting_for_approval", rows: rows.length };
    }
    await update({
      field_mapping: await propose(),
      mapping_status: "proposed",
      sample_rows: sample,
      last_error: "New file layout: check and approve the file's columns in My shop.",
    });
    return { status: "proposed", rows: rows.length };
  }

  const { good, bad } = applyMapping(rows, src.field_mapping as Mapping, currencyForCountry(src.shops?.country));
  if (good.length === 0 || bad / rows.length > MAX_BAD_SHARE) {
    await update({
      field_mapping: await propose(),
      mapping_status: "proposed",
      sample_rows: sample,
      last_error:
        `${bad} of ${rows.length} rows could not be read — the file layout may have changed. ` +
        "The previous stock is kept until you approve the new columns in My shop.",
    });
    return { status: "layout_changed", rows: rows.length };
  }

  const { data, error } = await db.rpc("apply_stock_file", {
    p_shop_id: src.shop_id,
    p_rows: good,
    p_file_time: fileTime.toISOString(),
    p_sample: sample,
  });
  if (error) throw new Error(`Saving the stock failed: ${error.message}`);
  return { status: "updated", items: data.items, zeroed: data.zeroed, skipped: bad };
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
 * Upload mode: the PPI window on the shop PC (/sync page) sends the newest file from
 * the shop's export folder. POST body = the file (gzip=1: gzip-compressed),
 * query shop_id, file_time (the file's own time, ISO), file_name.
 * Only the shop's owners and the admin, with their own login.
 */
async function receiveUpload(req: Request, params: URLSearchParams, asCaller: SupabaseClient, db: SupabaseClient) {
  const shopId = params.get("shop_id") ?? "";
  if (!UUID.test(shopId)) return reply(400, { error: "shop_id is missing" });

  // Checks membership with the uploader's own login and records "PPI window seen".
  const { error: denied } = await asCaller.rpc("upload_check_in", { p_shop_id: shopId });
  if (denied) return reply(403, { error: "Only this shop's owners or the admin may upload its stock" });

  const { data: src, error } = await db
    .from("sync_sources")
    .select("shop_id, file_format, file_url, field_mapping, mapping_status, latest_file_time, last_file_hash, shops(slug, name, country)")
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
    if (alreadyApplied(source, fileTime, false)) {
      await req.body?.cancel();
      await update({});
      result = { status: "unchanged" };
    } else {
      result = await processFile(db, source, await readBody(req, params.get("gzip") === "1"), fileTime, update);
    }
  } catch (e) {
    result = await failed(update, e);
  }
  return reply(200, { result });
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
  const cronSecret = Deno.env.get("PPI_CRON_SECRET");
  if (!url || !serviceKey || !anonKey) return reply(500, { error: "Function is missing Supabase settings" });

  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Upload from the PPI window on the shop PC.
  const params = new URL(req.url).searchParams;
  if (params.has("shop_id")) return await receiveUpload(req, params, asCaller, db);

  let body: { shop_id?: string; force?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // Pull: the 15-minute schedule (shared secret), the admin, or an owner for their own
  // shop ("Download now" on the dashboard, never forced).
  const fromCron = Boolean(cronSecret) && req.headers.get("x-ppi-cron-secret") === cronSecret;
  if (!fromCron) {
    const { data: isAdmin } = await asCaller.rpc("is_admin");
    if (isAdmin !== true) {
      const shopId = String(body.shop_id ?? "");
      const { data: isOwner } = UUID.test(shopId)
        ? await asCaller.rpc("is_shop_member", { p_shop_id: shopId })
        : { data: false };
      if (isOwner !== true) return reply(403, { error: "Only the schedule, the admin or the shop's owner may run the stock pull" });
      body = { shop_id: shopId, force: false };
    }
  }

  let query = db
    .from("sync_sources")
    .select("shop_id, file_format, file_url, field_mapping, mapping_status, latest_file_time, last_file_hash, shops(slug, name, country)")
    .not("file_url", "is", null);
  if (body.shop_id) query = query.eq("shop_id", body.shop_id);
  const { data: sources, error } = await query;
  if (error) return reply(500, { error: error.message });

  const results: Record<string, Outcome> = {};
  const list = (sources ?? []) as unknown as Source[];
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    await Promise.all(
      list.slice(i, i + CONCURRENCY).map(async (src) => {
        results[src.shops?.slug ?? src.shop_id] = await pullShop(db, src, Boolean(body.force));
      }),
    );
  }
  return reply(200, { shops: list.length, results });
}

if (!Deno.env.get("PPI_STOCK_PULL_TEST")) Deno.serve(handler);
