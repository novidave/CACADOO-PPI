/**
 * connector — the Cacaduu Cloud API for the POS Sync Agent (database update 50; phase A: pairing, heartbeat,
 * status, token rotation). One file so it can be pasted into the Supabase editor; deploy with "Verify JWT" OFF: the
 * agent has no Supabase login, this function checks its device token itself (like stock-pull checks the owner).
 *
 * The contract is docs/CONNECTOR_CLOUD_API.md (+ docs/connector-openapi.json): every path is versioned (/v1/...),
 * every request carries "Cacaduu-Agent-Version", every authenticated request "Authorization: Bearer <device token>".
 * The shop always comes from the token, never from the request. Tokens and pairing codes are stored only as SHA-256
 * hashes (connector_* SQL functions, service role). Phase B (inventory snapshots) and phase C (Sync Now commands)
 * paths are in the contract already and answer 501 "not_available" until those updates are deployed.
 *
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (given by Supabase), CONNECTOR_MIN_AGENT_VERSION (optional, default
 * 0.0.0), CONNECTOR_API_BASE_URL (optional, default <SUPABASE_URL>/functions/v1/connector), API_HASH_SALT (rate limits).
 */

import { createClient } from "npm:@supabase/supabase-js@2";

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
}

/** Every path of the contract; "A" is served by this update, "B" / "C" answer 501 until their updates. */
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

export const DEFAULT_POLL_SECONDS = 60;
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
  if (match.route.phase !== "A") {
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
    return await rotate(device, deps);
  } catch (e) {
    // never log a token, code or body: only which step failed
    console.error("connector:", match.route.path, e instanceof Error ? e.message.slice(0, 160) : "error");
    return fail(500, "server_error", "Something went wrong on the Cacaduu side. Try again later.");
  }
}

export function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return Promise.resolve(fail(500, "server_error", "The function is not configured."));
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const min = Deno.env.get("CONNECTOR_MIN_AGENT_VERSION")?.trim();
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
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
