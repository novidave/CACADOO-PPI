/**
 * connector — the Cacaduu Cloud API for the POS Sync Agent (database update 50; phase A: pairing, heartbeat,
 * status, token rotation; database update 52; phase B: inventory snapshots). One file so it can be pasted into the Supabase editor; deploy with "Verify JWT" OFF: the
 * agent has no Supabase login, this function checks its device token itself (like stock-pull checks the owner).
 *
 * The contract is docs/CONNECTOR_CLOUD_API.md (+ docs/connector-openapi.json): every path is versioned (/v1/...),
 * every request carries "Cacaduu-Agent-Version", every authenticated request "Authorization: Bearer <device token>".
 * The shop always comes from the token, never from the request. Tokens and pairing codes are stored only as SHA-256
 * hashes (connector_* SQL functions, service role).
 *
 * Phase B: the agent announces a snapshot, uploads the gzipped JSON straight to the private bucket
 * "connector-staging" through a signed address (never through this function) and asks to complete it. This function
 * reads the file, checks the hash, the product count and every row (more than 5 % bad rows → the whole snapshot is
 * refused; fewer → those rows are skipped and their products keep their stock), keeps only the contract's fields
 * (purchase prices, suppliers, notes… are dropped, never stored) and hands the rows to connector_snapshot_apply(),
 * which decides in SQL: applied, held for the owner, or only checked (the shop's stock source is not the POS agent).
 * Phase C (Sync Now commands) paths answer 501 "not_available" until that update is deployed.
 *
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (given by Supabase), CONNECTOR_MIN_AGENT_VERSION (optional, default
 * 0.0.0), CONNECTOR_API_BASE_URL (optional, default <SUPABASE_URL>/functions/v1/connector), API_HASH_SALT (rate limits),
 * CONNECTOR_MAX_MB (optional, default 20, at most 50: a snapshot's gzipped size), SITE_URL + REVALIDATE_SECRET +
 * INDEXNOW_KEY (optional, as stock-pull: the website's cache and IndexNow after applied stock).
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

type Json = Record<string, unknown>;

export interface Deps {
  /** A service-role RPC (connector_* functions). */
  rpc(name: string, args: Json): Promise<{ data: unknown; error: { message: string } | null }>;
  minAgentVersion: string;
  apiBaseUrl: string;
  salt: string;
  now: () => Date;
  /** 32 random bytes (tests pass their own). */
  randomBytes: () => Uint8Array;
  /** Phase B: the private staging bucket (service role). */
  storage?: Staging;
  /** Phase B: the largest gzipped snapshot accepted (CONNECTOR_MAX_MB). */
  maxBytes?: number;
  /** Phase B: after applied stock — the website's cache and IndexNow; runs after the answer. */
  afterApply?: (shopId: string) => void;
}

/** The private bucket "connector-staging": one object per snapshot, "<shop>/<snapshot>.json.gz". */
export interface Staging {
  /** A signed address the agent PUTs the file to (valid for this one object). */
  signedUploadUrl(path: string): Promise<string>;
  /** The object's size, or null when it is not there. */
  size(path: string): Promise<number | null>;
  read(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
}

/** Every path of the contract; phases A and B are served, "C" answers 501 until its update. */
export const ROUTES = [
  { method: "POST", path: "/v1/pair", phase: "A" },
  { method: "POST", path: "/v1/heartbeat", phase: "A" },
  { method: "GET", path: "/v1/status", phase: "A" },
  { method: "POST", path: "/v1/credentials/rotate", phase: "A" },
  { method: "POST", path: "/v1/inventory/snapshots", phase: "B" },
  { method: "POST", path: "/v1/inventory/snapshots/{id}/complete", phase: "B" },
  { method: "GET", path: "/v1/inventory/snapshots/{id}", phase: "B" },
  { method: "POST", path: "/v1/inventory/confirm", phase: "B" },
  { method: "GET", path: "/v1/commands", phase: "C" },
  { method: "POST", path: "/v1/commands/{id}/claim", phase: "C" },
  { method: "POST", path: "/v1/commands/{id}/result", phase: "C" },
] as const;

export const SERVED_PHASES: ReadonlySet<string> = new Set(["A", "B"]);
export const DEFAULT_POLL_SECONDS = 60;
export const DEFAULT_MAX_MB = 20;
const MAX_BODY = 64 * 1024;
const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]{1,40})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_LETTERS = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

