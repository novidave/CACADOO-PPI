/// <reference lib="deno.ns" />
// PPI · shop-files Edge Function
//
// Files a shopper may open from the shop's assistant. The database decides every time,
// from the shopper's session token (from "Mám prístupový kľúč"); only active shops with the
// paid plan. The website calls this from its own server with the token from the shopper's
// cookie; the files themselves stay in the private bucket.
//
//   POST {slug, kind: "picture" | "document", id, token}               → {url}
//        a picture the assistant may show, or a PDF that may be downloaded (10-minute address)
//   POST {action: "view", slug, kind, id, token, count, page?}           → {name, can_download, shop, pages}
//        the viewer's page pictures of a file in a private folder this token opens (database
//        update 24); with `page`, that page's 10-minute address (the website adds the
//        watermark and never hands the address to the browser); `count` = one "Otvoriť"
//   POST {action: "download", slug, kind, id, token}                   → {url}
//        "Stiahnuť": a 10-minute address that downloads the original (counted; 20 per session)
//   POST {action: "zip", slug, folder_id, token}                       → {url}
//        "Stiahnuť celý priečinok (ZIP)": a single-use address for 10 minutes (counted once)
//   GET  ?zip=<ticket>                                                 → the ZIP, streamed
//        only the folder's downloadable files, stored as they are
//   POST {action: "section_pdf", slug, section_id}                     → {url}
//        "Stiahnuť PDF" of a page section (database update 28): the cleaned PDF, only while the
//        section is shown and its owner allows the download (10-minute address, bucket "shop-sections");
//        since update 38 also a picture file's original ("Stiahnuť"), named with its own type
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name
// "shop-files" → paste this file → Deploy, then switch OFF "Verify JWT" (shoppers have
// no login; the token and the database decide). No secrets needed. Nothing of a token,
// key or file is ever logged.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export const BUCKET = "shop-docs";
/** The page sections' private bucket (database update 28). */
export const SECTIONS_BUCKET = "shop-sections";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const TICKET = /^[A-Z2-9]{32,64}$/;
export const SIGNED_SECONDS = 600;

export interface Deps {
  /** Service role: the database functions and the private bucket. */
  db: SupabaseClient;
  /** This function's own address, for the ZIP link: https://<project>.supabase.co/functions/v1/shop-files */
  selfUrl: string;
  now: () => Date;
}

type Json = Record<string, unknown>;

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Target {
  slug: string;
  kind: "picture" | "document";
  id: string;
  token: string | null;
}

function target(body: Json): Target | null {
  const slug = String(body?.slug ?? "");
  const kind = body?.kind === "picture" || body?.kind === "document" ? body.kind : null;
  const id = String(body?.id ?? "");
  if (!SLUG.test(slug) || !kind || !UUID.test(id)) return null;
  return { slug, kind, id, token: tokenOf(body) };
}

/** An over-long token counts as none. */
const tokenOf = (body: Json) => (typeof body?.token === "string" && body.token.length <= 200 ? body.token : null);

/** The original behaviour: a picture the assistant shows, or a downloadable PDF. */
async function sign(t: Target, db: SupabaseClient): Promise<Response> {
  const { data: path, error } = await db.rpc("shop_file_path", {
    p_slug: t.slug,
    p_kind: t.kind,
    p_id: t.id,
    p_session_token: t.token,
  });
  if (error) return reply(500, { error: "database", message: error.message });
  if (typeof path !== "string" || !path) return reply(404, { error: "not_found", message: "No such file for you" });
  const { data: signed, error: signError } = await db.storage.from(BUCKET).createSignedUrl(path, SIGNED_SECONDS);
  if (signError || !signed?.signedUrl) return reply(404, { error: "not_found", message: "The file is missing" });
  return reply(200, { url: signed.signedUrl, expires_in: SIGNED_SECONDS });
}

/** Kept for the website's older calls and the tests: {slug, kind, id, token} → {url}. */
export async function signFile(req: Request, db: SupabaseClient): Promise<Response> {
  let body: Json;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "bad_request", message: "JSON body expected" });
  }
  const t = target(body);
  if (!t) return reply(400, { error: "bad_request", message: "slug, kind and id are required" });
  return await sign(t, db);
}

interface ViewPage {
  page: number;
  path: string;
  width: number | null;
  height: number | null;
}

