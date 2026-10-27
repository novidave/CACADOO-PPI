import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { unzipSync } from "fflate";
import readXlsxFile from "read-excel-file/node";
import {
  fields,
  privateColumn,
  MAX_BYTES,
  type Config,
  type Row,
  type Batch,
} from "./model";
export function numberValue(raw: string): number | null {
  let s = raw.trim().replace(/[\s\u00a0]/g, "");
  if (!/^[+-]?[\d.,]+$/.test(s)) return null;
  if (s.includes(",") && s.includes(".")) {
    const decimal = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    s = s.replace(decimal === "," ? /\./g : /,/g, "").replace(",", ".");
  } else s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
export function csvRows(text: string): Row[] {
  const first = text.replace(/^\uFEFF/, "").split(/\r?\n/)[0];
  const delimiter = [";", ",", "\t", "|"].sort(
    (a, b) => first.split(b).length - first.split(a).length,
  )[0];
  return parse(text, {
    columns: (headers: string[]) => {
      if (new Set(headers).size !== headers.length)
        throw Error("DUPLICATE_HEADERS");
      return headers;
    },
    delimiter,
    bom: true,
    skip_empty_lines: true,
    max_record_size: 1024 * 1024,
  });
}
export async function parseFile(bytes: Buffer, name: string): Promise<Row[]> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw Error("FILE_SIZE");
  if (/\.xlsx$/i.test(name)) {
    let expanded = 0;
    unzipSync(bytes, {
      filter: (entry) => {
        expanded += entry.originalSize;
        if (expanded > MAX_BYTES || entry.originalSize > MAX_BYTES)
          throw Error("FILE_SIZE");
        return true;
      },
    });
    const rows = await readXlsxFile(bytes, {
      parseNumber: (value) => value,
      trim: false,
    });
    const headers = (rows.shift() ?? []).map(String);
    if (new Set(headers).size !== headers.length)
      throw Error("DUPLICATE_HEADERS");
    return rows.map((row) =>
      Object.fromEntries(
        headers.map((key, i) => [key, row[i] == null ? "" : String(row[i])]),
      ),
    );
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/\.xml$/i.test(name)) {
    if (
      /<!DOCTYPE|<!ENTITY/i.test(text) ||
      XMLValidator.validate(text) !== true
    )
      throw Error("XML_INVALID");
    const tree = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
    }).parse(text);
    // A single unambiguous repeated scalar record list; never guess between inventories.
    const lists: unknown[][] = [];
    const visit = (v: unknown) => {
      if (Array.isArray(v)) {
        if (
          v.every(
            (x) =>
              x &&
              typeof x === "object" &&
              !Array.isArray(x) &&
              Object.values(x).every((y) => typeof y !== "object"),
          )
        )
          lists.push(v);
        else v.forEach(visit);
      } else if (v && typeof v === "object") Object.values(v).forEach(visit);
    };
    visit(tree);
    if (lists.length !== 1) throw Error("XML_RECORDS_AMBIGUOUS");
    return lists[0].map((row) =>
      Object.fromEntries(
        Object.entries(row as object).map(([k, v]) => [k, String(v ?? "")]),
      ),
    );
  }
  if (!/\.(csv|txt)$/i.test(name)) throw Error("UNSUPPORTED_FORMAT");
  return csvRows(text);
}
const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"';
export function snapshot(
  rows: Row[],
  config: Config,
  sourceTimestamp: string,
  generation: number,
  now = Date.now(),
): Batch {
  const time = Date.parse(sourceTimestamp);
  if (
    !Number.isFinite(time) ||
    time > now + 60000 ||
    time < now - 24 * 60 * 60 * 1000
  )
    throw Error("SOURCE_TIME");
  if (rows.length !== config.expectedRows || rows.length > 100000)
    throw Error("INCOMPLETE_SNAPSHOT");
  const keys = fields.filter((f) => config.mapping[f]);
  const mapped = keys.map((f) => config.mapping[f]!);
  if (new Set(mapped).size !== mapped.length || mapped.some(privateColumn))
    throw Error("UNSAFE_MAPPING");
  const seen = new Set<string>();
  const lines = rows.map((row) => {
    const values = Object.fromEntries(
      keys.map((f) => [f, row[config.mapping[f]!] ?? ""]),
    ) as Row;
    const quantity = numberValue(values.quantity),
      price = numberValue(values.price);
    if (
      !values.source_code.trim() ||
      values.source_code.length > 100 ||
      !values.name.trim() ||
      values.name.length > 300 ||
      quantity === null ||
      price === null ||
      price < 0 ||
      !/^[A-Z]{3}$/.test(values.currency) ||
      (values.ean?.length ?? 0) > 32 ||
      (values.brand?.length ?? 0) > 100
    )
      throw Error("INVALID_ROW");
    if (seen.has(values.source_code.trim())) throw Error("DUPLICATE_CODE");
    seen.add(values.source_code.trim());
    return keys.map((f) => quote(values[f])).join(";");
  });
  // Only public mapped fields leave the PC. Preserve their values, never add fake stock.
  const csv = [keys.join(";"), ...lines].join("\r\n") + "\r\n";
  if (Buffer.byteLength(csv) > MAX_BYTES) throw Error("FILE_SIZE");
  const hash = createHash("sha256").update(csv).digest("hex");
  const id = createHash("sha256")
    .update(`${generation}:${sourceTimestamp}:${hash}`)
    .digest("hex");
  return {
    id,
    hash,
    csv,
    rows: rows.length,
    sourceTimestamp,
    createdAt: now,
    attempts: 0,
    nextAt: now,
    generation,
  };
}