// ------------------------------------------------------------------ small helpers

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function fail(status: number, error: string, message: string, extra: Json = {}, headers: Record<string, string> = {}) {
  return reply(status, { error, message, ...extra }, headers);
}

/** "1.2.3" → [1, 2, 3]; null when it is not a version. */
export function parseVersion(text: string | null | undefined): [number, number, number] | null {
  const m = VERSION.exec((text ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is a below b? (pre-release suffixes are ignored) */
export function versionBelow(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i];
  }
  return false;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new device token: 32 random bytes, prefixed so secret scanners recognise it. Shown once, stored as a hash. */
export function newToken(deps: Deps): string {
  return `cdt_${base64url(deps.randomBytes())}`;
}

/** "abcd-efgh" / "ABCD EFGH" → "ABCDEFGH" (the dashboard shows it with a dash). */
export function normalizeCode(text: unknown): string {
  return String(text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Who calls /v1/pair, without keeping an IP: a hash of the IP with a salt that changes every day. */
export async function callerHash(req: Request, deps: Deps): Promise<string> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  return await sha256Hex(`${deps.now().toISOString().slice(0, 10)}:${deps.salt}:connector:${ip}`);
}

/** Plain text from the agent, cut to a length (the database cuts again). */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

/** The path after the function's own name: "/connector/v1/pair" or "/functions/v1/connector/v1/pair" → "/v1/pair". */
export function routePath(url: URL): string {
  const m = /(?:^|\/connector)(\/v1(?:\/.*)?)$/.exec(url.pathname.replace(/\/+$/, ""));
  return m ? m[1] : url.pathname;
}

/** The contract's route for a method + path ("{id}" matches one UUID). */
export function matchRoute(method: string, path: string): { route: (typeof ROUTES)[number]; id: string | null } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const pattern = new RegExp(`^${route.path.replace("{id}", "([0-9a-fA-F-]{36})")}$`);
    const m = pattern.exec(path);
    if (m) return { route, id: m[1] ?? null };
  }
  return null;
}

async function readBody(req: Request): Promise<Json | null> {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return null;
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

/** What every answer tells the agent about where and how often to call. */
function pollInfo(deps: Deps): Json {
  return {
    api_base_url: deps.apiBaseUrl,
    next_poll_seconds: DEFAULT_POLL_SECONDS,
    min_agent_version: deps.minAgentVersion,
    server_time: deps.now().toISOString(),
  };
}

interface Device {
  device_id: string;
  shop_id: string;
  shop_name: string;
  shop_slug: string;
}

async function authenticate(req: Request, deps: Deps): Promise<Device | null> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(cdt_[A-Za-z0-9_-]{40,60})$/.exec(header.trim());
  if (!m) return null;
  const { data, error } = await deps.rpc("connector_auth", { p_token_hash: await sha256Hex(m[1]) });
  if (error) throw new Error(`auth: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as Device | undefined;
  return row?.device_id ? row : null;
}

// ------------------------------------------------------------------ the endpoints

async function pair(req: Request, deps: Deps, body: Json): Promise<Response> {
  const code = normalizeCode(body.code);
  const name = text(body.device_name, 80) ?? "POS agent";
  const caller = await callerHash(req, deps);
  const token = newToken(deps);
  // a malformed code is still a wrong try (it counts towards the lock)
  const codeHash = await sha256Hex(CODE_LETTERS.test(code) ? code : `invalid:${code}`);
  const { data, error } = await deps.rpc("connector_pair", {
    p_code_hash: codeHash,
    p_caller: caller,
    p_name: name,
    p_version: text(body.agent_version, 40) ?? text(req.headers.get("cacaduu-agent-version"), 40),
    p_os: text(body.os, 80),
    p_token_hash: await sha256Hex(token),
  });
  if (error) throw new Error(`pair: ${error.message}`);
  const result = data as { status: string; device_id?: string; shop_name?: string; retry_after?: number };
  if (result.status === "locked") {
    return fail(429, "pairing_locked", "Too many wrong codes. Wait 15 minutes and try again.",
      { retry_after: result.retry_after ?? 900 }, { "retry-after": String(result.retry_after ?? 900) });
  }
  if (result.status !== "ok") {
    return fail(400, "invalid_code", "The pairing code is wrong, used or expired. Create a new one in Môj obchod.");
  }
  return reply(201, {
    device_id: result.device_id,
    device_token: token,
    shop: { name: result.shop_name },
    ...pollInfo(deps),
  });
}

async function heartbeat(device: Device, deps: Deps, body: Json): Promise<Response> {
  const read = (body.last_read && typeof body.last_read === "object" ? body.last_read : {}) as Json;
  const result = typeof read.result === "string" && ["ok", "unchanged", "error", "none"].includes(read.result) ? read.result : null;
  const { data, error } = await deps.rpc("connector_heartbeat", {
    p_device_id: device.device_id,
    p_version: text(body.agent_version, 40),
    p_os: text(body.os, 80),
    p_label: text(body.source_label, 80),
    p_result: result,
    p_error: text(read.error, 500),
  });
  if (error) throw new Error(`heartbeat: ${error.message}`);
  const answer = data as { status: string; shop_name?: string; retry_after?: number };
  if (answer.status === "revoked") return fail(401, "unauthorized", "This device was disconnected. Pair it again.");
  if (answer.status === "too_many") {
    return fail(429, "rate_limited", "At most 4 heartbeats a minute.", { retry_after: 60 }, { "retry-after": "60" });
  }
  // phase C fills "commands" (and shortens next_poll_seconds while a Sync Now waits)
  return reply(200, { shop: { name: answer.shop_name }, commands: [], ...pollInfo(deps) });
}

async function status(device: Device, deps: Deps): Promise<Response> {
  const { data, error } = await deps.rpc("connector_status", { p_device_id: device.device_id });
  if (error) throw new Error(`status: ${error.message}`);
  if (!data) return fail(401, "unauthorized", "This device was disconnected. Pair it again.");
  return reply(200, { ...(data as Json), ...pollInfo(deps) });
}

async function rotate(device: Device, deps: Deps): Promise<Response> {
  const token = newToken(deps);
  const { data, error } = await deps.rpc("connector_rotate", { p_device_id: device.device_id, p_new_hash: await sha256Hex(token) });
  if (error) throw new Error(`rotate: ${error.message}`);
  if (data === "too_many") return fail(429, "rate_limited", "At most 5 rotations an hour.", { retry_after: 3600 }, { "retry-after": "3600" });
  if (data !== "ok") return fail(401, "unauthorized", "This device was disconnected. Pair it again.");
  const until = new Date(deps.now().getTime() + 24 * 3600 * 1000).toISOString();
  return reply(200, { device_token: token, old_token_valid_until: until, ...pollInfo(deps) });
}

// ------------------------------------------------------------------ phase B: inventory snapshots

export const SNAPSHOT_FORMAT = "cacaduu.inventory.v1";
const HEX64 = /^[0-9a-f]{64}$/;
/** More bad rows than this share → the whole snapshot is refused. */
export const MAX_BAD_SHARE = 0.05;
/** The uncompressed snapshot may be at most this many times the gzipped limit (and never over 200 MB). */
const MAX_INFLATE = 20;

/** One product as stored: only the contract's fields, everything else (purchase price, supplier, notes…) dropped. */
export interface AgentRow {
  source_code: string;
  name: string;
  ean: string | null;
  brand: string | null;
  price: number;
  currency: string;
  quantity: number;
}

export interface RowCheck {
  rows: AgentRow[];
  /** The products of skipped rows that could be named: they keep their previous stock. */
  keep: string[];
  skipped: { line: number; reason: string }[];
}

const limited = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t.length > max) return undefined;
  return t || null;
};

/** Every product checked against the contract; a bad row is skipped with its line (1-based) and reason. */
export function checkRows(products: unknown[]): RowCheck {
  const rows: AgentRow[] = [];
  const keep = new Set<string>();
  const skipped: { line: number; reason: string }[] = [];
  const seen = new Set<string>();
  products.forEach((p, i) => {
    const line = i + 1;
    if (!p || typeof p !== "object" || Array.isArray(p)) return skipped.push({ line, reason: "not_object" });
    const r = p as Record<string, unknown>;
    const code = limited(r.source_code, 100);
    if (!code) return skipped.push({ line, reason: "source_code" });
    const bad = (reason: string) => {
      if (!seen.has(code)) keep.add(code);
      skipped.push({ line, reason });
    };
    if (seen.has(code)) return skipped.push({ line, reason: "duplicate" });
    const name = limited(r.name, 300);
    if (!name) return bad("name");
    const ean = limited(r.ean, 32);
    if (ean === undefined) return bad("ean");
    const brand = limited(r.brand, 120);
    if (brand === undefined) return bad("brand");
    if (typeof r.price !== "number" || !Number.isFinite(r.price) || r.price < 0) return bad("price");
    const currency = typeof r.currency === "string" ? r.currency.trim().toUpperCase() : "";
    if (!/^[A-Z]{3}$/.test(currency)) return bad("currency");
    if (typeof r.quantity !== "number" || !Number.isFinite(r.quantity)) return bad("quantity");
    if (limited(r.availability_status, 40) === undefined) return bad("availability_status");
    if (limited(r.warehouse, 80) === undefined) return bad("warehouse");
    seen.add(code);
    keep.delete(code);
    rows.push({ source_code: code, name, ean, brand, price: r.price, currency, quantity: r.quantity });
  });
  return { rows, keep: [...keep], skipped };
}

/** "riadok 3: price; riadok 7: currency" — the first problems, short, for the owner's report. */
export function skippedText(skipped: { line: number; reason: string }[]): string {
  const list = skipped.slice(0, 20).map((s) => `riadok ${s.line}: ${s.reason}`).join("; ");
  return (skipped.length > 20 ? `${list}; … (${skipped.length})` : list).slice(0, 500);
}

/** gunzip with a size cap; null when it is not gzip or too large. */
export async function gunzip(bytes: Uint8Array, maxOut: number): Promise<Uint8Array | "too_large" | null> {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return null;
  try {
    const stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxOut) {
        await reader.cancel();
        return "too_large";
      }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  } catch {
    return null;
  }
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const isoTime = (v: unknown): Date | null => {
  if (typeof v !== "string" || v.length > 40 || !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) || !/(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    return null;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

type SnapshotView = { snapshot_id: string; state: string; error?: string; reason?: string; message?: string; result?: Json };

/** The contract's answer for a snapshot's state (202 while it is being processed). */
function snapshotReply(view: SnapshotView, deps: Deps, status = 200): Response {
  if (view.state === "processing") return reply(202, { ...view, ...pollInfo(deps) });
  return reply(status, { ...view, ...pollInfo(deps) });
}

const stagingPath = (shopId: string, snapshotId: string) => `${shopId}/${snapshotId.toLowerCase()}.json.gz`;

function needStorage(deps: Deps): Staging {
  if (!deps.storage) throw new Error("storage not configured");
  return deps.storage;
}

async function announce(device: Device, deps: Deps, body: Json): Promise<Response> {
  const id = typeof body.snapshot_id === "string" && UUID.test(body.snapshot_id) ? body.snapshot_id.toLowerCase() : null;
  const sourceId = text(body.source_id, 80);
  const time = isoTime(body.source_time);
  const count = typeof body.product_count === "number" && Number.isInteger(body.product_count) && body.product_count >= 0 &&
      body.product_count <= 1_000_000 ? body.product_count : null;
  const hash = typeof body.content_hash === "string" && HEX64.test(body.content_hash) ? body.content_hash : null;
  const command = body.command_id === undefined || body.command_id === null
    ? null
    : typeof body.command_id === "string" && UUID.test(body.command_id) ? body.command_id : undefined;
  if (!id || !sourceId || !time || count === null || !hash || typeof body.complete !== "boolean" || command === undefined) {
    return fail(400, "bad_request",
      "Send snapshot_id (UUID), source_id, source_time (ISO 8601 with a time zone), complete, product_count and content_hash (SHA-256 hex, lower case).");
  }
  const { data, error } = await deps.rpc("connector_snapshot_announce", {
    p_device_id: device.device_id, p_snapshot_id: id, p_source_id: sourceId, p_source_time: time.toISOString(),
    p_complete: body.complete, p_count: count, p_hash: hash, p_command_id: command,
  });
  if (error) throw new Error(`announce: ${error.message}`);
  const out = data as { status: string; shop_id?: string; snapshot?: SnapshotView; retry_after?: number };
  if (out.status === "revoked") return fail(401, "unauthorized", "This device was disconnected. Pair it again.");
  if (out.status === "clock_ahead") return fail(422, "clock_ahead", "source_time is more than 5 minutes in the future: check the computer's clock.");
  if (out.status === "stale") return fail(409, "stale", "source_time is not newer than the last applied snapshot. Read the POS again.");
  if (out.status === "rate_limited") {
    return fail(429, "rate_limited", "At most one full snapshot per 5 minutes per shop.", { retry_after: 300 }, { "retry-after": "300" });
  }
  const view = out.snapshot!;
  const extra: Json = {};
  if (view.state === "awaiting_upload") {
    extra.upload_url = await needStorage(deps).signedUploadUrl(stagingPath(out.shop_id!, id));
    extra.max_bytes = deps.maxBytes ?? DEFAULT_MAX_MB * 1024 * 1024;
  }
  return reply(out.status === "new" ? 201 : 200, { ...view, ...extra, ...pollInfo(deps) });
}

async function snapshotState(device: Device, deps: Deps, id: string): Promise<Response> {
  const { data, error } = await deps.rpc("connector_snapshot_get", { p_device_id: device.device_id, p_snapshot_id: id.toLowerCase() });
  if (error) throw new Error(`snapshot: ${error.message}`);
  if (!data) return fail(404, "not_found", "Unknown snapshot.");
  return snapshotReply(data as SnapshotView, deps);
}

async function complete(device: Device, deps: Deps, rawId: string): Promise<Response> {
  const id = rawId.toLowerCase();
  const { data, error } = await deps.rpc("connector_snapshot_begin", { p_device_id: device.device_id, p_snapshot_id: id });
  if (error) throw new Error(`begin: ${error.message}`);
  const begun = data as {
    status: string; shop_id?: string; snapshot?: SnapshotView; source_id?: string; source_time?: string;
    product_count?: number; content_hash?: string; upload_expires_at?: string;
  };
  if (begun.status === "revoked") return fail(401, "unauthorized", "This device was disconnected. Pair it again.");
  if (begun.status === "not_found") return fail(404, "not_found", "Unknown snapshot. Announce it first.");
  if (begun.status === "existing") return snapshotReply(begun.snapshot!, deps);

  const shopId = begun.shop_id!;
  const storage = needStorage(deps);
  const path = stagingPath(shopId, id);
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_MB * 1024 * 1024;
  const reject = async (code: string, message: string, result: Json | null = null, status = 200) => {
    const { data: view, error: rejectError } = await deps.rpc("connector_snapshot_reject", {
      p_shop_id: shopId, p_snapshot_id: id, p_error: code, p_message: message, p_result: result,
    });
    if (rejectError) throw new Error(`reject: ${rejectError.message}`);
    await storage.remove(path).catch(() => {});
    const answer = { ...((view as SnapshotView | null) ?? { snapshot_id: id, state: "rejected", error: code, message }), ...pollInfo(deps) };
    return status === 200 ? reply(200, answer) : reply(status, { ...answer, error: code, message });
  };

  const size = await storage.size(path);
  if (size === null) {
    if (begun.upload_expires_at && deps.now() > new Date(begun.upload_expires_at)) {
      return await reject("upload_expired", "The upload address expired before the file arrived. Announce the snapshot again with a new snapshot_id.");
    }
    await deps.rpc("connector_snapshot_wait", { p_shop_id: shopId, p_snapshot_id: id });
    return fail(409, "not_uploaded", "The file is not uploaded yet. PUT it to upload_url, then complete again.", pollInfo(deps));
  }
  if (size > maxBytes) {
    return await reject("too_large", `The gzipped snapshot is larger than ${Math.round(maxBytes / 1048576)} MB.`, null, 413);
  }
  const inflated = await gunzip(await storage.read(path), Math.min(maxBytes * MAX_INFLATE, 200 * 1024 * 1024));
  if (inflated === "too_large") return await reject("too_large", "The snapshot is too large when unpacked.", null, 413);
  if (!inflated) return await reject("bad_gzip", "The file is not gzip.");
  if (await sha256Bytes(inflated) !== begun.content_hash) {
    return await reject("hash_mismatch", "content_hash does not match the uploaded file (SHA-256 of the uncompressed JSON).");
  }
  let doc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inflated));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    doc = parsed as Record<string, unknown>;
  } catch {
    return await reject("bad_format", "The file is not one UTF-8 JSON object.");
  }
  const docTime = isoTime(doc.source_time);
  if (doc.format !== SNAPSHOT_FORMAT || String(doc.snapshot_id ?? "").toLowerCase() !== id || doc.source_id !== begun.source_id ||
      !docTime || docTime.getTime() !== new Date(begun.source_time!).getTime() || !Array.isArray(doc.products)) {
    return await reject("bad_format",
      `The file must be ${SNAPSHOT_FORMAT} with the announced snapshot_id, source_id and source_time and a products array.`);
  }
  const products = doc.products as unknown[];
  if (products.length !== begun.product_count) {
    return await reject("count_mismatch", `product_count was ${begun.product_count}, the file has ${products.length} products.`);
  }
  const checked = checkRows(products);
  const result: Json = { products: products.length, skipped: checked.skipped.length };
  if (checked.skipped.length) {
    result.skipped_rows = checked.skipped.slice(0, 20);
    result.skipped_text = skippedText(checked.skipped);
  }
  if (checked.skipped.length > products.length * MAX_BAD_SHARE) {
    return await reject("invalid_rows",
      `${checked.skipped.length} of ${products.length} rows are invalid (more than 5 %): ${skippedText(checked.skipped)}`, result);
  }
  const preview = checked.rows.slice(0, 5);
  const { data: settled, error: applyError } = await deps.rpc("connector_snapshot_apply", {
    p_shop_id: shopId, p_snapshot_id: id, p_rows: checked.rows, p_keep: checked.keep, p_result: result, p_preview: preview,
  });
  if (applyError) {
    // the database refused: the previous stock stays; the agent may complete again after 5 minutes
    throw new Error(`apply: ${applyError.message}`);
  }
  await storage.remove(path).catch(() => {});
  const out = settled as { state: string; reason?: string; error?: string; result?: Json };
  if (out.state === "applied") {
    deps.afterApply?.(shopId);
    return reply(200, { snapshot_id: id, state: "applied", result: out.result, ...pollInfo(deps) });
  }
  if (out.state === "held") return reply(200, { snapshot_id: id, state: "held", reason: out.reason, ...pollInfo(deps) });
  if (out.state === "test_ok") {
    return reply(200, { snapshot_id: id, state: "test_ok", result: { products: products.length }, ...pollInfo(deps) });
  }
  if (out.error === "stale") return fail(409, "stale", "A newer snapshot was applied in the meantime. Read the POS again.", pollInfo(deps));
  return fail(409, "not_processing", "This snapshot is not waiting to be completed.", pollInfo(deps));
}

async function confirm(device: Device, deps: Deps, body: Json): Promise<Response> {
  const hash = typeof body.content_hash === "string" && HEX64.test(body.content_hash) ? body.content_hash : null;
  const time = isoTime(body.source_time);
  if (!hash || !time) {
    return fail(400, "bad_request", "Send content_hash (SHA-256 hex, lower case) and source_time (ISO 8601 with a time zone).");
  }
  const { data, error } = await deps.rpc("connector_confirm", {
    p_device_id: device.device_id, p_hash: hash, p_source_time: time.toISOString(),
  });
  if (error) throw new Error(`confirm: ${error.message}`);
  const out = data as { status: string; shop_id?: string };
  if (out.status === "revoked") return fail(401, "unauthorized", "This device was disconnected. Pair it again.");
  if (out.status === "too_many") return fail(429, "rate_limited", "At most 4 confirmations a minute.", { retry_after: 60 }, { "retry-after": "60" });
  if (out.status === "clock_ahead") return fail(422, "clock_ahead", "source_time is more than 5 minutes in the future: check the computer's clock.");
  if (out.status === "send_full") {
    return fail(409, "send_full_snapshot", "The hash differs from the last applied snapshot. Upload a full snapshot.", pollInfo(deps));
  }
  if (out.status === "test_ok") return reply(200, { state: "test_ok", ...pollInfo(deps) });
  deps.afterApply?.(out.shop_id!);
  return reply(200, { state: "confirmed", ...pollInfo(deps) });
}

// ------------------------------------------------------------------ the entry point

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const path = routePath(url);
  const match = matchRoute(req.method, path);
  if (!match) {
    return ROUTES.some((r) => new RegExp(`^${r.path.replace("{id}", "[^/]+")}$`).test(path))
      ? fail(405, "method_not_allowed", "Wrong HTTP method for this path.")
      : fail(404, "not_found", "Unknown path. Paths start with /v1/.");
  }
  // every request names its agent version; versions below the minimum must update first
  const version = req.headers.get("cacaduu-agent-version");
  if (!parseVersion(version)) {
    return fail(400, "agent_version_required", "Send the header Cacaduu-Agent-Version: <major.minor.patch>.");
  }
  if (versionBelow(version!, deps.minAgentVersion)) {
    return fail(426, "update_required", `Update the Cacaduu POS Sync Agent to ${deps.minAgentVersion} or newer.`, {
      min_agent_version: deps.minAgentVersion,
    });
  }
  if (!SERVED_PHASES.has(match.route.phase)) {
    return fail(501, "not_available", "This part of the Cacaduu Cloud API is not switched on yet.");
  }
  if (match.id !== null && !UUID.test(match.id)) return fail(404, "not_found", "Unknown id.");
  const body = req.method === "POST" ? await readBody(req) : {};
  if (body === null) return fail(400, "bad_request", "The body must be one JSON object of at most 64 KB.");
  try {
    if (match.route.path === "/v1/pair") return await pair(req, deps, body);
    const device = await authenticate(req, deps);
    if (!device) return fail(401, "unauthorized", "Missing, wrong or revoked device token.");
    if (match.route.path === "/v1/heartbeat") return await heartbeat(device, deps, body);
    if (match.route.path === "/v1/status") return await status(device, deps);
    if (match.route.path === "/v1/credentials/rotate") return await rotate(device, deps);
    if (match.route.path === "/v1/inventory/snapshots") return await announce(device, deps, body);
    if (match.route.path === "/v1/inventory/snapshots/{id}/complete") return await complete(device, deps, match.id!);
    if (match.route.path === "/v1/inventory/snapshots/{id}") return await snapshotState(device, deps, match.id!);
    return await confirm(device, deps, body);
  } catch (e) {
    // never log a token, code or body: only which step failed
    console.error("connector:", match.route.path, e instanceof Error ? e.message.slice(0, 160) : "error");
    return fail(500, "server_error", "Something went wrong on the Cacaduu side. Try again later.");
  }
}

/** CONNECTOR_MAX_MB → bytes (default 20 MB, 1 to 50; the bucket's own cap is 50 MB). */
export function maxBytesFrom(value: string | undefined): number {
  const mb = Number((value ?? "").trim());
  return Math.round((Number.isFinite(mb) && mb >= 1 ? Math.min(mb, 50) : DEFAULT_MAX_MB) * 1024 * 1024);
}

type Db = SupabaseClient;

const BUCKET = "connector-staging";

/** The staging bucket through the service role (the agent never gets more than one signed upload address). */
function stagingOf(db: Db): Staging {
  const bucket = () => db.storage.from(BUCKET);
  return {
    async signedUploadUrl(path) {
      const { data, error } = await bucket().createSignedUploadUrl(path, { upsert: true });
      if (error || !data) throw new Error(`signed upload: ${error?.message ?? "no address"}`);
      return data.signedUrl;
    },
    async size(path) {
      const [dir, name] = [path.slice(0, path.lastIndexOf("/")), path.slice(path.lastIndexOf("/") + 1)];
      const { data, error } = await bucket().list(dir, { search: name, limit: 10 });
      if (error) throw new Error(`list: ${error.message}`);
      const found = (data ?? []).find((f) => f.name === name);
      if (!found) return null;
      const size = Number((found.metadata as { size?: number } | null)?.size);
      return Number.isFinite(size) ? size : 0;
    },
    async read(path) {
      const { data, error } = await bucket().download(path);
      if (error || !data) throw new Error(`download: ${error?.message ?? "missing"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    async remove(path) {
      await bucket().remove([path]);
    },
  };
}

/** After applied stock: the website's cache and IndexNow (as stock-pull); failures only mean "within the minute". */
async function afterUpdate(db: Db, shopId: string, site: { url: string | null; secret: string | null; indexNowKey: string | null }) {
  const { data: shop } = await db.from("shops").select("slug").eq("id", shopId).maybeSingle();
  const slug = (shop as { slug?: string } | null)?.slug;
  if (site.url && site.secret && slug) {
    await fetch(`${site.url}/api/revalidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ppi-revalidate": site.secret },
      body: JSON.stringify({ slug }),
      signal: AbortSignal.timeout(5_000),
    }).then((r) => r.body?.cancel()).catch(() => {});
  }
  if (site.indexNowKey && site.url) {
    const mainHost = new URL(site.url).hostname;
    const { data } = await db.rpc("indexnow_claim_host", { p_shop_id: shopId, p_main_host: mainHost, p_max_items: 3333 });
    const claim = data as { host: string; kind: string; items?: { id: string }[]; lang?: string | null; upto?: string; upto_id?: string; skip?: string } | null;
    if (!claim || claim.skip || !claim.items?.length) return;
    const langs = claim.kind === "site" && claim.lang ? [claim.lang, ...["sk", "hu", "en"].filter((l) => l !== claim.lang)] : ["sk", "hu", "en"];
    const urls = claim.items.filter((i) => UUID.test(i.id)).flatMap((i) => langs.map((l) => `https://${claim.host}/${l}/items/${i.id}`)).slice(0, 10_000);
    let status: number | null = null;
    let result = "failed";
    try {
      const res = await fetch("https://api.indexnow.org/indexnow", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: claim.host, key: site.indexNowKey, keyLocation: `https://${claim.host}/${site.indexNowKey}.txt`, urlList: urls }),
        signal: AbortSignal.timeout(15_000),
      });
      status = res.status;
      result = String(res.status);
      await res.body?.cancel().catch(() => {});
    } catch {
      // sent again with the next ping
    }
    await db.rpc("indexnow_done", {
      p_host: claim.host, p_kind: claim.kind, p_upto: claim.upto ?? null, p_upto_id: claim.upto_id ?? null,
      p_urls: urls.length, p_status: status, p_result: result,
    });
  }
}

