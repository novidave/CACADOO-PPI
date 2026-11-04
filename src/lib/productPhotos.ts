/**
 * Product photos (database update 78, 2026-11-04): ONE photo per product, shown only on that product's page. These are
 * the rules shared by the owner's screens, the product page and the tests (no imports; `productPhotos_test.ts`):
 * the photo's address in the public bucket, the bulk files (CSV and XML) read in the owner's browser — the same
 * rule as the stock importer for XML (the largest list of repeated elements is the product list; attributes and
 * child elements are its columns) — and the downloadable report. The database decides which product a row is
 * (owner_product_photo_job: the code, then the EAN) and the Edge Function downloads the images.
 */

export const PHOTO_BUCKET = "product-photos";
/** Rows of one bulk file at most (the database refuses more). */
export const MAX_PHOTO_ROWS = 5000;
/** A picture the owner picks at most (the browser draws it smaller; a downloaded image has the same limit). */
export const MAX_PHOTO_FILE_BYTES = 15 * 1024 * 1024;
/** A bulk file at most (5000 rows are far less). */
export const MAX_PHOTO_LIST_BYTES = 5 * 1024 * 1024;

/** The public address of a stored picture (the path is random and changes with every new photo: no cache problem). */
export function productPhotoUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${PHOTO_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export interface PhotoRow {
  code: string | null;
  ean: string | null;
  url: string | null;
}

export interface PhotoFile {
  kind: "csv" | "xml";
  rows: PhotoRow[];
  /** The columns found (their names as the file writes them). */
  columns: { code: string | null; ean: string | null; url: string };
  /** More rows than one file may hold: only the first MAX_PHOTO_ROWS are kept. */
  cut: boolean;
}

export type PhotoFileProblem = "empty" | "no_key" | "no_url" | "not_xml";

/** A column name to compare: lower case, without accents, a namespace ("g:") or anything but letters and digits. */
export function columnKey(name: string): string {
  const norm = (s: string) =>
    s
      .replace(/^@/, "")
      .replace(/^[a-z]+:/i, "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const parts = name.split("/");
  const last = norm(parts.pop() ?? name);
  // <image url="…"/>, <foto><src>…</src></foto>: the address of an image-like element is that element's address
  // (a lone "url" is a product's page in most feeds, never its picture)
  const parent = parts.length ? norm(parts[parts.length - 1]) : "";
  if (["url", "src", "href", "link"].includes(last) && IMAGE_PARENTS.includes(parent)) return `${parent}url`;
  return last;
}

const IMAGE_PARENTS = ["image", "img", "picture", "photo", "foto", "fotka", "obrazok", "obrazek", "kep", "mainimage"];

const CODE_NAMES = ["code", "kod", "productcode", "kodproduktu", "kodtovaru", "sku", "itemid", "productno", "productnumber", "catalognumber", "katalogovecislo", "plu", "cislo", "id", "number", "cikkszam", "termekkod"];
const EAN_NAMES = ["ean", "ean13", "eancode", "eankod", "gtin", "gtin13", "barcode", "ciarovykod", "vonalkod"];
const URL_NAMES = ["imageurl", "imgurl", "image", "imagelink", "img", "picture", "pictureurl", "photo", "photourl", "foto", "fotourl", "fotka", "fotkaurl", "obrazok", "obrazokurl", "obrazek", "obrazekurl", "kep", "kepurl", "mainimage", "mainimageurl", "thumbnail"];

/**
 * The best column for each of code, EAN and image address (the first name of each list wins): the normalised key
 * (columnKey) and the name as the file writes it first. An attribute and a child element with the same name are one
 * column (<product code="…"> and <product><code>…</code></product> in one file).
 */
export function findColumns(names: string[]): Record<"code" | "ean" | "url", { key: string; name: string } | null> {
  const keys = new Map<string, string>();
  for (const n of names) {
    const k = columnKey(n);
    if (k && !keys.has(k)) keys.set(k, n);
  }
  const pick = (wanted: string[]) => {
    for (const w of wanted) if (keys.has(w)) return { key: w, name: keys.get(w)! };
    return null;
  };
  return { code: pick(CODE_NAMES), ean: pick(EAN_NAMES), url: pick(URL_NAMES) };
}

function toRows(records: Record<string, string>[], kind: "csv" | "xml"): PhotoFile | PhotoFileProblem {
  if (!records.length) return "empty";
  const names = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const columns = findColumns(names);
  if (!columns.url) return "no_url";
  if (!columns.code && !columns.ean) return "no_key";
  // a record's value of a column: the first non-empty field whose name means that column
  const value = (r: Record<string, string>, c: { key: string } | null) => {
    if (!c) return null;
    for (const [name, v] of Object.entries(r)) if (columnKey(name) === c.key && v.trim()) return v.trim();
    return null;
  };
  const all = records
    .map((r) => ({ code: value(r, columns.code), ean: value(r, columns.ean), url: value(r, columns.url) }))
    // a line without a key and without an address is no row (an empty line at the end, a sub-total)
    .filter((r) => r.code || r.ean || r.url);
  if (!all.length) return "empty";
  return {
    kind,
    rows: all.slice(0, MAX_PHOTO_ROWS),
    columns: { code: columns.code?.name ?? null, ean: columns.ean?.name ?? null, url: columns.url.name },
    cut: all.length > MAX_PHOTO_ROWS,
  };
}

// ---------------------------------------------------------------- CSV

/** CSV with ; , tab or | between fields (guessed from the first line), "quoted" fields, a byte order mark. */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [";", ",", "\t", "|"].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && clean[i + 1] === "\n") i++;
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
  const headers = nonEmpty[0].map((h, i) => h.trim() || `column ${i + 1}`);
  return nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
}

