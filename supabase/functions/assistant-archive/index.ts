/// <reference lib="deno.ns" />
// PPI · assistant-archive Edge Function
//
// The shop assistant's archive (paid plan; database update 22). Every conversation is kept
// for the shop's owners and, when it ends, made into one PDF. One file, pasted into the
// Supabase editor with "Verify JWT" OFF: it checks every caller itself.
//
//   The website (header x-ppi-archive = the function secret ASSISTANT_ARCHIVE_SECRET, which
//   is also a Vercel variable; only the website writes what the assistant said):
//     start   {shop_id, page_lang, caller}           → {id, token}   a new conversation
//     record  {id, token, shop_id, shopper, assistant}                one exchange (that shop's only)
//     end     {id, token, reason}                                     the shopper closed the chat
//     delete  {id, token}                                             "Vymazať moju konverzáciu"
//     discard {id, token, attachment}                                 a file taken back before sending
//   The shopper's browser (the conversation's token), multipart form:
//     upload  id, token, file, preview?              → {id, name, kind, preview}
//             JPEG, PNG, WebP, HEIC or PDF by their content (not their name), 10 MB, 10 per
//             conversation; GPS and place data are removed from pictures before storing.
//   The shop's owners (their login):
//     owner_links  {conversation_id} → 10-minute addresses of its pictures and files (to view)
//     owner_delete {conversation_id}
//   The jobs (pg_cron + pg_net, header x-ppi-cron = the Vault secret ppi_assistant_cron):
//     tick        every 5 minutes: end conversations idle for 30 minutes, make missing PDFs,
//                 forget ended conversations without a message
//     retention   once a day: delete conversations past the shop's keep time (30/90/365 days)
//
// Files live in the private bucket shop-assistant-uploads under <shop>/<conversation>/;
// only this function (service role) reads or writes them. Nothing of a conversation, a
// file, a token or a key is ever logged.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, rgb } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

export const BUCKET = "shop-assistant-uploads";
const LOGO_BUCKET = "logos";
export const MAX_FILE = 10 * 1024 * 1024;
const MAX_PREVIEW = 2 * 1024 * 1024;
const IDLE_MINUTES = 30;
const PDFS_PER_TICK = 3;
const SIGNED_SECONDS = 600;
/** Owner-facing texts of the PDF and the owner's version of foreign-language messages. */
const OWNER_LANG = "sk";

export type Kind = "jpeg" | "png" | "webp" | "heic" | "pdf";
export const MIME: Record<Kind, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
};

// ---------------------------------------------------------------- bytes

const ascii = (b: Uint8Array, at: number, n: number) =>
  at < 0 || at + n > b.length ? "" : String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The bytes as text, one character per byte (to search binary data; any length). */
function latin1(b: Uint8Array): string {
  let text = "";
  for (let i = 0; i < b.length; i += 8192) text += String.fromCharCode(...b.subarray(i, i + 8192));
  return text;
}

// ---------------------------------------------------------------- the real file type

const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);

/** The file's real type from its first bytes (the name and the browser's type are not trusted). */
export function detectKind(b: Uint8Array): Kind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a) {
    return "png";
  }
  if (b.length >= 16 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (b.length >= 16 && ascii(b, 4, 4) === "ftyp") {
    const size = Math.min(u32be(b, 0), b.length);
    const brands = [ascii(b, 8, 4)];
    for (let at = 16; at + 4 <= size; at += 4) brands.push(ascii(b, at, 4));
    return brands.some((brand) => HEIC_BRANDS.has(brand)) ? "heic" : null;
  }
  if (b.length >= 5 && ascii(b, 0, 5) === "%PDF-") return "pdf";
  return null;
}

// ---------------------------------------------------------------- GPS and place data out of pictures

const TIFF_TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/**
 * Empties the GPS directory of an EXIF (TIFF) block in place: its values are zeroed and the
 * directory gets 0 entries; everything else (e.g. the orientation) stays. "bad" when the
 * block cannot be read: the caller then drops the whole block.
 */
export function blankGpsInTiff(buf: Uint8Array, t: number, end: number): "removed" | "none" | "bad" {
  if (t < 0 || t + 8 > end || end > buf.length) return "bad";
  const le = buf[t] === 0x49 && buf[t + 1] === 0x49;
  if (!le && !(buf[t] === 0x4d && buf[t + 1] === 0x4d)) return "bad";
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (at: number) => view.getUint16(at, le);
  const u32 = (at: number) => view.getUint32(at, le);
  if (u16(t + 2) !== 42) return "bad";
  const ifd0 = t + u32(t + 4);
  if (ifd0 + 2 > end) return "bad";
  const entries = u16(ifd0);
  if (ifd0 + 2 + entries * 12 > end) return "bad";
  for (let i = 0; i < entries; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (u16(entry) !== 0x8825) continue;
    const gps = t + u32(entry + 8);
    if (gps + 2 > end) return "bad";
    const count = u16(gps);
    if (gps + 2 + count * 12 + 4 > end) return "bad";
    for (let j = 0; j < count; j++) {
      const field = gps + 2 + j * 12;
      const size = (TIFF_TYPE_SIZE[u16(field + 2)] ?? 0) * u32(field + 4);
      if (size > 4) {
        const at = t + u32(field + 8);
        if (at >= t && at + size <= end) buf.fill(0, at, at + size);
      }
    }
    buf.fill(0, gps + 2, gps + 2 + count * 12 + 4);
    view.setUint16(gps, 0, le);
    return "removed";
  }
  return "none";
}

/** XMP properties that hold a place: GPS, city, country, location. */
const XMP_PLACE = String.raw`(?:exif:GPS[A-Za-z]*|photoshop:(?:City|State|Country)|Iptc4xmpCore:(?:Location|CountryCode)|Iptc4xmpExt:(?:LocationCreated|LocationShown|City|CountryName|ProvinceState|Sublocation))`;

/** The same XMP text with every place value replaced by spaces (same length, so bytes stay in place). */
export function blankXmpPlaces(text: string): string {
  const spaces = (s: string) => s.replace(/[^\n]/g, " ");
  return text
    .replace(new RegExp(`(${XMP_PLACE}\\s*=\\s*)(["'])([\\s\\S]*?)\\2`, "g"), (_m, a: string, q: string, v: string) => a + q + spaces(v) + q)
    .replace(new RegExp(`(<(${XMP_PLACE})(?:\\s[^>]*)?>)([\\s\\S]*?)(</\\2>)`, "g"), (_m, open: string, _n: string, v: string, close: string) =>
      open + spaces(v) + close);
}

function blankXmpBytes(buf: Uint8Array, start: number, end: number): boolean {
  const text = latin1(buf.subarray(start, end));
  const blank = blankXmpPlaces(text);
  if (blank === text) return false;
  for (let i = 0; i < blank.length; i++) buf[start + i] = blank.charCodeAt(i);
  return true;
}

function stripJpeg(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Start of the image data (or its end): everything after it is kept as it is.
    if (marker === 0xda || marker === 0xd9) break;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const end = i + 2 + u16be(b, i + 2);
    if (end > b.length || end < i + 4) break;
    if (marker === 0xe1 && ascii(b, i + 4, 6) === "Exif\0\0") {
      const segment = b.slice(i, end);
      // An EXIF block that cannot be read is dropped whole.
      if (blankGpsInTiff(segment, 10, segment.length) !== "bad") out.push(segment);
    } else if (marker === 0xe1 && ascii(b, i + 4, 29).startsWith("http://ns.adobe.com/x")) {
      // XMP (may hold the place): dropped.
    } else if (marker === 0xed) {
      // Photoshop / IPTC (may hold city and country): dropped.
    } else {
      out.push(b.subarray(i, end));
    }
    i = end;
  }
  out.push(b.subarray(i));
  return concat(out);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function stripPng(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const length = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + length;
    if (end > b.length) break;
    if (type === "eXIf") {
      const chunk = b.slice(i, end);
      const result = blankGpsInTiff(chunk, 8, 8 + length);
      if (result !== "bad") {
        if (result === "removed") new DataView(chunk.buffer).setUint32(8 + length, crc32(chunk.subarray(4, 8 + length)));
        out.push(chunk);
      }
    } else if (
      (type === "iTXt" || type === "tEXt" || type === "zTXt") &&
      /^(XML:com\.adobe\.xmp|Raw profile type (exif|xmp|iptc|APP1))\0/i.test(ascii(b, i + 8, Math.min(length, 40)))
    ) {
      // XMP or EXIF kept as text (may hold the place): dropped.
    } else {
      out.push(b.subarray(i, end));
    }
    i = end;
    if (type === "IEND") break;
  }
  if (i < b.length) out.push(b.subarray(i));
  return concat(out);
}

function stripWebp(b: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let i = 12;
  let vp8x = -1;
  let exifKept = false;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const size = u32le(b, i + 4);
    const dataEnd = i + 8 + size;
    if (dataEnd > b.length) break;
    const end = Math.min(dataEnd + (size & 1), b.length);
    if (type === "EXIF") {
      const chunk = b.slice(i, end);
      const t = ascii(chunk, 8, 6) === "Exif\0\0" ? 14 : 8;
      if (blankGpsInTiff(chunk, t, 8 + size) !== "bad") {
        chunks.push(chunk);
        exifKept = true;
      }
    } else if (type !== "XMP ") {
      if (type === "VP8X") vp8x = chunks.length;
      chunks.push(b.subarray(i, end));
    }
    i = end;
  }
  if (vp8x >= 0) {
    // The flags say which extra chunks follow: EXIF only when kept, XMP never.
    const chunk = chunks[vp8x].slice();
    chunk[8] = chunk[8] & ~0x04 & ~(exifKept ? 0 : 0x08);
    chunks[vp8x] = chunk;
  }
  const body = concat(chunks);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 4));
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  head.set(b.subarray(8, 12), 8);
  return concat([head, body]);
}

interface Box {
  type: string;
  start: number;
  body: number;
  end: number;
}

function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = u32be(b, at);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = u32be(b, at + 8) * 2 ** 32 + u32be(b, at + 12);
      body = at + 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < body - at || at + size > end) break;
    out.push({ type: ascii(b, at + 4, 4), start: at, body, end: at + size });
    at += size;
  }
  return out;
}