export function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return Promise.resolve(fail(500, "server_error", "The function is not configured."));
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const min = Deno.env.get("CONNECTOR_MIN_AGENT_VERSION")?.trim();
  let site: string | null = null;
  try {
    const s = new URL((Deno.env.get("SITE_URL") ?? "").trim());
    if (s.protocol === "https:") site = s.origin;
  } catch {
    // no SITE_URL
  }
  const secret = (Deno.env.get("REVALIDATE_SECRET") ?? "").trim();
  const indexNow = (Deno.env.get("INDEXNOW_KEY") ?? "").trim();
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  return handle(req, {
    rpc: async (name, args) => {
      const { data, error } = await db.rpc(name, args);
      return { data, error: error ? { message: error.message } : null };
    },
    minAgentVersion: parseVersion(min) ? min! : "0.0.0",
    apiBaseUrl: (Deno.env.get("CONNECTOR_API_BASE_URL")?.trim() || `${url}/functions/v1/connector`).replace(/\/+$/, ""),
    salt: Deno.env.get("API_HASH_SALT") ?? "ppi",
    now: () => new Date(),
    randomBytes: () => crypto.getRandomValues(new Uint8Array(32)),
    storage: stagingOf(db),
    maxBytes: maxBytesFrom(Deno.env.get("CONNECTOR_MAX_MB")),
    afterApply: (shopId) => {
      const task = afterUpdate(db, shopId, {
        url: site,
        secret: secret.length >= 16 ? secret : null,
        indexNowKey: /^[A-Za-z0-9-]{8,128}$/.test(indexNow) ? indexNow : null,
      }).catch(() => {});
      if (runtime) runtime.waitUntil(task);
    },
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
