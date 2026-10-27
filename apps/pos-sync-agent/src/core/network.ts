import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { assertHttps, MAX_BYTES, type Config, type Row } from "./model";
export function publicAddress(ip: string): boolean {
  if (isIP(ip) !== 4) return false; // Reject IPv6 until a complete vetted classifier is supplied.
  const [a, b] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a === 255
  );
}
export async function safeUrl(raw: string) {
  const u = assertHttps(raw);
  if (u.port && u.port !== "443") throw Error("PORT_DENIED");
  const addresses = await lookup(u.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
    throw Error("HOST_DENIED");
  return { url: u, address: addresses[0].address };
}
export async function jsonRequest(
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  // Resolve once and pin the verified IPv4 address on the actual TLS connection.
  const { url: u, address } = await safeUrl(url);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      u,
      {
        family: 4,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        lookup: (_hostname, _options, callback) => callback(null, address, 4),
      },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.destroy();
          reject(Error(`HTTP_${res.statusCode}`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy(Error("RESPONSE_SIZE"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(Error("API_CONTRACT"));
          }
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(Error("REQUEST_TIMEOUT")),
      30000,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}
export function at(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (v, k) =>
        v && typeof v === "object" && Object.hasOwn(v, k)
          ? (v as Record<string, unknown>)[k]
          : undefined,
      value,
    );
}
export async function restSnapshot(
  config: Config,
  request = jsonRequest,
): Promise<{ rows: Row[]; time: string }> {
  const r = config.rest;
  if (!r) throw Error("REST_REQUIRED");
  assertHttps(r.url);
  const result: Row[] = [];
  let bytes = 0;
  let total: number | undefined, time: string | undefined;
  for (let page = 1; page <= 1000; page++) {
    const url = new URL(r.url);
    url.searchParams.set(r.pageParam, String(page));
    url.searchParams.set(r.pageSizeParam, String(r.pageSize));
    const data = await request(url.toString(), {
      headers: r.token ? { Authorization: `Bearer ${r.token}` } : {},
    });
    bytes += Buffer.byteLength(JSON.stringify(data));
    if (bytes > MAX_BYTES) throw Error("RESPONSE_SIZE");
    const count = at(data, r.totalPath),
      stamp = at(data, r.timePath),
      items = at(data, r.itemsPath);
    if (
      !Number.isInteger(count) ||
      count !== config.expectedRows ||
      typeof stamp !== "string" ||
      !Array.isArray(items) ||
      items.length > r.pageSize ||
      !items.length
    )
      throw Error("REST_INCOMPLETE");
    if (total !== undefined && (total !== count || time !== stamp))
      throw Error("REST_CHANGED_DURING_READ");
    total = count as number;
    time = stamp;
    if (items.some((v) => !v || typeof v !== "object" || Array.isArray(v)))
      throw Error("REST_INVALID");
    result.push(
      ...items.map((v) =>
        Object.fromEntries(
          Object.entries(v).map(([k, x]) => [
            k,
            typeof x === "string" || typeof x === "number" ? String(x) : "",
          ]),
        ),
      ),
    );
    if (result.length === total) return { rows: result, time: time! };
    if (result.length > total) throw Error("REST_INCOMPLETE");
  }
  throw Error("REST_PAGE_LIMIT");
}