/** Where the EXIF and XMP items of a HEIC file are (absolute byte ranges), or null. */
export function heifMetadata(b: Uint8Array): { exif: [number, number][]; xmp: [number, number][] } | null {
  const meta = boxes(b, 0, b.length).find((box) => box.type === "meta");
  if (!meta) return null;
  const children = boxes(b, meta.body + 4, meta.end);
  const iinf = children.find((box) => box.type === "iinf");
  const iloc = children.find((box) => box.type === "iloc");
  if (!iinf || !iloc) return null;
  const idat = children.find((box) => box.type === "idat");

  const types = new Map<number, string>();
  const iinfVersion = b[iinf.body];
  const entriesStart = iinf.body + 4 + (iinfVersion === 0 ? 2 : 4);
  for (const infe of boxes(b, entriesStart, iinf.end)) {
    if (infe.type !== "infe") continue;
    const version = b[infe.body];
    if (version < 2) continue;
    let at = infe.body + 4;
    const id = version === 2 ? u16be(b, at) : u32be(b, at);
    at += (version === 2 ? 2 : 4) + 2;
    const itemType = ascii(b, at, 4);
    at += 4;
    let contentType = "";
    if (itemType === "mime") {
      while (at < infe.end && b[at] !== 0) at++; // the item's name
      at++;
      const from = at;
      while (at < infe.end && b[at] !== 0) at++;
      contentType = ascii(b, from, at - from);
    }
    if (itemType === "Exif" || (itemType === "mime" && contentType.includes("rdf+xml"))) {
      types.set(id, itemType === "Exif" ? "exif" : "xmp");
    }
  }

  const version = b[iloc.body];
  let at = iloc.body + 4;
  const offsetSize = b[at] >> 4;
  const lengthSize = b[at] & 15;
  const baseSize = b[at + 1] >> 4;
  const indexSize = version === 1 || version === 2 ? b[at + 1] & 15 : 0;
  at += 2;
  const read = (n: number) => {
    let value = 0;
    for (let k = 0; k < n; k++) value = value * 256 + b[at + k];
    at += n;
    return value;
  };
  const count = version < 2 ? read(2) : read(4);
  const out = { exif: [] as [number, number][], xmp: [] as [number, number][] };
  for (let n = 0; n < count && at < iloc.end; n++) {
    const id = version < 2 ? read(2) : read(4);
    const method = version === 1 || version === 2 ? read(2) & 15 : 0;
    read(2); // data reference index
    const base = read(baseSize);
    const extents = read(2);
    for (let e = 0; e < extents; e++) {
      if (indexSize) read(indexSize);
      const offset = read(offsetSize);
      const length = read(lengthSize);
      const kind = types.get(id);
      if (!kind) continue;
      const startAt = method === 1 ? (idat ? idat.body + base + offset : -1) : base + offset;
      if (startAt >= 0 && startAt + length <= b.length && length > 0) out[kind as "exif" | "xmp"].push([startAt, startAt + length]);
    }
  }
  return out;
}

function stripHeic(b: Uint8Array): Uint8Array {
  const copy = b.slice();
  const places = heifMetadata(copy);
  if (places) {
    for (const [start, end] of places.exif) {
      const t = start + 4 + u32be(copy, start);
      if (blankGpsInTiff(copy, t, end) === "bad") copy.fill(0, start + 4, end);
    }
    for (const [start, end] of places.xmp) blankXmpBytes(copy, start, end);
    return copy;
  }
  // A layout we cannot read: look for EXIF and XMP blocks anywhere in the file.
  for (let i = 0; i + 14 < copy.length; i++) {
    if (copy[i] === 0x45 && ascii(copy, i, 6) === "Exif\0\0") blankGpsInTiff(copy, i + 6, Math.min(copy.length, i + 6 + 1_000_000));
  }
  const text = latin1(copy);
  for (const match of text.matchAll(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/g)) {
    blankXmpBytes(copy, match.index ?? 0, (match.index ?? 0) + match[0].length);
  }
  return copy;
}

/** The picture without GPS and place data (EXIF GPS emptied, XMP and IPTC dropped or blanked); a PDF as it is. */
export function stripLocation(bytes: Uint8Array, kind: Kind): Uint8Array {
  try {
    if (kind === "jpeg") return stripJpeg(bytes);
    if (kind === "png") return stripPng(bytes);
    if (kind === "webp") return stripWebp(bytes);
    if (kind === "heic") return stripHeic(bytes);
    return bytes;
  } catch {
    throw new Error("The picture's data could not be checked");
  }
}

// ---------------------------------------------------------------- the PDF

interface PdfCard {
  name?: string;
  price?: string;
  availability?: string;
  data_time?: string;
  quantity?: number;
  note?: string;
}

interface PdfMessage {
  role: "shopper" | "assistant";
  body: string;
  body_owner: string | null;
  lang: string | null;
  cards: PdfCard[];
  attachment_ids: string[];
  created_at: string;
}

interface PdfAttachment {
  id: string;
  name: string;
  kind: Kind;
  bytes: number;
  path: string;
  preview_path: string | null;
}

export interface PdfData {
  conversation: {
    id: string;
    shop_id: string;
    page_lang: string;
    shopper_lang: string | null;
    started_at: string;
    ended_at: string;
    message_count: number;
  };
  shop: { name: string; logo_url: string | null; timezone: string };
  messages: PdfMessage[];
  attachments: PdfAttachment[];
}

export interface PdfAssets {
  /** Attachment id → the small JPEG made in the shopper's browser. */
  previews: Map<string, Uint8Array>;
  /** The shop's logo as PNG or JPEG, when there is one. */
  logo: Uint8Array | null;
}

const PAGE: [number, number] = [595.28, 841.89];
const MARGIN = 48;
const TOP = PAGE[1] - 52;
const BOTTOM = 56;
const WIDTH = PAGE[0] - 2 * MARGIN;
const INK = rgb(0, 0, 0);
const GREY = rgb(0.42, 0.42, 0.42);
const LINE = rgb(0.82, 0.82, 0.82);

const TEXTS = {
  title: "Konverzácia s asistentom obchodu",
  shopper: "Zákazník",
  assistant: "Asistent",
  started: "Začiatok",
  ended: "Koniec",
  shopperLang: "Jazyk zákazníka",
  page: "stránka",
  unknown: "neznámy",
  inOwnerLang: "Po slovensky:",
  item: "Tovar",
  price: "Cena",
  availability: "Dostupnosť",
  dataAt: "Údaje k",
  file: "Súbor",
  noPreview: "náhľad nie je k dispozícii",
  otherFiles: "Ďalšie súbory",
  pieces: "ks",
  footer: (id: string, page: number, pages: number) => `Vytvorené Cacadoo PPI · konverzácia ${id} · strana ${page}/${pages}`,
};

/** The first 8 characters of the conversation's id, in the file name and the footer. */
export const shortId = (id: string) => id.replace(/-/g, "").slice(0, 8);

function parts(iso: string, timeZone: string) {
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return fields as Record<"year" | "month" | "day" | "hour" | "minute", string>;
}