/** The viewer: page list (and one page's 10-minute address); never the original file. */
async function view(t: Target, body: Json, deps: Deps): Promise<Response> {
  const page = body.page === undefined || body.page === null ? null : Number(body.page);
  if (page !== null && (!Number.isInteger(page) || page < 1 || page > 5000)) {
    return reply(400, { error: "bad_request", message: "page must be a page number" });
  }
  const { data, error } = await deps.db.rpc("shop_view_file", {
    p_slug: t.slug,
    p_kind: t.kind,
    p_id: t.id,
    p_token: t.token,
    p_count: page === null && body.count === true,
  });
  if (error) return reply(500, { error: "database", message: error.message });
  if (!data) return reply(404, { error: "not_found", message: "No such file for you" });
  const file = data as { name: string; can_download: boolean; shop: { name: string; timezone: string }; pages: ViewPage[] };
  const pages = file.pages.map((p) => ({ page: p.page, width: p.width, height: p.height }));
  if (page === null) return reply(200, { name: file.name, can_download: file.can_download, shop: file.shop, pages });
  const one = file.pages.find((p) => p.page === page);
  if (!one) return reply(404, { error: "not_found", message: "No such page" });
  const { data: signed, error: signError } = await deps.db.storage.from(BUCKET).createSignedUrl(one.path, SIGNED_SECONDS);
  if (signError || !signed?.signedUrl) return reply(404, { error: "not_found", message: "The page is missing" });
  return reply(200, { name: file.name, shop: file.shop, page, url: signed.signedUrl, expires_in: SIGNED_SECONDS });
}

/** "Stiahnuť": the original, as a download, when the database allows it (counted). */
async function download(t: Target, deps: Deps): Promise<Response> {
  const { data, error } = await deps.db.rpc("shop_download_file", {
    p_slug: t.slug,
    p_kind: t.kind,
    p_id: t.id,
    p_token: t.token,
  });
  if (error) return reply(500, { error: "database", message: error.message });
  const result = (data ?? {}) as { status?: string; path?: string; name?: string };
  if (result.status === "limit") return reply(429, { error: "limit", message: "At most 20 downloads per unlocked session" });
  if (result.status !== "ok" || !result.path) return reply(404, { error: "not_found", message: "No such file for you" });
  const { data: signed, error: signError } = await deps.db.storage
    .from(BUCKET)
    .createSignedUrl(result.path, SIGNED_SECONDS, { download: zipName(result.name ?? "subor") });
  if (signError || !signed?.signedUrl) return reply(404, { error: "not_found", message: "The file is missing" });
  return reply(200, { url: signed.signedUrl, expires_in: SIGNED_SECONDS });
}

/**
 * "Stiahnuť PDF" of a page section, or "Stiahnuť" of a picture file's original (update 38): the database decides
 * (shown in the slider, download allowed, this shop); the file keeps its own type in its name.
 */
async function sectionPdf(body: Json, deps: Deps): Promise<Response> {
  const slug = String(body?.slug ?? "");
  const id = String(body?.section_id ?? "");
  if (!SLUG.test(slug) || !UUID.test(id)) return reply(400, { error: "bad_request", message: "slug and section_id are required" });
  const { data, error } = await deps.db.rpc("shop_section_pdf", { p_slug: slug, p_section_id: id });
  if (error) return reply(500, { error: "database", message: error.message });
  const row = (data as { path: string; title: string }[] | null)?.[0];
  if (!row?.path) return reply(404, { error: "not_found", message: "No such file for you" });
  const { data: signed, error: signError } = await deps.db.storage
    .from(SECTIONS_BUCKET)
    .createSignedUrl(row.path, SIGNED_SECONDS, { download: `${zipName(row.title)}.${/\.(webp|jpg|png)$/.exec(row.path)?.[1] ?? "pdf"}` });
  if (signError || !signed?.signedUrl) return reply(404, { error: "not_found", message: "The file is missing" });
  return reply(200, { url: signed.signedUrl, expires_in: SIGNED_SECONDS });
}

/** "Stiahnuť celý priečinok (ZIP)": a single-use address of this function (counted once). */
async function zipTicket(body: Json, deps: Deps): Promise<Response> {
  const slug = String(body?.slug ?? "");
  const folderId = String(body?.folder_id ?? "");
  if (!SLUG.test(slug) || !UUID.test(folderId)) {
    return reply(400, { error: "bad_request", message: "slug and folder_id are required" });
  }
  const { data, error } = await deps.db.rpc("shop_zip_ticket", { p_slug: slug, p_folder_id: folderId, p_token: tokenOf(body) });
  if (error) return reply(500, { error: "database", message: error.message });
  const result = (data ?? {}) as { status?: string; ticket?: string };
  if (result.status === "ok" && result.ticket) {
    return reply(200, { url: `${deps.selfUrl}?zip=${encodeURIComponent(result.ticket)}`, expires_in: SIGNED_SECONDS });
  }
  const status = result.status === "limit" ? 429 : result.status === "too_big" ? 413 : 404;
  return reply(status, { error: result.status ?? "not_found" });
}

