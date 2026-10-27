/**
 * A small .xlsx writer and reader for the translation files on the shop PC (update 45): no library, runs in the
 * browser and in Deno (the tests). Written files: every cell text (the "@" format, also for new cells), a bold frozen
 * header row with a filter, column widths, hidden sheets ("veryHidden": not even listed in Excel's "Unhide").
 * Read back: whatever Excel or LibreOffice saved (shared strings, inline strings, numbers, rich text, _xHHHH_ escapes).
 */

export interface SheetIn {
  name: string;
  rows: string[][];
  /** Bold, frozen first row with a filter over the data. */
  header?: boolean;
  /** Character widths of the columns. */
  widths?: number[];
  hidden?: boolean;
}

export interface SheetOut {
  name: string;
  hidden: boolean;
  rows: string[][];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    return await through(data, new CompressionStream("deflate-raw" as CompressionFormat));
  } catch {
    return null; // a browser without "deflate-raw": the file is stored as it is
  }
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  return through(data, new DecompressionStream("deflate-raw" as CompressionFormat));
}

/** A zip archive of the entries (deflated when the browser can, else stored). */
export async function zip(entries: { name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // 2026-01-01 00:00 in DOS time: the files' own times are not needed
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const packed = await deflate(entry.data);
    const method = packed && packed.length < entry.data.length ? 8 : 0;
    const body = method === 8 ? packed! : entry.data;
    const crc = crc32(entry.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, method, true);
    dir.setUint16(12, dosTime, true);
    dir.setUint16(14, dosDate, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, entry.data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const dirSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The entries of a zip archive (stored or deflated). */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not_xlsx");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("not_xlsx");
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, body);
    else if (method === 8) out.set(name, await inflate(body));
    else throw new Error("not_xlsx");
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

// ---------------------------------------------------------------- write

/** Text as XML (characters XML cannot hold are dropped; Excel's 32 767 characters per cell). */
export function xmlText(value: string): string {
  return value
    .slice(0, 32_767)
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "A", "B", …, "Z", "AA" for a column index (0 = A). */
export function columnName(index: number): string {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function columnIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// 0 = default, 1 = text ("@"), 2 = text + bold (the header)
const STYLES =
  `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

function sheetXml(sheet: SheetIn, selected: boolean): string {
  const width = Math.max(1, ...sheet.rows.map((r) => r.length));
  const last = columnName(width - 1);
  const view = sheet.header
    ? `<sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ""}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>`
    : `<sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ""}/>`;
  const cols = Array.from({ length: width }, (_, i) => {
    const w = Math.min(80, Math.max(6, sheet.widths?.[i] ?? 14));
    return `<col min="${i + 1}" max="${i + 1}" width="${w}" style="1" customWidth="1"/>`;
  }).join("");
  const rows = sheet.rows
    .map((row, r) => {
      const style = sheet.header && r === 0 ? 2 : 1;
      const cells = row
        .map((value, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          if (value === "") return `<c r="${ref}" s="${style}"/>`;
          const space = /^\s|\s$|\n/.test(value) ? ' xml:space="preserve"' : "";
          return `<c r="${ref}" s="${style}" t="inlineStr"><is><t${space}>${xmlText(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const filter = sheet.header && sheet.rows.length ? `<autoFilter ref="A1:${last}${sheet.rows.length}"/>` : "";
  return (
    `${XML_HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<sheetViews>${view}</sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols>` +
    `<sheetData>${rows}</sheetData>${filter}</worksheet>`
  );
}

const quoteSheet = (name: string) => `'${name.replace(/'/g, "''")}'`;

/** An .xlsx workbook of the sheets (the first one is opened). */
export async function writeXlsx(sheets: SheetIn[]): Promise<Uint8Array> {
  const entries: { name: string; data: Uint8Array }[] = [];
  const add = (name: string, text: string) => entries.push({ name, data: enc.encode(text) });
  add(
    "[Content_Types].xml",
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("") +
      "</Types>",
  );
  add(
    "_rels/.rels",
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>",
  );
  const filters = sheets
    .map((s, i) => {
      if (!s.header || !s.rows.length) return "";
      const width = Math.max(1, ...s.rows.map((r) => r.length));
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlText(quoteSheet(s.name))}!$A$1:$${columnName(width - 1)}$${s.rows.length}</definedName>`;
    })
    .join("");
  add(
    "xl/workbook.xml",
    `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>` +
      sheets
        .map((s, i) => `<sheet name="${xmlText(s.name.slice(0, 31))}" sheetId="${i + 1}"${s.hidden ? ' state="veryHidden"' : ""} r:id="rId${i + 1}"/>`)
        .join("") +
      `</sheets>${filters ? `<definedNames>${filters}</definedNames>` : ""}</workbook>`,
  );
  add(
    "xl/_rels/workbook.xml.rels",
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      "</Relationships>",
  );
  add("xl/styles.xml", STYLES);
  sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s, i === 0)));
  return zip(entries);
}

// ---------------------------------------------------------------- read

function unescapeXml(text: string): string {
  return text
    .replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-fA-F]+));/g, (all, name: string, dec: string, hex: string) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" } as Record<string, string>)[name] ?? all;
    })
    .replace(/_x([0-9a-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

/** The text of a string item: its <t> parts (rich text runs too), never the phonetic hints. */
function stringItem(xml: string): string {
  return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)]
    .map((m) => unescapeXml(m[1] ?? ""))
    .join("");
}

/** A number cell as text, without an exponent (an EAN typed as a number stays its digits). */
function numberText(v: string): string {
  if (!/e/i.test(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : v;
}

function readSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  let nextRow = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attributes(rm[1]);
    const r = ra.r ? Number(ra.r) - 1 : nextRow;
    nextRow = r + 1;
    const row: string[] = [];
    let nextCol = 0;
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attributes(cm[1]);
      const c = ca.r ? columnIndex(ca.r.replace(/\d+$/, "")) : nextCol;
      nextCol = c + 1;
      const body = cm[2] ?? "";
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = "";
      if (ca.t === "s") value = v !== undefined ? (shared[Number(v)] ?? "") : "";
      else if (ca.t === "inlineStr") value = stringItem(body.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? "");
      else if (ca.t === "str" || ca.t === "e") value = v !== undefined ? unescapeXml(v) : "";
      else if (ca.t === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
      else value = v !== undefined ? numberText(unescapeXml(v)) : "";
      while (row.length < c) row.push("");
      row[c] = value;
    }
    while (rows.length < r) rows.push([]);
    rows[r] = row;
  }
  return rows;
}

/** The sheets of an .xlsx file in the workbook's order (hidden ones marked). */
export async function readXlsx(bytes: Uint8Array): Promise<SheetOut[]> {
  const files = await unzip(bytes);
  const text = (name: string) => {
    const f = files.get(name);
    return f ? dec.decode(f) : null;
  };
  const workbook = text("xl/workbook.xml");
  if (!workbook) throw new Error("not_xlsx");
  const rels = new Map<string, string>();
  for (const m of (text("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const a = attributes(m[1]);
    if (a.Id && a.Target) rels.set(a.Id, a.Target);
  }
  const shared = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => stringItem(m[1] ?? ""));
  const out: SheetOut[] = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const a = attributes(m[1]);
    const id = a["r:id"] ?? Object.entries(a).find(([k]) => k.endsWith(":id"))?.[1];
    const target = id ? rels.get(id) : undefined;
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const xml = text(path);
    if (xml === null) continue;
    out.push({ name: a.name ?? "", hidden: a.state === "hidden" || a.state === "veryHidden", rows: readSheet(xml, shared) });
  }
  return out;
}