/** <YYYY-MM-DD>_<HH-MM>_<short id>.pdf, in the shop's time zone. */
export function pdfFileName(startedAt: string, timeZone: string, id: string): string {
  const p = parts(startedAt, safeZone(timeZone));
  return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}_${shortId(id)}.pdf`;
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

const dateText = (iso: string, tz: string) => {
  const p = parts(iso, tz);
  return `${Number(p.day)}. ${Number(p.month)}. ${p.year}`;
};
const timeText = (iso: string, tz: string) => {
  const p = parts(iso, tz);
  return `${p.hour}:${p.minute}`;
};

function languageName(code: string | null): string {
  if (!code) return TEXTS.unknown;
  try {
    return new Intl.DisplayNames([OWNER_LANG], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;

class Writer {
  page!: PDFPage;
  y = TOP;
  readonly pages: PDFPage[] = [];
  private readonly glyphs: Set<number>;

  constructor(
    private readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.glyphs = new Set(regular.getCharacterSet());
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage(PAGE);
    this.pages.push(this.page);
    this.y = TOP;
  }

  /** Room for `height` more points on this page, else a new page. */
  room(height: number) {
    if (this.y - height < BOTTOM) this.newPage();
  }

  /** Characters the font has; anything else (e.g. emoji, Chinese) becomes "?". */
  clean(text: string): string {
    return [...text.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, "    ")]
      .map((ch) => (ch === "\n" || this.glyphs.has(ch.codePointAt(0)!) ? ch : "?"))
      .join("");
  }

  lines(text: string, font: PDFFont, size: number, width: number): string[] {
    const out: string[] = [];
    for (const paragraph of this.clean(text).split("\n")) {
      let line = "";
      for (const word of paragraph.split(/ +/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= width) {
          line = candidate;
          continue;
        }
        if (line) out.push(line);
        // A word longer than the line is cut where it must be.
        let rest = word;
        while (font.widthOfTextAtSize(rest, size) > width) {
          let cut = rest.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
          out.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      out.push(line);
    }
    return out;
  }

  /** One line: the text, cut with "…" when it is too long. */
  fit(text: string, font: PDFFont, size: number, width: number): string {
    let line = this.clean(text).replace(/\s+/g, " ");
    if (font.widthOfTextAtSize(line, size) <= width) return line;
    while (line && font.widthOfTextAtSize(`${line}…`, size) > width) line = line.slice(0, -1);
    return `${line}…`;
  }

  write(text: string, opts: { size: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number; width?: number; gap?: number }) {
    const font = opts.font ?? this.regular;
    const x = opts.x ?? MARGIN;
    const leading = opts.size * 1.32;
    for (const line of this.lines(text, font, opts.size, opts.width ?? WIDTH - (x - MARGIN))) {
      this.room(leading);
      this.page.drawText(line, { x, y: this.y - opts.size, size: opts.size, font, color: opts.color ?? INK });
      this.y -= leading;
    }
    this.y -= opts.gap ?? 0;
  }

  rule(gap = 8) {
    this.room(gap * 2);
    this.y -= gap;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + WIDTH, y: this.y }, thickness: 0.5, color: LINE });
    this.y -= gap;
  }
}

async function embedImage(doc: PDFDocument, bytes: Uint8Array): Promise<PDFImage | null> {
  try {
    const kind = detectKind(bytes);
    if (kind === "jpeg") return await doc.embedJpg(bytes);
    if (kind === "png") return await doc.embedPng(bytes);
  } catch {
    // a picture that cannot be read is left out
  }
  return null;
}

/** The conversation as a PDF: shop, times, every message in order with the owner's version, cards and pictures. */
export async function buildPdf(data: PdfData, assets: PdfAssets): Promise<Uint8Array> {
  const tz = safeZone(data.shop.timezone);
  const conv = data.conversation;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fontBytes("regular"), { subset: true });
  const bold = await doc.embedFont(fontBytes("bold"), { subset: true });
  doc.setTitle(`${TEXTS.title} ${shortId(conv.id)} – ${data.shop.name}`);
  doc.setCreator("Cacadoo PPI");
  doc.setProducer("Cacadoo PPI");
  doc.setLanguage(OWNER_LANG);
  const w = new Writer(doc, regular, bold);

  // The shop: logo and name.
  const logo = assets.logo ? await embedImage(doc, assets.logo) : null;
  let nameX = MARGIN;
  if (logo) {
    const scale = Math.min(40 / logo.height, 120 / logo.width, 1);
    const height = logo.height * scale;
    w.page.drawImage(logo, { x: MARGIN, y: w.y - height, width: logo.width * scale, height });
    nameX = MARGIN + logo.width * scale + 12;
    // The name beside the logo, in the middle of its height.
    w.y = TOP - Math.max(0, (height - 21) / 2);
    w.write(data.shop.name, { size: 16, font: bold, x: nameX, gap: 0 });
    w.y = Math.min(w.y, TOP - height) - 6;
  } else {
    w.write(data.shop.name, { size: 16, font: bold, gap: 2 });
  }
  w.write(TEXTS.title, { size: 11, gap: 2 });
  const started = `${dateText(conv.started_at, tz)} ${timeText(conv.started_at, tz)}`;
  const ended = dateText(conv.ended_at, tz) === dateText(conv.started_at, tz)
    ? timeText(conv.ended_at, tz)
    : `${dateText(conv.ended_at, tz)} ${timeText(conv.ended_at, tz)}`;
  w.write(`${TEXTS.started}: ${started} · ${TEXTS.ended}: ${ended}`, { size: 9.5, color: GREY });
  w.write(`${TEXTS.shopperLang}: ${languageName(conv.shopper_lang)} (${TEXTS.page}: ${languageName(conv.page_lang)})`, {
    size: 9.5,
    color: GREY,
  });
  w.rule(10);

  const byId = new Map(data.attachments.map((a) => [a.id, a]));
  const shown = new Set<string>();
  const images = new Map<string, PDFImage | null>();
  for (const [id, bytes] of assets.previews) images.set(id, await embedImage(doc, bytes));

  const files = (ids: string[]) => {
    const list = ids.map((id) => byId.get(id)).filter((a): a is PdfAttachment => Boolean(a));
    for (const a of list) shown.add(a.id);
    const pictures = list.filter((a) => images.get(a.id));
    const others = list.filter((a) => !images.get(a.id));
    const box = 110;
    const gap = 12;
    for (let row = 0; row < pictures.length; row += 4) {
      w.room(box + 18);
      const top = w.y;
      pictures.slice(row, row + 4).forEach((a, k) => {
        const image = images.get(a.id)!;
        const scale = Math.min(box / image.width, box / image.height);
        const x = MARGIN + k * (box + gap);
        w.page.drawImage(image, {
          x: x + (box - image.width * scale) / 2,
          y: top - box + (box - image.height * scale) / 2,
          width: image.width * scale,
          height: image.height * scale,
        });
        w.page.drawRectangle({ x, y: top - box, width: box, height: box, borderColor: LINE, borderWidth: 0.5 });
        w.page.drawText(w.fit(a.name, regular, 7.5, box), { x, y: top - box - 10, size: 7.5, font: regular, color: GREY });
      });
      w.y = top - box - 18;
    }
    for (const a of others) {
      const note = a.kind !== "pdf" ? ` – ${TEXTS.noPreview}` : "";
      w.write(`${TEXTS.file}: ${a.name} (${a.kind.toUpperCase()}, ${sizeText(a.bytes)})${note}`, { size: 9, color: GREY });
    }
  };

  const table = (cards: PdfCard[]) => {
    const cols = [WIDTH - 264, 66, 112, 86];
    const xs = cols.map((_, i) => MARGIN + cols.slice(0, i).reduce((n, c) => n + c, 0));
    const size = 8.5;
    const row = (cells: string[], font: PDFFont) => {
      const wrapped = cells.map((cell, i) => w.lines(cell, font, size, cols[i] - 6));
      const height = Math.max(...wrapped.map((l) => l.length)) * size * 1.3 + 4;
      w.room(height);
      wrapped.forEach((lines, i) =>
        lines.forEach((line, n) =>
          w.page.drawText(line, { x: xs[i], y: w.y - size - n * size * 1.3, size, font, color: INK })
        )
      );
      w.y -= height;
      w.page.drawLine({ start: { x: MARGIN, y: w.y + 2 }, end: { x: MARGIN + WIDTH, y: w.y + 2 }, thickness: 0.4, color: LINE });
    };
    w.room(40);
    row([TEXTS.item, TEXTS.price, TEXTS.availability, TEXTS.dataAt], bold);
    for (const card of cards) {
      const extra = [card.quantity ? `${card.quantity} ${TEXTS.pieces}` : "", card.note ?? ""].filter(Boolean).join(" – ");
      const at = card.data_time
        ? dateText(card.data_time, tz) === dateText(conv.started_at, tz)
          ? timeText(card.data_time, tz)
          : `${dateText(card.data_time, tz)} ${timeText(card.data_time, tz)}`
        : "–";
      row([`${card.name ?? ""}${extra ? ` (${extra})` : ""}`, card.price ?? "", card.availability ?? "–", at], regular);
    }
    w.y -= 4;
  };

  for (const m of data.messages) {
    w.room(40);
    w.write(`${timeText(m.created_at, tz)} · ${m.role === "shopper" ? TEXTS.shopper : TEXTS.assistant}`, {
      size: 9,
      font: bold,
      color: GREY,
      gap: 1,
    });
    if (m.body) w.write(m.body, { size: 10.5, gap: 2 });
    if (m.body_owner) w.write(`${TEXTS.inOwnerLang} ${m.body_owner}`, { size: 8.5, color: GREY, gap: 2 });
    if (m.role === "shopper" && m.attachment_ids?.length) files(m.attachment_ids);
    if (m.role === "assistant" && m.cards?.length) table(m.cards);
    w.y -= 8;
  }
  const loose = data.attachments.filter((a) => !shown.has(a.id)).map((a) => a.id);
  if (loose.length) {
    w.write(TEXTS.otherFiles, { size: 9, font: bold, color: GREY, gap: 2 });
    files(loose);
  }

  const total = w.pages.length;
  w.pages.forEach((page, i) => {
    const text = TEXTS.footer(shortId(conv.id), i + 1, total);
    const size = 7.5;
    page.drawText(text, { x: (PAGE[0] - regular.widthOfTextAtSize(text, size)) / 2, y: 28, size, font: regular, color: GREY });
  });
  return await doc.save();
}

// ---------------------------------------------------------------- the archive's work

export interface Deps {
  /** Service role: the database functions and the private bucket. */
  db: SupabaseClient;
  /** The caller's own login (owners): RLS decides what they may see. */
  asCaller: (authorization: string) => SupabaseClient;
  /** ASSISTANT_ARCHIVE_SECRET: only the website writes conversations. */
  websiteSecret: string | null;
  /** Work that may finish after the reply (EdgeRuntime.waitUntil in Supabase). */
  background: (task: Promise<unknown>) => void;
  /**
   * Asks the cloud-export function to copy a conversation to the shop's cloud folder now
   * (update 23). A failure does not matter: its job copies what waits every 5 minutes.
   */
  pushToCloud: (id: string) => Promise<void>;
}

type Json = Record<string, unknown>;

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
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

/** A database refusal → an answer the website and the shopper's browser understand. */
function refused(error: { message?: string; code?: string } | null) {
  const message = error?.message ?? "";
  if (message === "no_plan") return reply(403, { error: "no_plan" });
  if (message === "not_found" || error?.code === "P0002") return reply(404, { error: "not_found" });
  if (message === "ended") return reply(409, { error: "ended" });
  if (message === "too_many_files") return reply(409, { error: "too_many_files" });
  if (message === "too_many") return reply(429, { error: "too_many" });
  if (message === "type") return reply(415, { error: "type" });
  if (message === "too_big") return reply(413, { error: "too_big" });
  return reply(500, { error: "failed", message: message.slice(0, 200) });
}

/** Equal strings, compared in constant time. */
function sameSecret(given: string | null, expected: string | null): boolean {
  if (!given || !expected || expected.length < 32) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

async function removeFiles(deps: Deps, id: string): Promise<boolean> {
  const { data: paths, error } = await deps.db.rpc("assistant_files", { p_id: id });
  if (error) throw new Error(error.message);
  const list = ((paths ?? []) as string[]).filter(Boolean);
  for (let i = 0; i < list.length; i += 500) {
    const { error: storageError } = await deps.db.storage.from(BUCKET).remove(list.slice(i, i + 500));
    if (storageError) return false;
  }
  return true;
}

/** Files first, then the rows: nothing is left behind in the bucket. */
async function forget(deps: Deps, id: string): Promise<boolean> {
  if (!(await removeFiles(deps, id))) return false;
  const { error } = await deps.db.rpc("assistant_forget", { p_id: id });
  return !error;
}

/**
 * The shopper's "Vymazať moju konverzáciu": files first, then the rows. When something was
 * already copied to the shop's cloud folder, the database keeps a line without any content
 * ("zákazník požiadal o vymazanie" + the cloud folder) so the owner can delete it there.
 */
async function forgetForShopper(deps: Deps, id: string): Promise<boolean> {
  if (!(await removeFiles(deps, id))) return false;
  const { error } = await deps.db.rpc("assistant_shopper_forget", { p_id: id });
  return !error;
}

async function download(deps: Deps, bucket: string, path: string): Promise<Uint8Array | null> {
  const { data, error } = await deps.db.storage.from(bucket).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/** The logo's storage path (public URL → path); a WebP logo has a PNG twin for PDFs. */
export function logoPaths(logoUrl: string | null): string[] {
  if (!logoUrl) return [];
  const match = /\/storage\/v1\/object\/public\/logos\/(.+?)(\?.*)?$/.exec(logoUrl);
  if (!match) return [];
  const path = decodeURIComponent(match[1]);
  return /\.webp$/i.test(path) ? [path.replace(/\.webp$/i, ".png")] : [path];
}

/** Makes and stores the PDF of an ended conversation; a failure is noted and tried again later. */
export async function makePdf(deps: Deps, id: string): Promise<boolean> {
  try {
    const { data, error } = await deps.db.rpc("assistant_pdf_data", { p_id: id });
    if (error) throw new Error(error.message);
    if (!data) return false;
    const pdfData = data as PdfData;
    const previews = new Map<string, Uint8Array>();
    for (const a of pdfData.attachments) {
      if (!a.preview_path) continue;
      const bytes = await download(deps, BUCKET, a.preview_path);
      if (bytes && detectKind(bytes) === "jpeg") previews.set(a.id, bytes);
    }
    let logo: Uint8Array | null = null;
    for (const path of logoPaths(pdfData.shop.logo_url)) {
      logo = await download(deps, LOGO_BUCKET, path);
      if (logo) break;
    }
    const bytes = await buildPdf(pdfData, { previews, logo });
    const name = pdfFileName(pdfData.conversation.started_at, pdfData.shop.timezone, id);
    const path = `${pdfData.conversation.shop_id}/${id}/${name}`;
    const { error: uploadError } = await deps.db.storage.from(BUCKET).upload(path, bytes, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (uploadError) throw new Error(`storing the PDF failed: ${uploadError.message}`);
    const { data: queued } = await deps.db.rpc("assistant_pdf_done", { p_id: id, p_path: path, p_name: name, p_error: null });
    if (queued === true) await deps.pushToCloud(id).catch(() => {});
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("assistant-archive: pdf", id, message.slice(0, 200));
    await deps.db.rpc("assistant_pdf_done", { p_id: id, p_path: null, p_name: null, p_error: message.slice(0, 500) });
    return false;
  }
}

/** An ended conversation: its PDF, or (without a message) it is forgotten. */
async function afterEnd(deps: Deps, id: string, messages: number) {
  if (messages > 0) await makePdf(deps, id);
  else await forget(deps, id);
}

// ---------------------------------------------------------------- actions

async function start(body: Json, deps: Deps) {
  const { data, error } = await deps.db.rpc("assistant_open", {
    p_shop_id: String(body.shop_id ?? ""),
    p_page_lang: String(body.page_lang ?? "sk"),
    p_ip_hash: String(body.caller ?? ""),
  });
  if (error) return refused(error);
  return reply(200, data);
}

async function record(body: Json, deps: Deps) {
  const { error } = await deps.db.rpc("assistant_add_turn", {
    p_id: String(body.id ?? ""),
    p_token: String(body.token ?? ""),
    p_shop_id: String(body.shop_id ?? ""),
    p_shopper: body.shopper ?? {},
    p_assistant: body.assistant ?? {},
  });
  if (error) return refused(error);
  return reply(200, { ok: true });
}

async function end(body: Json, deps: Deps) {
  const id = String(body.id ?? "");
  const token = String(body.token ?? "");
  const { data: conv } = await deps.db.rpc("assistant_conversation", { p_id: id, p_token: token });
  if (!conv) return reply(404, { error: "not_found" });
  const { data: ended, error } = await deps.db.rpc("assistant_end", {
    p_id: id,
    p_token: token,
    p_reason: body.reason === "new" ? "new" : "closed",
  });
  if (error) return refused(error);
  // The PDF is made after the reply: the shopper never waits for it.
  if (ended) deps.background(afterEnd(deps, id, Number((conv as Json).messages ?? 0)));
  return reply(200, { ended: Boolean(ended) });
}

async function shopperDelete(body: Json, deps: Deps) {
  const id = String(body.id ?? "");
  const { data: conv } = await deps.db.rpc("assistant_conversation", { p_id: id, p_token: String(body.token ?? "") });
  if (!conv) return reply(404, { error: "not_found" });
  return (await forgetForShopper(deps, id)) ? reply(200, { deleted: true }) : reply(502, { error: "storage" });
}

/** A file the shopper took back before sending: stored files first, then the row. */
async function discard(body: Json, deps: Deps) {
  const attachment = String(body.attachment ?? "");
  const { data, error } = await deps.db.rpc("assistant_discardable", {
    p_id: String(body.id ?? ""),
    p_token: String(body.token ?? ""),
    p_attachment: attachment,
  });
  if (error) return refused(error);
  const paths = ((data ?? []) as string[]).filter(Boolean);
  if (!data) return reply(404, { error: "not_found" });
  if (paths.length) {
    const { error: storageError } = await deps.db.storage.from(BUCKET).remove(paths);
    if (storageError) return reply(502, { error: "storage" });
  }
  await deps.db.rpc("assistant_drop_attachment", { p_attachment: attachment });
  return reply(200, { discarded: true });
}

async function upload(req: Request, deps: Deps) {
  const form = await req.formData().catch(() => null);
  if (!form) return reply(400, { error: "bad_request" });
  const file = form.get("file");
  const preview = form.get("preview");
  if (!(file instanceof File) || file.size === 0) return reply(400, { error: "bad_request" });
  if (file.size > MAX_FILE) return reply(413, { error: "too_big" });
  const raw = new Uint8Array(await file.arrayBuffer());
  const kind = detectKind(raw);
  if (!kind) return reply(415, { error: "type" });
  let clean: Uint8Array;
  try {
    clean = stripLocation(raw, kind);
  } catch {
    return reply(415, { error: "type" });
  }
  let small: Uint8Array | null = null;
  if (kind !== "pdf" && preview instanceof File && preview.size > 0 && preview.size <= MAX_PREVIEW) {
    const bytes = new Uint8Array(await preview.arrayBuffer());
    if (detectKind(bytes) === "jpeg") small = stripLocation(bytes, "jpeg");
  }

  const { data, error } = await deps.db.rpc("assistant_add_attachment", {
    p_id: String(form.get("id") ?? ""),
    p_token: String(form.get("token") ?? ""),
    p_name: file.name,
    p_kind: kind,
    p_bytes: clean.length,
    p_preview: small !== null,
  });
  if (error) return refused(error);
  const att = data as { id: string; name: string; path: string; preview_path: string | null };
  const storage = deps.db.storage.from(BUCKET);
  const stored = await storage.upload(att.path, clean, { contentType: MIME[kind], upsert: false });
  const previewStored = small && att.preview_path
    ? await storage.upload(att.preview_path, small, { contentType: "image/jpeg", upsert: false })
    : { error: null };
  if (stored.error || previewStored.error) {
    await storage.remove([att.path, ...(att.preview_path ? [att.preview_path] : [])]);
    await deps.db.rpc("assistant_drop_attachment", { p_attachment: att.id });
    return reply(502, { error: "storage" });
  }
  return reply(200, { id: att.id, name: att.name, kind, preview: Boolean(att.preview_path) });
}

/** The owner may see this conversation (RLS: members of its shop only)? */
async function ownConversation(authorization: string, id: string, deps: Deps): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const { data } = await deps.asCaller(authorization)
    .from("assistant_conversations")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  return Boolean(data);
}

async function ownerLinks(authorization: string, body: Json, deps: Deps) {
  const id = String(body.conversation_id ?? "");
  if (!(await ownConversation(authorization, id, deps))) return reply(403, { error: "not_member" });
  const { data, error } = await deps.db
    .from("assistant_attachments")
    .select("id, kind, storage_path, preview_path")
    .eq("conversation_id", id);
  if (error) return reply(500, { error: "failed" });
  const rows = (data ?? []) as { id: string; kind: Kind; storage_path: string; preview_path: string | null }[];
  const paths = rows.flatMap((r) => [r.storage_path, ...(r.preview_path ? [r.preview_path] : [])]);
  const signed = new Map<string, string>();
  if (paths.length) {
    const { data: urls } = await deps.db.storage.from(BUCKET).createSignedUrls(paths, SIGNED_SECONDS);
    (urls ?? []).forEach((u, i) => {
      if (u?.signedUrl) signed.set(paths[i], u.signedUrl);
    });
  }
  const files: Record<string, { original: string | null; preview: string | null }> = {};
  for (const r of rows) {
    files[r.id] = { original: signed.get(r.storage_path) ?? null, preview: r.preview_path ? signed.get(r.preview_path) ?? null : null };
  }
  return reply(200, { files });
}

async function ownerDelete(authorization: string, body: Json, deps: Deps) {
  const id = String(body.conversation_id ?? "");
  if (!(await ownConversation(authorization, id, deps))) return reply(403, { error: "not_member" });
  return (await forget(deps, id)) ? reply(200, { deleted: true }) : reply(502, { error: "storage" });
}

async function tick(deps: Deps) {
  const { data: idle, error } = await deps.db.rpc("assistant_end_idle", { p_minutes: IDLE_MINUTES });
  if (error) return reply(500, { error: "failed", message: error.message });
  let forgotten = 0;
  const { data: empty } = await deps.db.rpc("assistant_empty_ended", { p_limit: 50 });
  for (const id of (empty ?? []) as string[]) if (await forget(deps, id)) forgotten++;
  let pdfs = 0;
  const { data: todo } = await deps.db.rpc("assistant_pdf_todo", { p_limit: PDFS_PER_TICK });
  for (const id of (todo ?? []) as string[]) if (await makePdf(deps, id)) pdfs++;
  return reply(200, { ended: ((idle ?? []) as string[]).length, forgotten, pdfs });
}

async function retention(deps: Deps) {
  const { data, error } = await deps.db.rpc("assistant_expired", { p_limit: 200 });
  if (error) return reply(500, { error: "failed", message: error.message });
  let deleted = 0;
  for (const id of (data ?? []) as string[]) if (await forget(deps, id)) deleted++;
  return reply(200, { deleted });
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return reply(200, {});
  if (req.method !== "POST") return reply(405, { error: "method" });

  if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) return upload(req, deps);

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
      const { data: ok } = await deps.db.rpc("assistant_cron_ok", { p_secret: cron });
      if (ok !== true) return reply(401, { error: "secret" });
      if (action === "tick") return await tick(deps);
      if (action === "retention") return await retention(deps);
      return reply(400, { error: "bad_request" });
    }
    if (action === "start" || action === "record" || action === "end" || action === "delete" || action === "discard") {
      if (!sameSecret(req.headers.get("x-ppi-archive"), deps.websiteSecret)) return reply(401, { error: "secret" });
      if (action === "start") return await start(body, deps);
      if (action === "record") return await record(body, deps);
      if (action === "end") return await end(body, deps);
      if (action === "discard") return await discard(body, deps);
      return await shopperDelete(body, deps);
    }
    if (action === "owner_links" || action === "owner_delete") {
      const authorization = req.headers.get("Authorization") ?? "";
      const token = authorization.replace(/^Bearer\s+/i, "").trim();
      const { data: auth } = token ? await deps.asCaller(authorization).auth.getUser(token) : { data: null };
      if (!auth?.user) return reply(401, { error: "login" });
      return action === "owner_links" ? await ownerLinks(authorization, body, deps) : await ownerDelete(authorization, body, deps);
    }
    return reply(400, { error: "bad_request" });
  } catch (e) {
    console.error("assistant-archive:", action, (e instanceof Error ? e.message : String(e)).slice(0, 200));
    return reply(500, { error: "failed" });
  }
}

export async function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return reply(500, { error: "config", message: "Function is missing Supabase settings" });
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  return await handle(req, {
    db: createClient(url, serviceKey, options),
    asCaller: (authorization) => createClient(url, anonKey, { ...options, global: { headers: { Authorization: authorization } } }),
    websiteSecret: Deno.env.get("ASSISTANT_ARCHIVE_SECRET")?.trim() || null,
    background: (task) => (runtime ? runtime.waitUntil(task) : void task),
    pushToCloud: async (id) => {
      const response = await fetch(`${url}/functions/v1/cloud-export`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "export", conversation_id: id }),
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (!response.ok) console.error("assistant-archive: cloud push", id, response.status);
    },
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);

// ---------------------------------------------------------------- the PDF's font

// DejaVu Sans and DejaVu Sans Bold, cut down to the letters a conversation needs (Latin with
// all Central European letters, Greek, Cyrillic, punctuation, €) with:
//   pyftsubset DejaVuSans[-Bold].ttf --unicodes="U+0020-007E,U+00A0-017F,U+0218-021B,U+0370-03CE,
//     U+0400-045F,U+0490-0491,U+2010-2026,U+2030,U+2039-203A,U+20AC,U+2116,U+2122,
//     U+2190-2193,U+2212,U+FFFD" --no-hinting --desubroutinize --drop-tables+=GPOS,GSUB,kern,FFTM
//
// Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved. Bitstream Vera is a trademark of
// Bitstream, Inc. DejaVu changes are in public domain.
// Permission is hereby granted, free of charge, to any person obtaining a copy of the fonts
// accompanying this license ("Fonts") and associated documentation files (the "Font
// Software"), to reproduce and distribute the Font Software, including without limitation the
// rights to use, copy, merge, publish, distribute, and/or sell copies of the Font Software,
// and to permit persons to whom the Font Software is furnished to do so, subject to the
// following conditions:
// The above copyright and trademark notices and this permission notice shall be included in
// all copies of one or more of the Font Software typefaces.
// The Font Software may be modified, altered, or added to, and in particular the designs of
// glyphs or characters in the Fonts may be modified and additional glyphs or characters may be
// added to the Fonts, only if the fonts are renamed to names not containing either the words
// "Bitstream" or the word "Vera".
// This License becomes null and void to the extent applicable to Fonts or Font Software that
// has been modified and is distributed under the "Bitstream Vera" names.
// The Font Software may be sold as part of a larger software package but no copy of one or
// more of the Font Software typefaces may be sold by itself.
// THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
// PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT
// SHALL BITSTREAM OR THE GNOME FOUNDATION BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
// INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE THE
// FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.
// Except as contained in this notice, the names of Gnome, the Gnome Foundation, and Bitstream
// Inc., shall not be used in advertising or otherwise to promote the sale, use or other
// dealings in this Font Software without prior written authorization from the Gnome
// Foundation or Bitstream Inc., respectively.

const fontCache = new Map<string, Uint8Array>();

function fontBytes(weight: "regular" | "bold"): Uint8Array {
  let bytes = fontCache.get(weight);
  if (!bytes) {
    const text = (weight === "regular" ? FONT_REGULAR : FONT_BOLD).join("");
    bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    fontCache.set(weight, bytes);
  }
  return bytes;
}

// DejaVu Sans, subset (Latin, Latin Extended-A, Greek, Cyrillic, punctuation), base64.
const FONT_REGULAR: string[] = [
  "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",
  "AAABFRMjAzUBhVKBpAXVmP7BAT+YAAACAK4D6QNtBdUABQALAAABIzUTMwMFIzUTMwMBgdOkgVIBmtOkgVID6a0BP/7Bra0BP/7B",
  "AAACAK4D6QNtBdUABQALAAABMxUDIxMlMxUDIxMBANOkgVIBmtOkgVIF1az+wAFArKz+wAFAAAACAK7/EgNtAP4ABQALAAAlMxUD",
  "IxMlMxUDIxMCmtOkgVL+ZtOkgVL+rP7AAUCsrP7AAUAAAgCuA+kDbQXVAAUACwAAARUTIwM1IRUTIwM1AYFSgaQCbVKBpAXVrf7B",
  "AT+trf7BAT+tAAEAOf87A8cF1QALAAABMxEhFSERIxEhNSEBqLABb/6RsP6RAW8F1f5cmfujBF2ZAAEAOf87A8cF1QATAAAlIREj",
  "ESE1IREhNSERMxEhFSERIQPH/pGw/pEBb/6RAW+wAW/+kQFv3/5cAaSaAh+ZAaT+XJn94QABATMB0QOFBCEACwAAATQ2MzIWFRQG",
  "IyImATOtfnyrrH19rAL6fKurfH2srAAAAQEzAYED1QRxAAUAAAEwETABMAEzAqIBgQLw/ogAAQDsAAABwQD+AAMAADczFSPs1dX+",
  "/gAAAgDsAAAEawD+AAMABwAAJTMVIyUzFSMDltXV/VbV1f7+/v4AAwDsAAAHFAD+AAMABwALAAAlMxUjJTMVIyUzFSMDltTUAqnV",
  "1fqt1dX+/v7+/v4ABwBx/+MKTAXwAAsAFwAjACcAMwA/AEsAAAEiBhUUFjMyNjU0JicyFhUUBiMiJjU0NgEyFhUUBiMiJjU0NiEz",
  "ASMTIgYVFBYzMjY1NCYBMhYVFAYjIiY1NDYXIgYVFBYzMjY1NCYI9FdkZFdVY2NVnrq7naC6u/l0nry7n5+5ugQloPxaoB9WY2JX",
  "V2NkA7KeurudoLq7n1djY1dVY2MCkZSEgpWVgoOVf9y7u9vbu7zbAuDbu73a27y63PnzBY6VgoSUlISBlv2f3Lu729u7vNt/lISC",
  "lZWCg5UAAAEAngCNAnMEIwAGAAABFQkBFQE1AnP+0wEt/isEI7/+9P70vwGiUgABAMEAjQKWBCMABgAAEwEVATUJAcEB1f4rAS3+",
  "0wQj/l5S/l6/AQwBDAAB/on/4wLNBfAAAwAAATMBIwItoPxcoAXw+fMAAgA/ApwC9AXfAAIADQAACQEhAzMRMxUjFSM1ITUB3f7L",
  "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",
  "AAARMwMjx3WZBhL+iAAAAvzXBQ7/KQXZAAMABwAAATMVIyUzFSP+XsvL/nnLywXZy8vLAAAB/XME7v7wBfYAAwAAATMDI/43ueSZ",
  "Bfb++AAAAfy2BQ7/SgXpAB0AAAEnLgEjIgYdASM0NjMyFh8BHgEzMjY9ATMOASMiJv38ORkfDCQofWdWJD0wORciDyAofQJnVCI7",
  "BTkhDgsyLQZldhAbHg0MMykGZHcQAAAB/QwE7v6LBfYAAwAAARMjA/3HxJnmBfb++AEIAAAB/M8E7v8xBfgABgAAATMTIycHI/2i",
  "vNOLpqaLBfj+9rKyAAAB/M8E7v8xBfgABgAAAQMzFzczA/2i04umpovTBO4BCrKy/vYAAAH8xwUG/zkF+AANAAABMx4BMzI2NzMO",
  "ASMiJvzHdg1jU1JhEHYKoI+QnwX4Njk3OHd7egAB/ZoFDv5mBdsAAwAAATMVI/2azMwF280AAAL85gTu/7IF9gADAAcAAAEzAyMD",
  "MwMj/vm55JmLueSZBfb++AEI/vgAAAEAAAJQA1QAKwBoAAwAAQAAAAAAAAAAAAAAAAAIAAQAAAAAAAAAFgAqAGYAsgEAAU4BXAF5",
  "AZUBuwHUAeQB8QH9AgsCOwJSAoICvgLbAwsDSgNdA6UD4wP0BAoEHwQyBEYEfwT0BRAFRwV3BZ8FtwXMBgMGGwYoBj4GWQZpBocG",
  "nwbTBvYHMwdkB6EHtAfWB+sICwgqCEEIWAhqCHkIiwihCK4Ivgj2CSYJUgmCCbQJ1AoTCjUKRwpiCnwKiQq9Ct4LCgs6C2oLiQvE",
  "C+UMCQwdDDoMWgx5DJAMwgzQDQINMg0yDUkNhg2xDfsOKQ4+DpkOrA8bD1oPfA+MD5kQDxAcEEcQZxCREMsQ2RELESYRMhFTEWkR",
  "lhG6EcoR2hHqEiMSLxI7EkcSUxJfEpkSwRLNEtkS5RLxEv0TCRMVEyETLRNfE2sTdxODE48TmxOnE8kUFhQiFC4UOhRGFFIUdxS9",
  "FMgU0xTeFOkU9BT/FVsVZxVzFX8VixWXFaMVrxW7FccWDBYYFiMWLhY5FkQWTxZpFrEWvBbHFtIW3RboFxgXIxcvFzoXRhdRF10X",
  "aRd1F4EXjReZF6UXsRe9F8kX1RfhF+kYIhguGDoYRhhSGF4Yahh2GIIYjhiaGKYYsRi9GMkY1RjhGO0Y+RkFGREZNxliGW4ZehmG",
  "GZIZnhmqGbYZwhnOGd4Z6hn2GgIaDhoaGiYaQBpMGlgaZBpwGnwaiBqUGqAavRrWGuIa7Rr5GwUbERsdGykbVhuGG5IbnRupG7Qb",
  "wBvMG/4cUBxcHGcccxx/HIsclhyiHK0cuRzEHNAc2xznHPMc/h0JHRUdIR0/HWsddx2DHY8dmx2nHbMdvx3KHdYd4h3uHfoeBh4S",
  "Hh4eKR41HkEeTB5YHmQecB57HpYeoh6uHroexh7cHwgfEB8iHzUfTx91H5Ufwh/XH+Yf+yAJIBYgHiAmID4gVSBjIHEgeSCBIJog",
  "oiCuILogwiDKINgg5CDwIPghBSESIR8hKyE4IUQhUCFYIWAhbyGGIY4hliGeIdwh5CHsIf8iByIPIioiMiI6IkIiXSJlIm0iryK3",
  "IuojJyMzIz8jSiNVI2EjbSN4I7wj7yQOJFYknyTRJPUlMiVMJWglhyWPJbYl9CX8JiImVCaOJsAm3icNJ08nfiesJ9on5ifxJ/wo",
  "BygTKB8oKyhWKGIokSiZKKEoqSixKOMpESkzKT8pSylXKW8pdymfKacptiniKeoqFypTKmsqdyqUKrIquirCKsoq3SrlKu0q9SsX",
  "K1MrWytyK44rpivDK+0r+SwhLFAskyzALMgtDy1FLVQtfS2FLbAt6y4DLg8uKy5ILmYufi6GLpkuoS6pLrwuxC8XLx8vNi9VL20v",
  "ii+xL70v4TAMMEEwazB2MIIwtDDAMOsw8zD7MQMxCzE9MWsxljGhMawxtzHPMeEx8zIAMggyFTIiMi8yPDJIMlQyZTJ2MoYylzKy",
  "Ms0y5zMBMxkzPDNTM2IzbjOAM5g0BjQaNC80PTRZNKU07jUUNSs1QjVZNXA1fTWZNaY1wjXeNew2CDYYNiU2NjZHNlQ2ZDZ+Nqo2",
  "xTbSNu03GTczN0o3YTd0N4c3zDfZN+w3+jgoODc4SThcOHY4gziYAAAAAQAAAAJeuK25cXlfDzz1AB8IAAAAAADg+tE5AAAAAOD6",
  "0Tn31vxMDlkJ3AAAAAgAAgAAAAAAAATNAGYCiwAAAzUBNQOuAMUGtACeBRcAqgeaAHEGPQCBAjMAxQMfALADHwCkBAAAPQa0ANkC",
  "iwCeAuMAZAKLANsCsgAABRcAhwUXAOEFFwCWBRcAnAUXAGQFFwCeBRcAjwUXAKgFFwCLBRcAgQKyAPACsgCeBrQA2Qa0ANkGtADZ",
  "BD8AkwgAAIcFeQAQBX0AyQWWAHMGKQDJBQ4AyQSaAMkGMwBzBgQAyQJcAMkCXP+WBT8AyQR1AMkG5wDJBfwAyQZMAHME0wDJBkwA",
  "cwWPAMkFFACHBOP/+gXbALIFeQAQB+kARAV7AD0E4//8BXsAXAMfALACsgAAAx8Axwa0ANkEAP/sBAAAqgTnAHsFFAC6BGYAcQUU",
  "AHEE7ABxAtEALwUUAHEFEgC6AjkAwQI5/9sEogC6AjkAwQfLALoFEgC6BOUAcQUUALoFFABxA0oAugQrAG8DIwA3BRIArgS8AD0G",
  "iwBWBLwAOwS8AD0EMwBYBRcBAAKyAQQFFwEABrQA2QKLAAADNQE1BRcArAUXAIEFFwBeBRcAUgKyAQQEAABcBAAA1wgAARsDxQBz",
  "BOUAnga0ANkC4wBkCAABGwQAANUEAADDBrQA2QM1AF4DNQBiBAABcwUXAK4FFwCeAosA2wQAASMDNQCJA8UAYATlAMEHwQCJB8EA",
  "iQfBAGIEPwCPBXkAEAV5ABAFeQAQBXkAEAV5ABAFeQAQB8sACAWWAHMFDgDJBQ4AyQUOAMkFDgDJAlwAOwJcAKICXP/+AlwABgYz",
  "AAoF/ADJBkwAcwZMAHMGTABzBkwAcwZMAHMGtAEZBkwAZgXbALIF2wCyBdsAsgXbALIE4//8BNcAyQUKALoE5wB7BOcAewTnAHsE",
  "5wB7BOcAewTnAHsH2wB7BGYAcQTsAHEE7ABxBOwAcQTsAHECOf/HAjkAkAI5/94COf/0BOUAcQUSALoE5QBxBOUAcQTlAHEE5QBx",
  "BOUAcQa0ANkE5QBIBRIArgUSAK4FEgCuBRIArgS8AD0FFAC6BLwAPQV5ABAE5wB7BXkAEATnAHsFeQAQBOcAewWWAHMEZgBxBZYA",
  "cwRmAHEFlgBzBGYAcQWWAHMEZgBxBikAyQUUAHEGMwAKBRQAcQUOAMkE7ABxBQ4AyQTsAHEFDgDJBOwAcQUOAMkE7ABxBQ4AyQTs",
  "AHEGMwBzBRQAcQYzAHMFFABxBjMAcwUUAHEGMwBzBRQAcQYEAMkFEv/lB1QAyQWPAHgCXP/kAjn/0wJcAAMCOf/yAlz/9QI5/+QC",
  "XACwAjkAlgJcAMkCOQDBBLgAyQRyAMECXP+WAjn/2wU/AMkEogC6BKIAugR1AMkCOQDBBHUAyQI5AIgEdQDJAwAAwQR1AMkCvADB",
  "BH//8gJGAAIF/ADJBRIAugX8AMkFEgC6BfwAyQUSALoGggDNBfwAyQUSALoGTABzBOUAcQZMAHME5QBxBkwAcwTlAHEIjwBzCC8A",
  "cQWPAMkDSgC6BY8AyQNKAIIFjwDJA0oAugUUAIcEKwBvBRQAhwQrAG8FFACHBCsAbwUUAIcEKwBvBOP/+gMjADcE4//6AyMANwTj",
  "//oDIwA3BdsAsgUSAK4F2wCyBRIArgXbALIFEgCuBdsAsgUSAK4F2wCyBRIArgXbALIFEgCuB+kARAaLAFYE4//8BLwAPQTj//wF",
  "ewBcBDMAWAV7AFwEMwBYBXsAXAQzAFgC0QAvBRQAhwQrAG8E4//6AyMANwI5/9sEZQB/AosAsgQAAMEEAADBBAAAxwQAAO4EAAFM",
  "BAAAtgQAAPAAAP2iAAD8xQAA/h8AAP1qBTwAyQSLAMEG5QDJBS4AyQI6AKACOgCgBfwAyQUzALoEAAG2BGUAfwRmAHEEZQB/ArIA",
  "ngJc/5YEAAFzBAAA1wWKABACiwDbBfj/5wb4//MDRP/tBoD/8gaZ/+EGm//bArUABQV5ABAFfQDJBHUAyQV5ABAFDgDJBXsAXAYE",
  "AMkGTABzAlwAyQU/AMkFeQAQBucAyQX8AMkFDgDJBkwAcwYEAMkE0wDJBQ4AyQTj//oE4//8BkwAcwV7AD0GTABzBh0ATgJcAAYE",
  "4//8BUYAcQRTAIUFEgC6ArUApgShAJUFRgBxBRsAwAS8ACAE5QBxBFMAhQRaAGsFEgC6BOUAcQK1AKYEtwC/BLwAPQUXAK4EeABK",
  "BHYAawTlAHEE0QBKBRQAugSyAHEFEgBxBNEAZAShAJUFRwBwBJ8AOwVHAHAGswCHArUABQShAJUE5QBxBKEAlQazAIcFDgDJBQ4A",
  "yQZK//oE4QDJBZYAcwUUAIcCXADJAlwABgJc/5YIwABUCFwAyQZK//oFrgDJBfwAyQTgACMGBADJBXkAEAV9AMkFfQDJBOEAyQZA",
  "AGUFDgDJCJ4AKAUhAIcF/ADJBfwAyQWuAMkGBABUBucAyQYEAMkGTABzBgQAyQTTAMkFlgBzBOP/+gTgACMG4wB5BXsAPQY2AMkF",
  "fACvCI4AyQjAAMkGqQA8Bw8AyQV9AMkFlgBvCKMA0wWPAIgE5wB7BO8AcAS3ALoENAC6BYgAawTsAHEHNQBGBEEAhQUzALoFMwC6",
  "BNUAugUdAEwGCQC6BTsAugTlAHEFOwC6BRQAugRmAHEEqQA8BLwAPQbXAHAEvAA7BXIAugS6AJYHUgC6B4kAugWnAD4GUQC6BLcA",
  "ugRkAHEGvADBBNAAdATsAHEE7ABxBQAALwQ0ALoEZABxBCsAbwI5AMECOf/0Ajn/2wc4AEwHMAC6BTcALwTVALoFMwC6BLwAPQU7",
  "ALoE4QDJBDQAugLjAGQC4wBkBRcAZAQAAGQIAABkCAAAAAQAAQQEAP/sAosArgKLALICiwCuAosAsgQlAK4EJQCuBCUArgQlAK4E",
  "AAA5BAAAOQS4ATMEuAEzAq0A7AVXAOwIAADsCrwAcQMzAJ4DMwDBAVb+iQM1AD8FFwAACFIANggAAScGtABkBrQBowa0AHUGtAGj",
  "BrQA2QQAALAEAACwBAAAsAQAALAEAAKNBAAAsAQAALAEAACwBAAAsAQAALAEAAKNBAAAsAYAAqMGAACoBgACowYAAqMGAACoBgAC",
  "owYAAKgLeABkC3gAdQU8AMkEiwDBCDQAHgAA/7n81/1z/Lb9DPzP/M/8x/2a/OYAAAABAAAHbf4dAAAO/vfW+lEOWQABAAAAAAAA",
  "AAAAAAAAAAACRwABBA4BkAAFAAAFMwWZAAABHgUzBZkAAAPXAGYCEgAAAgsGAwMIBAICBIAAAo8AAABqAAAAIAAAAABQZkVkAEAA",
  "IP/9BhT+FAGaB20B4wAAAJ8AAAAAAAAAAAACAAAAAwAAABQAAwABAAAAFAAEALgAAAAqACAABAAKAH4BfwIbA3cDfwOKA4wDoQPO",
  "BF8EkSAmIDAgOiCsIRYhIiGTIhL//f//AAAAIACgAhgDcAN6A4QDjAOOA6MEAASQIBAgMCA5IKwhFiEiIZAiEv/9////4f/A/yj9",
  "4v3g/dz92/3a/dn9qP144frh8eHp4XrhEeEG4JngGwJIAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAHAFoAAwABBAkAAAEwAAAAAwABBAkAAQAWATAAAwABBAkAAgAIAUYAAwABBAkAAwAWATAAAwABBAkABAAWATAAAwABBAkA",
  "BQAYAU4AAwABBAkABgAUAWYAQwBvAHAAeQByAGkAZwBoAHQAIAAoAGMAKQAgADIAMAAwADMAIABiAHkAIABCAGkAdABzAHQAcgBl",
  "AGEAbQAsACAASQBuAGMALgAgAEEAbABsACAAUgBpAGcAaAB0AHMAIABSAGUAcwBlAHIAdgBlAGQALgAKAEMAbwBwAHkAcgBpAGcA",
  "aAB0ACAAKABjACkAIAAyADAAMAA2ACAAYgB5ACAAVABhAHYAbQBqAG8AbgBnACAAQgBhAGgALgAgAEEAbABsACAAUgBpAGcAaAB0",
  "AHMAIABSAGUAcwBlAHIAdgBlAGQALgAKAEQAZQBqAGEAVgB1ACAAYwBoAGEAbgBnAGUAcwAgAGEAcgBlACAAaQBuACAAcAB1AGIA",
  "bABpAGMAIABkAG8AbQBhAGkAbgAKAEQAZQBqAGEAVgB1ACAAUwBhAG4AcwBCAG8AbwBrAFYAZQByAHMAaQBvAG4AIAAyAC4AMwA3",
  "AEQAZQBqAGEAVgB1AFMAYQBuAHMAAwAAAAAAAP/YAFoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIACAAC//8AAwABAAAADAAAAAAA",
  "AAACAAQAAQFDAAEBUgIjAAECJgJCAAECRQJFAAEAAQAAAAoA4ADoAFAAPAwAB90AAAAAAoIAAARgAAAF1QAAAAAAAARgAAAAAAAA",
  "AAAAAAAAAAAEYAAAAAAAAAFoAAAEYAAAAFUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ4AAAJ2AAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABaAAABDgAAAFoAAABaAAABDgAAAAAAAAAAAAABDgAAAFoAAABaAAABDgAAAFoAAABa",
  "AAAAWgAAAXIAAABaAAAAWgAAAjgAAPuPAAAAPAAAAAAAAAAAACgAJAA4AAgABQBGAG4AlgC+AOYBIgFAAXwBmgG4AdYB9AIAAAEA",
  "CAAJAAoAPAA+AFwAXQBeAhAAAQAFAB4AQABvAikCKwAEAAAAAAAAAAMCMAAAACgJdQAAAi8AKAAoCY0AAQIuACgAAAmWAAAABAAA",
  "AAAAAAADAjMAAAAoCXUAAAIyACgAKAmNAAECMQAoAAAJlgAAAAQAAAAAAAAAAwI2AAAAKAl1AAACNQAoACgJjQABAjQAKAAACXEA",
  "AAAEAAAAAAAAAAMCOQAAACgJZgAAAjgAKAAoCX4AAQI3ACgAAAlxAAAABAAAAAAAAAAFAjwAAAAoCXIAAAI9ACgAKAmYAAECOwAo",
  "ACgJigAAAj0AKAAoCZgAAQI6ACgAAAmDAAAABAAAAAAAAAACAF0AAAAoCAAAAABdACgAAAgAAAEABAAAAAAAAAAFAkAAAAAoCXIA",
  "AAI9ACgAKAmYAAECPwAoACgJigAAAj0AKAAoCZgAAQI+ACgAAAmDAAAABAAAAAAAAAACAhAAAAAoCAAAAAIQACgAAAgAAAEABAAA",
  "AAAAAAACAB4AAAAoBQIAAAAeACgAAAUCAAEABAAAAAAAAAACAEAAAAAoBCgAAABAACgAAAQoAAEABAAAAAAAAAACAG8AAAAoAlYA",
  "AABvACgAAAJWAAEAAAACAikF3AJBCqAAAAACAisF3AJCCqA=",
];

// DejaVu Sans Bold, subset (Latin, Latin Extended-A, Greek, Cyrillic, punctuation), base64.
const FONT_BOLD: string[] = [
  "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",
  "ACsAeAAMAAEAAAAAAAAAAAAAAAAACAAEAAAAAAAAABkALQBpALoBBwFWAWQBgQGeAcQB3QHuAfwCCgIYAkgCYQKNAsoC6QMaA1kD",
  "bQO3A/UECgQiBDcESgReBJYFDAUqBWEFjwW8BdYF7QYhBjsGSQZiBn4GjwauBscG9wccB1EHgwfDB9cH+ggPCDEIUghqCIIIlQik",
  "CLcIzQjaCOoJJQlWCYMJtAnnCggKSQpyCocKpArACs4LCAswC14LjwvAC+AMHgxBDGsMgAyfDL4M3gz2DSgNNg1oDZgNmA2yDfEO",
  "Hg5oDpcOrA8JDxsPig/JD+kP+RAHEH4QixC6ENoRAxE9EUwRfxGaEagRyRHfEg0SLxI/Ek8SXxKXEqMSrxK7EscS0xMOEzgTRBNQ",
  "E1wTaBN0E4ATjBOYE6QT2xPnE/MT/xQLFBcUIxRFFI8UmxSnFLMUvxTLFPMVPBVIFVQVYBVsFXgVhBXjFe8V+xYHFhMWHxYrFjcW",
  "QxZPFpYWohauFroWxhbSFt4W+hdDF08XWxdnF3MXfxewF7wXyBfUF+AX7Bf4GAQYEBgcGCgYNBhAGEwYWBhkGHAYfBiEGL4YyhjW",
  "GOIY7hj6GQYZEhkeGSoZNhlCGU4ZWhlmGXIZfhmKGZYZohmuGdYaCBoUGiAaLBo4GkQaUBpbGmYachqAGowamBqkGrAavBrIGuQa",
  "8Br8GwgbFBsgGywbOBtEG2IbfBuIG5MbnxurG7cbwxvPG/8cOBxEHFAcXBxoHHQcgBy5HQ0dGR0kHTAdPB1IHVMdXx1qHXYdgR2N",
  "HZgdpB2wHbwdxx3THd8d/R4sHjgeRB5QHlweaB50HoAejB6YHqQesB68Hsge1B7gHuwe+B8EHw8fGx8nHzMfPh9aH2Yfch9+H4of",
  "oB/LH9Mf5R/5IBMgOSBZIIggniCsILUgwyDRINkg4SD7IRQhIiEwITghQCFTIVshZyFzIXshgyGSIZ4hqiGyIb8hzCHZIeUh8iH+",
  "IgoiEiIaIiIiOCJAIkgiUCKIIpAimCKuIrYiviLbIuMi6yLzIxAjGCMgI2QjbCOZI9Ij3iPqI/YkASQNJBkkJSRkJK8k1SUbJWQl",
  "kCW5JfQmEiYwJlAmWCZ9JrcmvyboJx8nUCeAJ6Qn0igKKDsoYSiWKKIorii5KMUo0SjdKOkpIikuKVspYylrKXMpeymwKeEqDyob",
  "KicqMypMKlQqgSqJKpkqwSrJKvYrNCtNK1krdyuTK5sroyurK78rxyvPK9cr+iw5LEEsWix3LJEssSzZLOUtDy06LXYtoS2pLfIu",
  "Ji41LlwuZC6RLsIu2y7nLwUvIy9AL1ovYi92L34vhi+ZL6Ev7y/3MBEwLTBHMGYwijCWML8w6jEjMU0xWTFlMZcxozHQMdgx4DHo",
  "MfAyJDJRMn0yiTKVMqEyuzLOMuAy7jL2MwQzEjMgMy0zOTNFM1czaDN5M4szqDPFM+Iz/jQXNDs0ZDRzNIE0lzS1NSM1NjVKNVc1",
  "czXBNgk2LjZFNlw2czaKNpc2qza+Nv03CzceNy03YjdxN4M3ljewN7431QABAAAAAl643Wh5NV8PPPUAHwgAAAAAAOD60TkAAAAA",
  "4PrROfdy/K4PzQlnAAEACAACAAAAAAAABM0AZgLJAAADpgEfBCsAwwa0AIsFkQCgCAQAQgb6AHsCcwDDA6gAsAOoAKQELwApBrQA",
  "2QMKAG0DUgBvAwoA0QLsAAAFkQBiBZEA5wWRAKIFkQCJBZEAXAWRAJ4FkQB/BZEAiQWRAH0FkQBqAzMA5QMzAIEGtADZBrQA2Qa0",
  "ANkEpACNCAAAhwYxAAoGGQC8Bd8AZgakALwFdwC8BXcAvAaRAGYGsgC8AvoAvAL6/40GMwC8BRkAvAf2ALwGsgC8Bs0AZgXdALwG",
  "zQBmBikAvAXDAJMFdQAKBn8AvAYxAAoI0wA9BisAJwXL/+wFzQBcA6gAsALsAAADqACLBrQAzwQAAAAEAABeBWYAWAW6AKwEvgBY",
  "BboAXAVtAFgDewAnBboAXAWyAKwCvgCsAr7/vAVSAKwCvgCsCFYAqgWyAKwFfwBYBboArAW6AFwD8gCsBMMAagPTABsFsgCgBTcA",
  "HwdkAEgFKQAfBTcAGQSoAFwFsgEAAuwBBAWyAQAGtADZAskAAAOmAR8FkQCuBZEAfQUXAEoFkQAZAuwBBAQAAA4EAADFCAABGwSD",
  "AJ4FKwCeBrQA2QNSAG8IAAEbBAAAxQQAALIGtADZA4EAbQOBAFoEAAFtBeMArgUXAIEDCgDRBAABBgOBAHsEgwB1BSsAwQhIAGQI",
  "SABkCEgAaASkAI0GMQAKBjEACgYxAAoGMQAKBjEACgYxAAoIrgAABd8AZgV3ALwFdwC8BXcAvAV3ALwC+gAWAvoAvAL6AAMC+gBB",
  "BrQAIQayALwGzQBmBs0AZgbNAGYGzQBmBs0AZga0AQAGzQAtBn8AvAZ/ALwGfwC8Bn8AvAXL/+wF5wC8BcEArAVmAFgFZgBYBWYA",
  "WAVmAFgFZgBYBWYAWAhiAFgEvgBYBW0AWAVtAFgFbQBYBW0AWAK+/9UCvgCsAr7/5QK+ACMFfwBYBbIArAV/AFgFfwBYBX8AWAV/",
  "AFgFfwBYBrQA2QV/AE4FsgCgBbIAoAWyAKAFsgCgBTcAGQW6AKwFNwAZBjEACgVmAFgGMQAKBWYAWAYxAAoFZgBYBd8AZgS+AFgF",
  "3wBmBL4AWAXfAGYEvgBYBd8AZgS+AFgGpAC8BboAXAa0ACEFugBcBXcAvAVtAFgFdwC8BW0AWAV3ALwFbQBYBXcAvAVtAFgFdwC8",
  "BW0AWAaRAGYFugBcBpEAZgW6AFwGkQBmBboAXAaRAGYFugBcBrIAvAWy/+0HygC8BlIApgL6ACACvgADAvoAQQK+ACQC+gAsAr4A",
  "DwL6ALwCvgCsAvoAvAK+AKwF9AC8BXwArAL6/40Cvv+8BjMAvAVSAKwFUgCsBRkAvAK+AKwFGQC8Ar4AkQUZALwD1gCsBRkAvAR0",
  "AKwFI/+kAvj/2wayALwFsgCsBrIAvAWyAKwGsgC8BbIArAfdAGkGsgCsBbIArAbNAGYFfwBYBs0AZgV/AFgGzQBmBX8AWAlWAGYI",
  "wQBYBikAvAPyAKwGKQC8A/IAkQYpALwD8gCsBcMAkwTDAGoFwwCTBMMAagXDAJMEwwBqBcMAkwTDAGoFdQAKA9MAGwV1AAoD0wAb",
  "BXUACgPTABsGfwC8BbIAoAZ/ALwFsgCgBn8AvAWyAKAGfwC8BbIAoAZ/ALwFsgCgBn8AvAWyAKAI0wA9B2QASAXL/+wFNwAZBcv/",
  "7AXNAFwEqABcBc0AXASoAFwFzQBcBKgAXAN7ACcFwwCTBMMAagV1AAoD0wAbAr7/vAS+AFgDCgCBBAAAhwQAAIcEAACwBAAA4wQA",
  "AVYEAACkBAAAwQAA/UsAAPyFAAD91AAA/WIFlQC8BIUArAgtALwGsAC8AmoAoAJqAKAGsgC8BZsArAQAAZ4EvgBYBGYAWARlAFgD",
  "MwCBAvr/jQOIAVsEAADFBmEANQMKANEGxP/PCBL/2wSC/9UHIP/aB9f/yQcn/8MDHgAvBjEACgYZALwFGQC8BjEACgV3ALwFzQBc",
  "BrIAvAbNAGYC+gC8BjMAvAYxAAoH9gC8BrIAvAUOAMkGzQBmBrIAvAXdALwFdwC8BXUACgXL/+wGzQBmBisAJwbMAHMGzQA3AvoA",
  "RgXL/+wFfwBjBHQAbgWyAKwDHgCeBWcAnwV/AGMFugCsBXMAHwV/AFkEdABuBLoAWQWyAKwFfwBYAx4AoAWvAKwFEAA9BeMArgVz",
  "AB8EugBZBX8AWAZUAFYFugCsBL4AWAY7AFgFGwArBWcAnwZCAIQFKQA0BloAhQb0AFgDHgAnBWcAnwV/AFgFZwCfBvQAWAV3ALwF",
  "dwC8BwcACgUZALwF3wBmBcMAkwL6ALwC+gBBAvr/jQk8AF4JCgC8BwcACgaKALwGsgC8BisAOwayALwGMQAKBhkAvAYZALwFGQC8",
  "ByAAewV3ALwJywAeBa8AhwayALwGsgC8BooAvAalAF4H9gC8BrIAvAbNAGYGsgC8Bd0AvAXfAGYFdQAKBisAOwfvAGYGKwAnB2wA",
  "vAZ3AKUJ4gC8CpsAvAeEAGQISgC8BhkAvAXfAIMJZAC8BikAgwVmAFgFlgBYBRAArAQuAKwGdgBzBW0AWAf2AB4EpgBkBZsArAWb",
  "AKwFbgCsBdwAcQaKAKwFhwCsBX8AWAWHAKwFugCsBL4AWASjAAgFNwAZB/AAcQUpAB8F7gCsBX4AhAh/AKwI2ACsBgMAKAc8AKwF",
  "DwCsBL4AiQfHAKwFIwA/BW0AWAVtAFgFtgAoBC4ArAS+AFgEwwBqAr4ArAK+ACMCvv+8B+4AWgemAKwF4AAoBW4ArAWbAKwFNwAZ",
  "BYcArAUZALwELgCsA1IAbwNSAG8FkQBuBAAAbggAAG4IAAAABAABBAQAAAADCgDTAwoAgQMKAJMDCgCBBUIA0wVCALwFQgCTBUIA",
  "vAQAADUEAAAzBR0BJwUdAScCqgCiBVYAoggAAKILhQBCA0wAngNMAMEBVv5oA4EAOAWR/9kJoABFCAABJwa0AGQGtAGMBrQAdQa0",
  "AYwGtADZBZUAvASFAKwI6AAyAAD9bfzF/W38pPyy/If8h/yw/Xf8oAAAAAEAAAdt/h0AABAh93L5Mg/NAAEAAAAAAAAAAAAAAAAA",
  "AAIyAAEElQK8AAUAAAUzBZkAAAEeBTMFmQAAA9cAZgISAAACCwgDAwYEAgIEgAACjwAAAGoAAAAgAAAAAFBmRWQAIAAg//0GFP4U",
  "AZoHbQHjAAAAnwAAAAAAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAuAAAACoAIAAEAAoAfgF/AhsDdwN/A4oDjAOhA84EXwSRICYg",
  "MCA6IKwhFiEiIZMiEv/9//8AAAAgAKACGANwA3oDhAOMA44DowQABJAgECAwIDkgrCEWISIhkCIS//3////h/8D/KP3i/eD93P3b",
  "/dr92f2o/Xjh+uHx4enheuER4QbgmeAbAjMAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcA",
  "WgADAAEECQAAATAAAAADAAEECQABABYBMAADAAEECQACAAgBRgADAAEECQADACABTgADAAEECQAEACABTgADAAEECQAFABgBbgAD",
  "AAEECQAGAB4BhgBDAG8AcAB5AHIAaQBnAGgAdAAgACgAYwApACAAMgAwADAAMwAgAGIAeQAgAEIAaQB0AHMAdAByAGUAYQBtACwA",
  "IABJAG4AYwAuACAAQQBsAGwAIABSAGkAZwBoAHQAcwAgAFIAZQBzAGUAcgB2AGUAZAAuAAoAQwBvAHAAeQByAGkAZwBoAHQAIAAo",
  "AGMAKQAgADIAMAAwADYAIABiAHkAIABUAGEAdgBtAGoAbwBuAGcAIABCAGEAaAAuACAAQQBsAGwAIABSAGkAZwBoAHQAcwAgAFIA",
  "ZQBzAGUAcgB2AGUAZAAuAAoARABlAGoAYQBWAHUAIABjAGgAYQBuAGcAZQBzACAAYQByAGUAIABpAG4AIABwAHUAYgBsAGkAYwAg",
  "AGQAbwBtAGEAaQBuAAoARABlAGoAYQBWAHUAIABTAGEAbgBzAEIAbwBsAGQARABlAGoAYQBWAHUAIABTAGEAbgBzACAAQgBvAGwA",
  "ZABWAGUAcgBzAGkAbwBuACAAMgAuADMANwBEAGUAagBhAFYAdQBTAGEAbgBzAC0AQgBvAGwAZAAAAAMAAAAAAAD/2ABaAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAACAAgAAv//AAMAAQAAAAwAAAAAAAAAAgAEAAEBQwABAVICIwABAiYCLQABAjACMAAB",
];