// ---------------------------------------------------------------- ZIP (stored, not compressed)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A file name safe in a ZIP and on Windows, macOS and Linux (never a path). */
export function zipName(name: string): string {
  const clean = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 150);
  return clean || "subor";
}

/** The same name twice in one ZIP: "x.pdf", "x (2).pdf". */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const name = zipName(raw);
    const dot = name.lastIndexOf(".");
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/** Local header + data of one stored entry, and its central directory record. */
function zipEntry(entry: ZipEntry, offset: number, when: Date): { local: Uint8Array; central: Uint8Array } {
  const name = new TextEncoder().encode(entry.name);
  const crc = crc32(entry.bytes);
  const { time, date } = dosTime(when);
  const local = new Uint8Array(30 + name.length + entry.bytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(6, 0x0800, true); // UTF-8 names
  lv.setUint16(8, 0, true); // stored
  lv.setUint16(10, time, true);
  lv.setUint16(12, date, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, entry.bytes.length, true);
  lv.setUint32(22, entry.bytes.length, true);
  lv.setUint16(26, name.length, true);
  lv.setUint16(28, 0, true);
  local.set(name, 30);
  local.set(entry.bytes, 30 + name.length);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(8, 0x0800, true);
  cv.setUint16(10, 0, true);
  cv.setUint16(12, time, true);
  cv.setUint16(14, date, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, entry.bytes.length, true);
  cv.setUint32(24, entry.bytes.length, true);
  cv.setUint16(28, name.length, true);
  cv.setUint32(42, offset, true);
  central.set(name, 46);
  return { local, central };
}

function zipEnd(count: number, centralSize: number, centralOffset: number): Uint8Array {
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, centralSize, true);
  v.setUint32(16, centralOffset, true);
  return end;
}

/** A ZIP built file by file while it is sent: only one file is in memory at a time. */
export function zipStream(names: string[], read: (i: number) => Promise<Uint8Array>, when: Date): ReadableStream<Uint8Array> {
  const centrals: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (i < names.length) {
          const { local, central } = zipEntry({ name: names[i], bytes: await read(i) }, offset, when);
          offset += local.length;
          centrals.push(central);
          i++;
          controller.enqueue(local);
          return;
        }
        const size = centrals.reduce((n, c) => n + c.length, 0);
        for (const c of centrals) controller.enqueue(c);
        controller.enqueue(zipEnd(centrals.length, size, offset));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

/** The folder name for Content-Disposition (ASCII fallback and the UTF-8 name). */
function attachment(name: string): string {
  const ascii = name.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "_") || "priecinok.zip";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function zipDownload(ticket: string, deps: Deps): Promise<Response> {
  if (!TICKET.test(ticket)) return new Response("Not found", { status: 404 });
  const { data, error } = await deps.db.rpc("shop_zip_take", { p_ticket: ticket });
  if (error) return new Response("Not available", { status: 500 });
  const zip = data as { folder: string; files: { path: string; name: string }[] } | null;
  if (!zip || !zip.files.length) {
    return new Response("Tento odkaz vypršal alebo už bol použitý.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const names = uniqueNames(zip.files.map((f) => f.name));
  const read = async (i: number) => {
    const { data: blob, error: readError } = await deps.db.storage.from(BUCKET).download(zip.files[i].path);
    if (readError || !blob) throw new Error("A file is missing");
    return new Uint8Array(await blob.arrayBuffer());
  };
  return new Response(zipStream(names, read, deps.now()), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": attachment(`${zipName(zip.folder)}.zip`),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "GET") {
    const ticket = new URL(req.url).searchParams.get("zip");
    return ticket ? await zipDownload(ticket, deps) : reply(405, { error: "method", message: "POST only" });
  }
  if (req.method !== "POST") return reply(405, { error: "method", message: "POST only" });
  let body: Json;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "bad_request", message: "JSON body expected" });
  }
  try {
    if (body?.action === "zip") return await zipTicket(body, deps);
    if (body?.action === "section_pdf") return await sectionPdf(body, deps);
    const t = target(body);
    if (!t) return reply(400, { error: "bad_request", message: "slug, kind and id are required" });
    if (body?.action === "view") return await view(t, body, deps);
    if (body?.action === "download") return await download(t, deps);
    if (body?.action === undefined || body?.action === "sign") return await sign(t, deps.db);
    return reply(400, { error: "bad_request", message: "Unknown action" });
  } catch (e) {
    console.error("shop-files:", String(body?.action ?? "sign"), (e instanceof Error ? e.message : String(e)).slice(0, 120));
    return reply(500, { error: "failed" });
  }
}

export async function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return reply(500, { error: "config", message: "Function is missing Supabase settings" });
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return await handle(req, { db, selfUrl: `${url.replace(/\/+$/, "")}/functions/v1/shop-files`, now: () => new Date() });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