export function readPhotoCsv(text: string): PhotoFile | PhotoFileProblem {
  return toRows(parseCsvRecords(text), "csv");
}

// ---------------------------------------------------------------- XML

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * A small XML reader (elements, attributes, text, CDATA; comments, declarations and processing instructions are
 * skipped). Never fetches anything (no DTD, no entities beyond the five standard ones and numeric ones).
 */
export function parseXmlTree(text: string): XmlNode | null {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/\s*([^\s>]+)\s*>|<\s*([^\s/>]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = tag.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      // a closing tag: up to its element (a missing closing tag of a child is forgiven)
      const at = stack.map((n) => n.name).lastIndexOf(m[2]);
      if (at > 0) stack.length = at;
    } else if (m[3]) {
      any = true;
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
      }
      const node: XmlNode = { name: m[3], attrs, children: [], text: "" };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decodeEntities(m[6]);
  }
  return any ? root : null;
}

/** One record's columns: attributes as "@name", child elements' text by their path ("image/url"), the first of each. */
function flatten(node: XmlNode, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(node.attrs)) {
    const key = prefix ? `${prefix}/@${k}` : `@${k}`;
    if (!(key in out)) out[key] = v.trim();
  }
  for (const child of node.children) {
    const key = prefix ? `${prefix}/${child.name}` : child.name;
    const hasAttrs = Object.keys(child.attrs).length > 0;
    if (child.children.length || hasAttrs) flatten(child, key, out);
    // a leaf's text (an element with only attributes, <foto url="…"/>, has none of its own)
    if (!child.children.length && !(key in out) && (!hasAttrs || child.text.trim())) out[key] = child.text.trim();
  }
  return out;
}

/** The product list: the largest list of elements with the same name under one parent (the stock importer's rule). */
export function xmlRecords(text: string): Record<string, string>[] | null {
  const root = parseXmlTree(text);
  if (!root) return null;
  let best: XmlNode[] = [];
  const visit = (node: XmlNode) => {
    const groups = new Map<string, XmlNode[]>();
    for (const c of node.children) groups.set(c.name, [...(groups.get(c.name) ?? []), c]);
    for (const list of groups.values()) {
      const records = list.filter((n) => n.children.length || Object.keys(n.attrs).length);
      if (records.length > best.length) best = records;
    }
    node.children.forEach(visit);
  };
  visit(root);
  // a file with one product: its deepest element that holds only values
  if (!best.length) {
    const deepest = (n: XmlNode): XmlNode | null => {
      if (n.children.length && n.children.every((c) => !c.children.length)) return n;
      for (const c of n.children) {
        const found = deepest(c);
        if (found) return found;
      }
      return null;
    };
    const one = deepest(root);
    if (one) best = [one];
  }
  return best.map((n) => flatten(n));
}

export function readPhotoXml(text: string): PhotoFile | PhotoFileProblem {
  const records = xmlRecords(text.replace(/^﻿/, ""));
  if (!records) return "not_xml";
  return toRows(records, "xml");
}

/** A CSV or an XML file by its content (an XML file starts with "<"). */
export function readPhotoFile(text: string): PhotoFile | PhotoFileProblem {
  return text.replace(/^﻿/, "").trimStart().startsWith("<") ? readPhotoXml(text) : readPhotoCsv(text);
}

/** Whether an image_url is one the function will try (the database decides again): https, no spaces, ≤ 2000. */
export function photoUrlOk(url: string | null): boolean {
  return Boolean(url && url.length <= 2000 && /^https:\/\/[^\s/?#]+/.test(url) && !/\s/.test(url));
}

// ---------------------------------------------------------------- the report

export const PHOTO_ROW_STATUSES = ["pending", "working", "done", "unchanged", "empty", "not_found", "bad_url", "bad_image", "too_big", "failed"] as const;
export type PhotoRowStatus = (typeof PHOTO_ROW_STATUSES)[number];

export interface ReportRow {
  n: number;
  code: string | null;
  ean: string | null;
  url: string | null;
  status: PhotoRowStatus;
  detail: string | null;
}

/** A cell a spreadsheet would read as a formula is written as text ('=…), as in the conversation exports. */
const cell = (v: string | number | null) => {
  let s = v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The report as CSV for Excel: a byte order mark, ";" between fields, CRLF, one line per row of the file. */
export function reportCsv(rows: ReportRow[], labels: { header: [string, string, string, string, string, string]; status: Record<PhotoRowStatus, string> }): string {
  const lines = [labels.header.map(cell).join(";")];
  for (const r of rows) lines.push([r.n, r.code, r.ean, r.url, labels.status[r.status] ?? r.status, r.detail].map(cell).join(";"));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Rows per result for the report's summary (in the order of PHOTO_ROW_STATUSES, only the ones that occur). */
export function statusCounts(rows: { status: PhotoRowStatus }[]): { status: PhotoRowStatus; n: number }[] {
  const counts = new Map<PhotoRowStatus, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return PHOTO_ROW_STATUSES.filter((s) => counts.has(s)).map((s) => ({ status: s, n: counts.get(s)! }));
}
