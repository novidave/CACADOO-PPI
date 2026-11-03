import { readXlsx } from "./xlsx";

/**
 * "Import z eKasa" (database update 71): the daily export of a shop's cash register (or of the eKasa portal) as the file
 * writes it. Shared by the website (the server action that reads the upload) and its tests. The file is only READ here:
 * the lines go to SQL as written (owner_sklad_ekasa_import), which decides the product, books each line once and keeps
 * nothing but these columns — never the customer, the payment or the cashier.
 */

export const EKASA_MAX_BYTES = 1_900_000;
export const EKASA_MAX_ROWS = 5000;

export type EkasaField = "product" | "qty" | "doc" | "time" | "price" | "code" | "ean";
export const EKASA_FIELDS: EkasaField[] = ["product", "qty", "doc", "time", "price", "code", "ean"];
export type EkasaColumns = Partial<Record<EkasaField, string>>;

export interface EkasaTable {
  headers: string[];
  rows: string[][];
}

export interface EkasaLine {
  doc: string | null;
  time: string | null;
  text: string;
  code: string | null;
  ean: string | null;
  qty: string;
  price: string | null;
}

/** UTF-8 (with or without a BOM); a file that is not valid UTF-8 is Windows-1250 (Slovak / Hungarian registers). */
export function decodeText(bytes: Uint8Array): string {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1250").decode(body);
  }
}

/** CSV with ";" "," or tab (the most common in the first line), quotes, "" inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, Math.max(text.indexOf("\n"), 0) || text.length);
  const count = (c: string) => firstLine.split(c).length - 1;
  const sep = [";", "\t", ","].reduce((best, c) => (count(c) > count(best) ? c : best), ";");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

/** A CSV or XLSX export → the header row + the data rows (the first visible sheet of a workbook). */
export async function readTable(bytes: Uint8Array, fileName: string): Promise<EkasaTable> {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  let all: string[][];
  if (isZip || /\.xlsx$/i.test(fileName)) {
    const sheets = await readXlsx(bytes);
    all = (sheets.find((s) => !s.hidden) ?? sheets[0])?.rows ?? [];
  } else {
    all = parseCsv(decodeText(bytes));
  }
  const rows = all.map((r) => r.map((x) => String(x ?? "").trim())).filter((r) => r.some((x) => x !== ""));
  const [headers = [], ...data] = rows;
  return { headers: headers.map((h, i) => h || `#${i + 1}`), rows: data };
}

const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const GUESS: Record<EkasaField, RegExp> = {
  ean: /\b(ean|gtin|ciarovy|barcode|vonalkod)\b/,
  code: /\b(kod|plu|code|cikkszam|sku)\b/,
  doc: /\b(doklad|dokladu|uid|okp|receipt|blocek|blok|nyugta|bizonylat)\b/,
  time: /\b(datum|cas|date|time|vytvoren|idopont|datum a cas)\b/,
  qty: /\b(mnozstvo|pocet|qty|quantity|mennyiseg|ks|db|pcs)\b/,
  price: /\b(cena|price|ar|egysegar)\b/,
  product: /\b(nazov|polozka|polozky|tovar|produkt|item|name|popis|megnevezes|termek|text)\b/,
};

/** The likely column for each field by its name ("Názov položky", "Množstvo", "Číslo dokladu"…); one column, one field. */
export function guessColumns(headers: string[]): EkasaColumns {
  const out: EkasaColumns = {};
  const used = new Set<number>();
  for (const field of ["ean", "code", "doc", "time", "qty", "price", "product"] as EkasaField[]) {
    const i = headers.findIndex((h, n) => !used.has(n) && GUESS[field].test(plain(h)));
    if (i >= 0) {
      out[field] = headers[i];
      used.add(i);
    }
  }
  return out;
}

/** Usable when product + qty + (doc or time) are named and every named column is in this file. */
export function columnsFit(cols: EkasaColumns | null | undefined, headers: string[]): boolean {
  if (!cols?.product || !cols.qty || (!cols.doc && !cols.time)) return false;
  return EKASA_FIELDS.every((f) => !cols[f] || headers.includes(cols[f] as string));
}

/** "1 234,50" · "1234.50" · "−2" · "3 ks" → "1234.5" (as text for SQL); not a number → null. */
export function ekasaNumber(value: string | null | undefined): string | null {
  let s = String(value ?? "")
    .replace(/[\s  ]/g, "")
    .replace(/[−–]/g, "-")
    .replace(/(€|eur|ks|pcs|db|kg|l)$/i, "");
  if (!s) return null;
  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) s = comma > dot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (comma >= 0) s = s.replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : null;
}

/** The offset of a time zone at one moment, in minutes (Intl, no library). */
function zoneOffset(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - utcMs) / 60000);
}

/**
 * A wall-clock time in the shop's time zone → UTC. The hour that repeats when the clocks go back = its first
 * occurrence (summer time); a time skipped in spring = as if the clock had not moved yet.
 */
export function localToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsets = new Set([zoneOffset(guess - 86400000, timeZone), zoneOffset(guess + 86400000, timeZone)]);
  const valid = [...offsets].map((o) => guess - o * 60000).filter((t) => guess - zoneOffset(t, timeZone) * 60000 === t);
  return new Date(valid.length ? Math.min(...valid) : guess - Math.min(...offsets) * 60000);
}

/**
 * A receipt's time as the export writes it → ISO (UTC). Without an offset it is the shop's own time: "01.11.2026
 * 08:10:00", "1.11.2026 8:10", "2026-11-01 08:10", an Excel date number. With "Z" / "+01:00" as written.
 */
export function ekasaTime(value: string | null | undefined, timeZone: string): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  let m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) return localToUtc(+m[3], +m[2], +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), timeZone).toISOString();
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) return localToUtc(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), timeZone).toISOString();
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 80000) {
      const ms = Math.round((serial - 25569) * 86400000);
      const d = new Date(ms);
      return localToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), timeZone).toISOString();
    }
  }
  return null;
}

/** The rows → the lines SQL books, by the approved columns. Rows without a product text or a number are dropped. */
export function toLines(table: EkasaTable, cols: EkasaColumns, timeZone: string): EkasaLine[] {
  const at = (f: EkasaField) => (cols[f] ? table.headers.indexOf(cols[f] as string) : -1);
  const idx = Object.fromEntries(EKASA_FIELDS.map((f) => [f, at(f)])) as Record<EkasaField, number>;
  const cell = (r: string[], f: EkasaField) => (idx[f] >= 0 ? (r[idx[f]] ?? "").trim() : "");
  const out: EkasaLine[] = [];
  for (const r of table.rows.slice(0, EKASA_MAX_ROWS)) {
    const text = cell(r, "product").slice(0, 200);
    const qty = ekasaNumber(cell(r, "qty"));
    if (!text || qty === null) continue;
    out.push({
      doc: cell(r, "doc").slice(0, 80) || null,
      time: ekasaTime(cell(r, "time"), timeZone),
      text,
      code: cell(r, "code").slice(0, 80) || null,
      ean: cell(r, "ean").replace(/\D/g, "").slice(0, 32) || null,
      qty,
      price: ekasaNumber(cell(r, "price")),
    });
  }
  return out;
}

/** SHA-256 of the file (the same file twice = the same import). */
export async function fileHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
