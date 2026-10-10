/// <reference lib="deno.ns" />
// PPI · cloud-export Edge Function
//
// Copies the shop assistant's conversations (the PDF and the shopper's files) into the
// shop's own OneDrive or Dropbox folder (paid plan; database update 23). One file, pasted
// into the Supabase editor with "Verify JWT" OFF: it checks every caller itself.
//
//   The shop's owners (their login; membership and plan checked):
//     connect        {shop_id, provider, folder, return_url} → {url}   the provider's consent page
//     folders        {shop_id, path}                         → {path, folders}
//     create_folder  {shop_id, path, name}                   → {path}
//     set_folder     {shop_id, path}                         → {path}  (made when missing)
//     disconnect     {shop_id}                               "Odpojiť"
//     retry          {conversation_id}                       "Uložiť znova"
//     backfill       {shop_id, from, to}                     "Uložiť staršie konverzácie" → {count}
//   The provider's redirect: GET …/cloud-export/oauth/<onedrive|dropbox>?code=&state=
//     → the tokens are encrypted and kept, the folder is made, the owner goes back to Môj obchod.
//   The assistant-archive function (Authorization: Bearer <service role key>):
//     export {conversation_id}                               right after its PDF is made
//   The job (pg_cron, header x-ppi-cron = the Vault secret ppi_assistant_cron):
//     tick            due copies, then the e-mail to owners whose copies failed for 24 hours
//
// In the cloud: <target>/<YYYY-MM>/<YYYY-MM-DD_HH-MM_id>/konverzacia.pdf and …/subory/<files>.
// PPI never overwrites or deletes anything there: a different file with the same name gets
// " (2)", " (3)"…; a file that is already there (same size and hash) is not sent again.
// Tokens are kept only encrypted (AES-GCM, EXPORT_TOKEN_ENCRYPTION_KEY); nothing of a token,
// a key or a file is ever logged.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export type Provider = "onedrive" | "dropbox";
export const PROVIDERS: Provider[] = ["onedrive", "dropbox"];
const BUCKET = "shop-assistant-uploads";
const PDF_NAME = "konverzacia.pdf";
const FILES_DIR = "subory";
/** A copy taken by the job gets this long; the job itself stops starting new ones after TICK_BUDGET_MS. */
const TICK_BUDGET_MS = 90_000;
const PER_TICK = 5;
const MAX_VERSIONS = 50;
const MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
};
const PROVIDER_NAMES: Record<Provider, string> = { onedrive: "OneDrive", dropbox: "Dropbox" };

// ---------------------------------------------------------------- small helpers

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array {
  const b = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

export const sha256Hex = async (text: string) => hex(await sha256(enc.encode(text)));

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** Equal strings, compared in constant time. */
export function sameSecret(given: string | null, expected: string | null): boolean {
  if (!given || !expected || expected.length < 20) return false;
  const a = enc.encode(given);
  const b = enc.encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------- tokens, encrypted

/** AES-GCM key from EXPORT_TOKEN_ENCRYPTION_KEY (any 32+ characters; HKDF-SHA-256). */
export async function tokenKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("EXPORT_TOKEN_ENCRYPTION_KEY must have at least 32 characters");
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("ppi-cloud-export"), info: enc.encode("tokens v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** "v1.<iv>.<ciphertext>"; `bind` ties it to its shop, provider and use (the same text elsewhere does not open). */
export async function encryptToken(key: CryptoKey, plain: string, bind: string): Promise<string> {
  const iv = random(12);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: enc.encode(bind) },
    key,
    enc.encode(plain),
  );
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(data))}`;
}

export async function decryptToken(key: CryptoKey, text: string, bind: string): Promise<string> {
  const [version, iv, data] = text.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("unknown token format");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(iv) as BufferSource, additionalData: enc.encode(bind) },
    key,
    fromB64url(data) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

// ---------------------------------------------------------------- PKCE

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await sha256(enc.encode(verifier)));
}

// ---------------------------------------------------------------- the files' hashes (to know a file is there already)

/** OneDrive's QuickXorHash (base64): 160-bit register, each byte xored in 11 bits further, the length at the end. */
export function quickXorHash(data: Uint8Array): string {
  const out = new Uint8Array(20);
  const n = data.length;
  for (let i = 0; i < Math.min(n, 160); i++) {
    let x = 0;
    for (let j = i; j < n; j += 160) x ^= data[j];
    if (!x) continue;
    const at = (i * 11) % 160;
    for (let bit = 0; bit < 8; bit++) {
      if (x & (1 << bit)) {
        const k = (at + bit) % 160;
        out[k >> 3] ^= 1 << (k & 7);
      }
    }
  }
  let length = n;
  for (let k = 12; k < 20; k++) {
    out[k] ^= length % 256;
    length = Math.floor(length / 256);
  }
  let s = "";
  for (const b of out) s += String.fromCharCode(b);
  return btoa(s);
}

/** Dropbox's content_hash (hex): SHA-256 of the SHA-256 of every 4 MiB block. */
export async function dropboxContentHash(data: Uint8Array): Promise<string> {
  const BLOCK = 4 * 1024 * 1024;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += BLOCK) parts.push(await sha256(data.subarray(i, i + BLOCK)));
  const joined = new Uint8Array(parts.length * 32);
  parts.forEach((p, i) => joined.set(p, i * 32));
  return hex(await sha256(joined));
}

// ---------------------------------------------------------------- names and folders

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A file or folder name both clouds accept: no path, no reserved characters, not empty, at most 120 characters. */
export function cleanName(name: string): string {
  let n = name.normalize("NFC").replace(/[\p{Cc}"*:<>?/\\|]/gu, "_").replace(/\s+/g, " ").trim();
  n = n.replace(/[. ]+$/, "").slice(0, 120).trim();
  if (!n || n === "." || n === "..") n = "subor";
  if (RESERVED.test(n)) n = `_${n}`;
  return n;
}

/** A cloud share link (cannot be written to): the owner is offered the connection instead. */
export function isShareLink(text: string): boolean {
  return /^\s*(https?:\/\/|www\.)/i.test(text) || /(1drv\.ms|onedrive\.live\.com|sharepoint\.com|dropbox\.com|db\.tt)/i.test(text);
}

/** "/Cacadoo/Potraviny Centrum": every part cleaned; null for a link or a path that climbs up. */
export function cleanFolderPath(path: string): string | null {
  if (!path || isShareLink(path)) return null;
  const parts = path.replace(/\\/g, "/").split("/").map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 10 || parts.some((p) => p === "." || p === "..")) return null;
  const clean = "/" + parts.map(cleanName).join("/");
  return clean.length <= 400 ? clean : null;
}

export const defaultFolder = (shopName: string) => `/Cacadoo/${cleanName(shopName)}`;

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/** "konverzacia.pdf" → "konverzacia (2).pdf" */
export function versionName(name: string, n: number): string {
  if (n <= 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

function zoneParts(iso: string, timeZone: string) {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute", string>;
}

/** <target>/<YYYY-MM>/<YYYY-MM-DD_HH-MM_id> in the shop's time zone (the same name as the conversation's PDF). */
export function conversationFolder(target: string, startedAt: string, timeZone: string, id: string): string {
  const p = zoneParts(startedAt, timeZone);
  const short = id.replace(/-/g, "").slice(0, 8);
  return `${target}/${p.year}-${p.month}/${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}_${short}`;
}

// ---------------------------------------------------------------- the clouds

export type ErrorKind = "auth" | "expired" | "throttled" | "quota" | "conflict" | "not_folder" | "other";

/** What went wrong at the cloud; `message` is safe to show the owner (never a token). */
export class CloudError extends Error {
  constructor(readonly kind: ErrorKind, message: string, readonly retryAfter: number | null = null) {
    super(message);
  }
}

export interface Tokens {
  access: string;
  refresh: string | null;
  expiresAt: string | null;
  scope: string | null;
}

export interface RemoteItem {
  id: string;
  size: number;
  hash: string | null;
  folder: boolean;
}

export interface Adapter {
  provider: Provider;
  configured(): boolean;
  authorizeUrl(args: { state: string; challenge: string; redirectUri: string }): string;
  exchange(code: string, verifier: string, redirectUri: string): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens>;
  account(token: string): Promise<{ name: string | null; email: string | null }>;
  stat(token: string, path: string): Promise<RemoteItem | null>;
  listFolders(token: string, path: string): Promise<string[]>;
  createFolder(token: string, path: string): Promise<"created" | "exists">;
  upload(token: string, path: string, bytes: Uint8Array, contentType: string): Promise<RemoteItem | "exists">;
  hash(bytes: Uint8Array): Promise<string>;
  revoke(token: string): Promise<void>;
}

type Fetch = typeof fetch;

const retryAfter = (res: Response) => {
  const value = Number(res.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? Math.min(value, 3600) : null;
};

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** A refused token request: invalid_grant (the owner revoked it, or it is too old) means connect again. */
async function tokenError(res: Response, name: string): Promise<never> {
  const data = await body(res);
  const code = String(data.error ?? "");
  if (code === "invalid_grant") throw new CloudError("expired", `${name}: the connection has expired`);
  if (code === "invalid_client" || code === "unauthorized_client") {
    throw new CloudError("other", `${name}: the app's ID or secret in Supabase is not valid`);
  }
  throw new CloudError(res.status === 429 ? "throttled" : "other", `${name}: sign-in failed (${code || res.status})`, retryAfter(res));
}

function tokens(data: Record<string, unknown>, keepRefresh: string | null = null): Tokens {
  const access = typeof data.access_token === "string" ? data.access_token : "";
  if (!access) throw new CloudError("other", "no access token");
  const seconds = Number(data.expires_in);
  return {
    access,
    refresh: typeof data.refresh_token === "string" ? data.refresh_token : keepRefresh,
    expiresAt: Number.isFinite(seconds) ? new Date(Date.now() + seconds * 1000).toISOString() : null,
    scope: typeof data.scope === "string" ? data.scope : null,
  };
}

/** Microsoft OneDrive through Microsoft Graph (personal and work accounts). */
export function oneDrive(env: { clientId?: string; clientSecret?: string }, f: Fetch = fetch): Adapter {
  const LOGIN = "https://login.microsoftonline.com/common/oauth2/v2.0";
  const GRAPH = "https://graph.microsoft.com/v1.0/me/drive";
  // Only the owner's own files, and staying connected (refresh tokens): the narrowest
  // permission that can write to a folder the owner chooses anywhere in their OneDrive.
  const SCOPE = "offline_access Files.ReadWrite";
  const segs = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  // The item itself: root:/a/b; something of it: root:/a/b:/children, root:/a/b:/content.
  const item = (path: string) => (path === "/" ? `${GRAPH}/root` : `${GRAPH}/root:/${segs(path)}`);
  const sub = (path: string, what: string) => (path === "/" ? `${GRAPH}/root/${what}` : `${GRAPH}/root:/${segs(path)}:/${what}`);

  async function call(token: string, url: string, init: RequestInit = {}): Promise<Response> {
    const res = await f(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    if (res.status === 401) throw new CloudError("auth", "OneDrive: the sign-in needs renewing");
    if (res.status === 429 || res.status === 503) throw new CloudError("throttled", "OneDrive is busy, trying later", retryAfter(res));
    if (res.status === 507) throw new CloudError("quota", "OneDrive is full");
    return res;
  }
  async function fail(res: Response, what: string): Promise<never> {
    const data = await body(res);
    const code = (data.error as { code?: string } | undefined)?.code ?? String(res.status);
    if (code === "quotaLimitReached") throw new CloudError("quota", "OneDrive is full");
    throw new CloudError("other", `OneDrive: ${what} failed (${code})`);
  }
  const toItem = (d: Record<string, unknown>): RemoteItem => ({
    id: String(d.id ?? ""),
    size: Number(d.size ?? 0),
    hash: ((d.file as { hashes?: { quickXorHash?: string } } | undefined)?.hashes?.quickXorHash) ?? null,
    folder: Boolean(d.folder),
  });
  async function token(form: Record<string, string>, keep: string | null) {
    const res = await f(`${LOGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.clientId ?? "", client_secret: env.clientSecret ?? "", scope: SCOPE, ...form }),
    });
    if (!res.ok) await tokenError(res, "OneDrive");
    return tokens(await body(res), keep);
  }

  return {
    provider: "onedrive",
    configured: () => Boolean(env.clientId && env.clientSecret),
    authorizeUrl: ({ state, challenge, redirectUri }) =>
      `${LOGIN}/authorize?${new URLSearchParams({
        client_id: env.clientId ?? "",
        response_type: "code",
        redirect_uri: redirectUri,
        response_mode: "query",
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      })}`,
    exchange: (code, verifier, redirectUri) =>
      token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }, null),
    refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }, refreshToken),
    async account(t) {
      const res = await call(t, `${GRAPH}?$select=owner`);
      if (!res.ok) await fail(res, "reading the account");
      const owner = ((await body(res)).owner as { user?: { displayName?: string; email?: string } } | undefined)?.user;
      return { name: owner?.displayName ?? null, email: owner?.email ?? null };
    },
    async stat(t, path) {
      const res = await call(t, `${item(path)}?$select=id,size,file,folder`);
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, "reading a file");
      return toItem(await body(res));
    },
    async listFolders(t, path) {
      const names: string[] = [];
      let url: string | null = `${sub(path, "children")}?$select=name,folder&$top=200`;
      for (let page = 0; url && page < 10; page++) {
        const res: Response = await call(t, url);
        if (res.status === 404) throw new CloudError("not_folder", "The folder does not exist");
        if (!res.ok) await fail(res, "listing folders");
        const data = await body(res);
        for (const entry of (data.value as { name: string; folder?: unknown }[] | undefined) ?? []) {
          if (entry.folder) names.push(entry.name);
        }
        url = typeof data["@odata.nextLink"] === "string" ? (data["@odata.nextLink"] as string) : null;
      }
      return names.sort((a, b) => a.localeCompare(b));
    },
    async createFolder(t, path) {
      const res = await call(t, sub(parentOf(path), "children"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: path.slice(path.lastIndexOf("/") + 1), folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
      });
      if (res.status === 409) return "exists";
      if (!res.ok) await fail(res, "making a folder");
      return "created";
    },
    async upload(t, path, bytes, contentType) {
      // Never replaces: a file of the same name makes it fail (409).
      const res = await call(t, `${sub(path, "content")}?@microsoft.graph.conflictBehavior=fail`, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: bytes as BodyInit,
      });
      if (res.status === 409) return "exists";
      if (!res.ok) await fail(res, "sending a file");
      return toItem(await body(res));
    },
    hash: (bytes) => Promise.resolve(quickXorHash(bytes)),
    // Microsoft has no way to revoke one app's token; the owner can remove the app in their account.
    revoke: () => Promise.resolve(),
  };
}

/** Dropbox (scoped app, full Dropbox): files.metadata.read, files.content.write, account_info.read. */
export function dropbox(env: { appKey?: string; appSecret?: string }, f: Fetch = fetch): Adapter {
  const API = "https://api.dropboxapi.com";
  const CONTENT = "https://content.dropboxapi.com";
  const SCOPE = "files.metadata.read files.content.write account_info.read";
  const at = (path: string) => (path === "/" ? "" : path);

  async function rpc(t: string, endpoint: string, args: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await f(`${API}/2/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, ...(args === null ? {} : { "Content-Type": "application/json" }) },
      body: args === null ? undefined : JSON.stringify(args),
    });
    return { status: check(res), data: await body(res) };
  }
  function check(res: Response): number {
    if (res.status === 401) throw new CloudError("auth", "Dropbox: the sign-in needs renewing");
    if (res.status === 429 || res.status === 503) throw new CloudError("throttled", "Dropbox is busy, trying later", retryAfter(res));
    return res.status;
  }
  const summary = (data: Record<string, unknown>) => String(data.error_summary ?? "");
  function fail(status: number, data: Record<string, unknown>, what: string): never {
    const s = summary(data);
    if (/insufficient_space/.test(s)) throw new CloudError("quota", "Dropbox is full");
    throw new CloudError("other", `Dropbox: ${what} failed (${s.split("/").slice(0, 2).join("/") || status})`);
  }
  const toItem = (d: Record<string, unknown>): RemoteItem => ({
    id: String(d.id ?? ""),
    size: Number(d.size ?? 0),
    hash: typeof d.content_hash === "string" ? d.content_hash : null,
    folder: d[".tag"] === "folder",
  });
  async function token(form: Record<string, string>, keep: string | null) {
    const res = await f(`${API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.appKey ?? "", client_secret: env.appSecret ?? "", ...form }),
    });
    if (!res.ok) await tokenError(res, "Dropbox");
    return tokens(await body(res), keep);
  }

  return {
    provider: "dropbox",
    configured: () => Boolean(env.appKey && env.appSecret),
    authorizeUrl: ({ state, challenge, redirectUri }) =>
      `https://www.dropbox.com/oauth2/authorize?${new URLSearchParams({
        client_id: env.appKey ?? "",
        response_type: "code",
        redirect_uri: redirectUri,
        state,
        token_access_type: "offline",
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
    exchange: (code, verifier, redirectUri) =>
      token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }, null),
    refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }, refreshToken),
    async account(t) {
      const { status, data } = await rpc(t, "users/get_current_account", null);
      if (status !== 200) fail(status, data, "reading the account");
      return { name: (data.name as { display_name?: string } | undefined)?.display_name ?? null, email: (data.email as string) ?? null };
    },
    async stat(t, path) {
      const { status, data } = await rpc(t, "files/get_metadata", { path: at(path) });
      if (status === 409 && /not_found/.test(summary(data))) return null;
      if (status !== 200) fail(status, data, "reading a file");
      return toItem(data);
    },
    async listFolders(t, path) {
      const names: string[] = [];
      let { status, data } = await rpc(t, "files/list_folder", { path: at(path), limit: 200 });
      for (let page = 0; page < 10; page++) {
        if (status === 409) throw new CloudError("not_folder", "The folder does not exist");
        if (status !== 200) fail(status, data, "listing folders");
        for (const entry of (data.entries as { ".tag": string; name: string }[] | undefined) ?? []) {
          if (entry[".tag"] === "folder") names.push(entry.name);
        }
        if (!data.has_more) break;
        ({ status, data } = await rpc(t, "files/list_folder/continue", { cursor: data.cursor }));
      }
      return names.sort((a, b) => a.localeCompare(b));
    },
    async createFolder(t, path) {
      const { status, data } = await rpc(t, "files/create_folder_v2", { path, autorename: false });
      if (status === 409 && /conflict\/folder/.test(summary(data))) return "exists";
      if (status === 409 && /conflict/.test(summary(data))) throw new CloudError("not_folder", "A file has the folder's name");
      if (status !== 200) fail(status, data, "making a folder");
      return "created";
    },
    async upload(t, path, bytes) {
      // mode "add" without autorename: never replaces; a file of the same name makes it fail (409).
      const res = await f(`${CONTENT}/2/files/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": dropboxArg({ path, mode: "add", autorename: false, mute: true, strict_conflict: true }),
        },
        body: bytes as BodyInit,
      });
      const status = check(res);
      const data = await body(res);
      if (status === 409 && /conflict/.test(summary(data))) return "exists";
      if (status !== 200) fail(status, data, "sending a file");
      return toItem(data);
    },
    hash: dropboxContentHash,
    async revoke(t) {
      await f(`${API}/2/auth/token/revoke`, { method: "POST", headers: { Authorization: `Bearer ${t}` } }).catch(() => null);
    },
  };
}

/** Dropbox-API-Arg is an HTTP header: JSON with every non-ASCII character escaped. */
export function dropboxArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// ---------------------------------------------------------------- dependencies

export interface Deps {
  /** Service role: the database functions and the archive's bucket. */
  db: SupabaseClient;
  /** The caller's own login (owners): membership and the owner functions decide. */
  asCaller: (authorization: string) => SupabaseClient;
  adapters: Record<Provider, Adapter>;
  /** EXPORT_TOKEN_ENCRYPTION_KEY, or null when not set. */
  tokenSecret: string | null;
  /** SUPABASE_SERVICE_ROLE_KEY: what the assistant-archive function proves itself with. */
  serviceKey: string | null;
  /** <SUPABASE_URL>/functions/v1/cloud-export/oauth/ */
  redirectBase: string;
  /** The alert e-mail (BREVO_API_KEY, ALERT_EMAIL_FROM); null when not set up. */
  email: { apiKey: string; from: string } | null;
  fetch: Fetch;
  background: (task: Promise<unknown>) => void;
  now: () => number;
}

type Json = Record<string, unknown>;

function reply(status: number, data: unknown) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

const failText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

// ---------------------------------------------------------------- a connection in use

interface Connection {
  shop_id: string;
  provider: Provider;
  folder_path: string;
  access_token_enc: string;
  refresh_token_enc: string;
  access_expires_at: string | null;
}

const bind = (shop: string, provider: Provider, use: "access" | "refresh") => `${shop}:${provider}:${use}`;

/** Something that makes calls to one cloud with a valid token. */
export interface Runner {
  adapter: Adapter;
  run<T>(work: (token: string) => Promise<T>): Promise<T>;
}

/** Decrypts the connection's tokens, renews the access token when it is (almost) expired. */
class Session implements Runner {
  private constructor(
    private readonly deps: Deps,
    private readonly key: CryptoKey,
    readonly connection: Connection,
    readonly adapter: Adapter,
    private access: string,
    private refreshToken: string,
    private expiresAt: number | null,
  ) {}

  static async open(deps: Deps, connection: Connection): Promise<Session> {
    if (!deps.tokenSecret) throw new CloudError("other", "EXPORT_TOKEN_ENCRYPTION_KEY is not set");
    const key = await tokenKey(deps.tokenSecret);
    const adapter = deps.adapters[connection.provider];
    if (!adapter?.configured()) throw new CloudError("other", `${PROVIDER_NAMES[connection.provider]} is not set up`);
    const session = new Session(
      deps,
      key,
      connection,
      adapter,
      await decryptToken(key, connection.access_token_enc, bind(connection.shop_id, connection.provider, "access")),
      await decryptToken(key, connection.refresh_token_enc, bind(connection.shop_id, connection.provider, "refresh")),
      connection.access_expires_at ? Date.parse(connection.access_expires_at) : null,
    );
    if (session.expiresAt !== null && session.expiresAt < deps.now() + 5 * 60_000) await session.renew();
    return session;
  }

  async renew() {
    const t = await this.adapter.refresh(this.refreshToken);
    const { shop_id, provider } = this.connection;
    this.access = t.access;
    this.expiresAt = t.expiresAt ? Date.parse(t.expiresAt) : null;
    const rotated = t.refresh && t.refresh !== this.refreshToken ? t.refresh : null;
    if (rotated) this.refreshToken = rotated;
    await this.deps.db.rpc("cloud_connection_tokens", {
      p_shop_id: shop_id,
      p_access_enc: await encryptToken(this.key, t.access, bind(shop_id, provider, "access")),
      p_refresh_enc: rotated ? await encryptToken(this.key, rotated, bind(shop_id, provider, "refresh")) : null,
      p_expires_at: t.expiresAt,
    });
  }

  /** "Odpojiť": the cloud forgets this token where it can (Dropbox). */
  async revoke() {
    await this.adapter.revoke(this.access).catch(() => null);
  }

  /** A call with the access token; renewed once when the cloud says it has expired. */
  async run<T>(work: (token: string) => Promise<T>): Promise<T> {
    try {
      return await work(this.access);
    } catch (e) {
      if (!(e instanceof CloudError) || e.kind !== "auth") throw e;
      await this.renew();
      return await work(this.access);
    }
  }
}

async function connectionOf(deps: Deps, shopId: string): Promise<Connection | null> {
  const { data } = await deps.db
    .from("cloud_connections")
    .select("shop_id, provider, folder_path, access_token_enc, refresh_token_enc, access_expires_at")
    .eq("shop_id", shopId)
    .maybeSingle();
  return (data as Connection | null) ?? null;
}

/** Makes every missing folder of the path, one by one (nothing when it is there already). */
async function ensureFolder(session: Runner, path: string) {
  const whole = await session.run((t) => session.adapter.stat(t, path));
  if (whole?.folder) return;
  let at = "";
  for (const part of path.split("/").filter(Boolean)) {
    at = `${at}/${part}`;
    const result = await session.run((t) => session.adapter.createFolder(t, at));
    if (result === "exists") {
      const item = await session.run((t) => session.adapter.stat(t, at));
      if (item && !item.folder) throw new CloudError("not_folder", `${at} is a file, not a folder`);
    }
  }
}

/**
 * Puts one file into the folder without ever replacing anything: the same file already
 * there (size and hash) counts as sent; a different one makes it "name (2).ext", "(3)"…
 */
export async function putOnce(
  session: Runner,
  dir: string,
  name: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ path: string; id: string; size: number }> {
  const adapter = session.adapter;
  const hash = await adapter.hash(bytes);
  const same = (item: RemoteItem) => !item.folder && item.size === bytes.length && (!item.hash || item.hash === hash);
  for (let n = 1; n <= MAX_VERSIONS; n++) {
    const path = join(dir, versionName(name, n));
    const there = await session.run((t) => adapter.stat(t, path));
    if (there) {
      if (same(there)) return { path, id: there.id, size: there.size };
      continue;
    }
    const sent = await session.run((t) => adapter.upload(t, path, bytes, contentType));
    if (sent === "exists") {
      // Made by someone at the same moment: the same file, or the next name.
      const now = await session.run((t) => adapter.stat(t, path));
      if (now && same(now)) return { path, id: now.id, size: now.size };
      continue;
    }
    return { path, id: sent.id, size: sent.size || bytes.length };
  }
  throw new CloudError("other", `Too many files called ${name}`);
}

// ---------------------------------------------------------------- one conversation into the cloud

interface ExportData {
  conversation: { id: string; shop_id: string; started_at: string; pdf_path: string | null; pdf_name: string | null; deleted: boolean };
  shop: { name: string; timezone: string };
  connection: (Omit<Connection, "shop_id"> & { status: string }) | null;
  attachments: { id: string; name: string; kind: string; bytes: number; path: string }[];
  done: Record<string, string>;
}

async function download(deps: Deps, path: string): Promise<Uint8Array | null> {
  const { data, error } = await deps.db.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

async function stillThere(deps: Deps, id: string): Promise<boolean> {
  const { data } = await deps.db.from("assistant_conversations").select("shopper_deleted_at").eq("id", id).maybeSingle();
  return Boolean(data) && !(data as { shopper_deleted_at: string | null }).shopper_deleted_at;
}

/** Copies one conversation (it was claimed: status running); the result goes to the database. */
export async function exportConversation(deps: Deps, id: string): Promise<"done" | "failed" | "skipped"> {
  const { data: raw, error } = await deps.db.rpc("cloud_export_data", { p_id: id });
  if (error || !raw) return "skipped";
  const data = raw as ExportData;
  const shopId = data.conversation.shop_id;
  const finish = async (path: string | null, problem: string | null, retry = true, retryAfter: number | null = null) => {
    await deps.db.rpc("cloud_export_finish", { p_id: id, p_path: path, p_error: problem, p_retry: retry, p_retry_after: retryAfter });
  };
  if (data.conversation.deleted || !data.connection) {
    await finish(null, "Nie je čo uložiť", false);
    return "skipped";
  }
  try {
    if (!data.conversation.pdf_path) throw new CloudError("other", "The conversation has no PDF yet");
    const session = await Session.open(deps, { shop_id: shopId, ...data.connection });
    const folder = conversationFolder(data.connection.folder_path, data.conversation.started_at, data.shop.timezone, id);
    const items = [
      { key: "pdf", dir: folder, name: PDF_NAME, path: data.conversation.pdf_path, type: "application/pdf" },
      ...data.attachments.map((a) => ({
        key: a.id,
        dir: `${folder}/${FILES_DIR}`,
        name: cleanName(a.name),
        path: a.path,
        type: MIME[a.kind] ?? "application/octet-stream",
      })),
    ].filter((item) => !data.done[item.key]);
    if (items.length) {
      await ensureFolder(session, folder);
      if (items.some((i) => i.dir !== folder)) await ensureFolder(session, `${folder}/${FILES_DIR}`);
    }
    for (const item of items) {
      // The shopper may delete the conversation meanwhile: then nothing more is sent.
      if (!(await stillThere(deps, id))) return "skipped";
      const bytes = await download(deps, item.path);
      if (!bytes) throw new CloudError("other", "A file is missing in the archive");
      const sent = await putOnce(session, item.dir, item.name, bytes, item.type);
      await deps.db.rpc("cloud_export_item_done", {
        p_id: id,
        p_key: item.key,
        p_remote_path: sent.path,
        p_remote_id: sent.id,
        p_bytes: sent.size,
      });
    }
    await finish(folder, null);
    await deps.db.rpc("cloud_connection_result", { p_shop_id: shopId, p_error: null, p_expired: false });
    return "done";
  } catch (e) {
    const kind = e instanceof CloudError ? e.kind : "other";
    const message = kind === "expired"
      ? "Pripojenie k cloudu vypršalo – pripojte ho znova"
      : kind === "quota"
        ? "V cloude nie je miesto"
        : kind === "throttled"
          ? "Cloud je preťažený, skúsime to znova"
          : failText(e);
    console.error("cloud-export: copy failed", id, kind, message.slice(0, 160));
    await finish(null, message, true, e instanceof CloudError ? e.retryAfter : null);
    await deps.db.rpc("cloud_connection_result", { p_shop_id: shopId, p_error: message, p_expired: kind === "expired" });
    return "failed";
  }
}

/** Copies what is due, within the time budget. */
async function runDue(deps: Deps, only: string | null = null): Promise<{ done: number; failed: number }> {
  const started = deps.now();
  let done = 0;
  let failed = 0;
  while (deps.now() - started < TICK_BUDGET_MS) {
    const { data } = await deps.db.rpc("cloud_export_claim", { p_limit: only ? 1 : PER_TICK, p_id: only });
    const ids = (data ?? []) as string[];
    if (!ids.length) break;
    for (const id of ids) {
      const result = await exportConversation(deps, id);
      if (result === "done") done++;
      if (result === "failed") failed++;
    }
    if (only) break;
  }
  return { done, failed };
}

// ---------------------------------------------------------------- the 24-hour e-mail

interface Alert {
  shop_id: string;
  shop_name: string;
  shop_slug: string;
  timezone: string;
  provider: Provider;
  last_error: string | null;
  failing_since: string;
  site_url: string | null;
  emails: string[];
}

export const ALERT_SUBJECT = "Pripojenie k cloudu vypršalo – pripojte ho znova";

export function alertText(a: Alert): string {
  const p = zoneParts(a.failing_since, a.timezone);
  const link = a.site_url ? `${a.site_url.replace(/\/+$/, "")}/sk/dashboard?shop=${encodeURIComponent(a.shop_slug)}&at=cloud#cloud` : null;
  return [
    "Dobrý deň,",
    "",
    `konverzácie asistenta obchodu ${a.shop_name} sa od ${Number(p.day)}. ${Number(p.month)}. ${p.year} ${p.hour}:${p.minute} ` +
      `nedajú uložiť do ${PROVIDER_NAMES[a.provider] ?? a.provider}.`,
    a.last_error ? `Dôvod: ${a.last_error}` : "",
    "",
    "Pripojte cloud znova v Môj obchod → Cloudový priečinok" + (link ? `:\n${link}` : "."),
    "",
    "Konverzácie sa medzitým ukladajú v Cacadoo PPI a po pripojení sa do cloudu doplnia.",
    "",
    "Cacadoo PPI",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

async function sendAlerts(deps: Deps): Promise<number> {
  const { data } = await deps.db.rpc("cloud_alerts_due");
  const due = (data ?? []) as Alert[];
  if (!due.length) return 0;
  if (!deps.email) {
    console.error("cloud-export: alert e-mail not sent (BREVO_API_KEY or ALERT_EMAIL_FROM missing)");
    return 0;
  }
  let sent = 0;
  for (const alert of due) {
    if (!alert.emails.length) continue;
    const res = await deps.fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": deps.email.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { name: "Cacadoo PPI", email: deps.email.from },
        to: alert.emails.map((email) => ({ email })),
        subject: ALERT_SUBJECT,
        textContent: alertText(alert),
      }),
    }).catch(() => null);
    if (res?.ok) {
      await deps.db.rpc("cloud_alert_sent", { p_shop_id: alert.shop_id });
      sent++;
    } else {
      console.error("cloud-export: alert e-mail failed", res?.status ?? "network");
    }
  }
  return sent;
}

// ---------------------------------------------------------------- owners

async function owner(req: Request, deps: Deps): Promise<{ authorization: string; userId: string } | null> {
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data } = await deps.asCaller(authorization).auth.getUser(token);
  return data?.user ? { authorization, userId: data.user.id } : null;
}

async function member(deps: Deps, authorization: string, shopId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(shopId)) return false;
  const { data } = await deps.asCaller(authorization).rpc("is_shop_member", { p_shop_id: shopId });
  return data === true;
}

async function connect(deps: Deps, who: { authorization: string; userId: string }, body: Json) {
  const shopId = String(body.shop_id ?? "");
  const provider = String(body.provider ?? "") as Provider;
  const adapter = deps.adapters[provider];
  if (!PROVIDERS.includes(provider) || !adapter) return reply(400, { error: "bad_request" });
  if (!(await member(deps, who.authorization, shopId))) return reply(403, { error: "not_member" });
  const { data: plan } = await deps.asCaller(who.authorization).rpc("shop_has_plan", { p_shop_id: shopId });
  if (plan !== true) return reply(403, { error: "no_plan" });
  if (!adapter.configured()) return reply(503, { error: "not_configured" });
  if (!deps.tokenSecret) return reply(503, { error: "not_configured" });
  const folderText = String(body.folder ?? "").trim();
  if (folderText && isShareLink(folderText)) return reply(400, { error: "share_link" });
  const { data: shop } = await deps.db.from("shops").select("name").eq("id", shopId).maybeSingle();
  const folder = folderText ? cleanFolderPath(folderText) : defaultFolder(String((shop as { name?: string } | null)?.name ?? "Obchod"));
  if (!folder) return reply(400, { error: "folder" });
  const returnUrl = String(body.return_url ?? "");
  if (!/^https?:\/\/[^/]+\/[a-z]{2}\/dashboard\?/.test(returnUrl) || returnUrl.length > 500) return reply(400, { error: "bad_request" });

  const state = b64url(random(32));
  const verifier = b64url(random(48));
  const { error } = await deps.db.rpc("cloud_state_save", {
    p_state_hash: await sha256Hex(state),
    p_shop_id: shopId,
    p_provider: provider,
    p_user_id: who.userId,
    p_verifier: verifier,
    p_folder: folder,
    p_return_url: returnUrl,
  });
  if (error) return reply(500, { error: "failed" });
  return reply(200, {
    url: adapter.authorizeUrl({ state, challenge: await pkceChallenge(verifier), redirectUri: deps.redirectBase + provider }),
  });
}

/** The page shown when the provider sends the owner back with something wrong and no way home. */
function errorPage(text: string) {
  return new Response(
    `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Cacadoo PPI</title></head><body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.25rem">Pripojenie cloudu sa nepodarilo</h1><p>${text}</p></body></html>`,
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
}

const backTo = (url: string, query: string) => {
  const [base] = url.split("#");
  return new Response(null, {
    status: 302,
    headers: { Location: `${base}${base.includes("?") ? "&" : "?"}${query}#cloud`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
};

/** GET …/oauth/<provider>?code=&state=: the provider's answer. */
async function callback(req: Request, deps: Deps, provider: Provider): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  if (!state) return errorPage("Odkaz nie je platný. Zatvorte toto okno a skúste to znova v Môj obchod → Cloudový priečinok.");
  const { data: taken } = await deps.db.rpc("cloud_state_take", { p_state_hash: await sha256Hex(state) });
  const st = taken as { shop_id: string; provider: Provider; user_id: string; verifier: string; folder_path: string; return_url: string } | null;
  if (!st || st.provider !== provider) {
    return errorPage("Odkaz vypršal alebo už bol použitý. Zatvorte toto okno a skúste to znova v Môj obchod → Cloudový priečinok.");
  }
  if (url.searchParams.get("error") || !url.searchParams.get("code")) return backTo(st.return_url, "err=cloud_denied");
  const adapter = deps.adapters[provider];
  try {
    if (!deps.tokenSecret || !adapter.configured()) throw new CloudError("other", "not set up");
    const t = await adapter.exchange(url.searchParams.get("code")!, st.verifier, deps.redirectBase + provider);
    if (!t.refresh) throw new CloudError("other", "no refresh token");
    const key = await tokenKey(deps.tokenSecret);
    const access = await encryptToken(key, t.access, bind(st.shop_id, provider, "access"));
    const refresh = await encryptToken(key, t.refresh, bind(st.shop_id, provider, "refresh"));
    const who = await adapter.account(t.access).catch(() => ({ name: null, email: null }));
    await ensureFolder({ adapter, run: (work) => work(t.access) }, st.folder_path);
    const { error } = await deps.db.rpc("cloud_connection_save", {
      p_shop_id: st.shop_id,
      p_provider: provider,
      p_account_name: who.name,
      p_account_email: who.email,
      p_folder: st.folder_path,
      p_access_enc: access,
      p_refresh_enc: refresh,
      p_expires_at: t.expiresAt,
      p_scope: t.scope,
      p_site_url: new URL(st.return_url).origin,
      p_user_id: st.user_id,
    });
    if (error) throw new Error(error.message);
    // Copies that were waiting go now.
    deps.background(runDue(deps));
    return backTo(st.return_url, "ok=cloud_connected");
  } catch (e) {
    console.error("cloud-export: connect failed", provider, e instanceof CloudError ? e.kind : "other", failText(e).slice(0, 120));
    return backTo(st.return_url, e instanceof CloudError && e.kind === "not_folder" ? "err=cloud_folder" : "err=cloud_failed");
  }
}

async function withSession<T>(deps: Deps, shopId: string, work: (session: Session) => Promise<T>): Promise<T | Response> {
  const connection = await connectionOf(deps, shopId);
  if (!connection) return reply(409, { error: "no_cloud" });
  try {
    return await work(await Session.open(deps, connection));
  } catch (e) {
    if (e instanceof CloudError) {
      if (e.kind === "expired") {
        await deps.db.rpc("cloud_connection_result", { p_shop_id: shopId, p_error: ALERT_SUBJECT, p_expired: true });
        return reply(409, { error: "expired" });
      }
      if (e.kind === "not_folder") return reply(409, { error: "not_folder" });
    }
    console.error("cloud-export: owner action failed", failText(e).slice(0, 160));
    return reply(502, { error: "cloud" });
  }
}

async function ownerAction(action: string, req: Request, deps: Deps, body: Json): Promise<Response> {
  const who = await owner(req, deps);
  if (!who) return reply(401, { error: "login" });
  if (action === "connect") return await connect(deps, who, body);

  if (action === "retry") {
    const id = String(body.conversation_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply(400, { error: "bad_request" });
    const { data, error } = await deps.asCaller(who.authorization).rpc("owner_cloud_retry", { p_conversation_id: id });
    if (error?.code === "42501") return reply(403, { error: "not_member" });
    if (error) return reply(error.message === "no_cloud" ? 409 : 500, { error: error.message === "no_cloud" ? "no_cloud" : "failed" });
    if (data === true) deps.background(runDue(deps, id));
    return reply(200, { queued: data === true });
  }

  const shopId = String(body.shop_id ?? "");
  if (!(await member(deps, who.authorization, shopId))) return reply(403, { error: "not_member" });

  if (action === "backfill") {
    const { data, error } = await deps.asCaller(who.authorization).rpc("owner_cloud_backfill", {
      p_shop_id: shopId,
      p_from: String(body.from ?? ""),
      p_to: String(body.to ?? ""),
    });
    if (error) return reply(error.message === "no_cloud" ? 409 : 400, { error: error.message === "no_cloud" ? "no_cloud" : "period" });
    if (Number(data) > 0) deps.background(runDue(deps));
    return reply(200, { count: Number(data ?? 0) });
  }

  if (action === "disconnect") {
    const connection = await connectionOf(deps, shopId);
    if (connection && deps.tokenSecret) {
      // Dropbox can revoke our token; Microsoft cannot (the owner removes the app in their account).
      const opened = await Session.open(deps, connection).catch(() => null);
      if (opened) await opened.revoke();
    }
    const { data } = await deps.db.rpc("cloud_disconnect", { p_shop_id: shopId });
    return reply(200, { disconnected: data === true });
  }

  if (action === "folders") {
    const path = body.path === "/" ? "/" : cleanFolderPath(String(body.path ?? ""));
    if (!path) return reply(400, { error: "folder" });
    const result = await withSession(deps, shopId, (s) => s.run((t) => s.adapter.listFolders(t, path)));
    return result instanceof Response ? result : reply(200, { path, folders: result });
  }

  if (action === "create_folder") {
    const parent = body.path === "/" ? "/" : cleanFolderPath(String(body.path ?? ""));
    const name = cleanName(String(body.name ?? ""));
    if (!parent || !String(body.name ?? "").trim()) return reply(400, { error: "folder" });
    const path = join(parent, name);
    const result = await withSession(deps, shopId, (s) => ensureFolder(s, path));
    return result instanceof Response ? result : reply(200, { path });
  }

  if (action === "set_folder") {
    const text = String(body.path ?? "").trim();
    if (isShareLink(text)) return reply(400, { error: "share_link" });
    const path = cleanFolderPath(text);
    if (!path) return reply(400, { error: "folder" });
    const result = await withSession(deps, shopId, async (s) => {
      await ensureFolder(s, path);
      await deps.db.rpc("cloud_set_folder", { p_shop_id: shopId, p_folder: path });
    });
    return result instanceof Response ? result : reply(200, { path });
  }

  return reply(400, { error: "bad_request" });
}

// ---------------------------------------------------------------- the entry point

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const oauth = /\/oauth\/(onedrive|dropbox)\/?$/.exec(url.pathname);
  if (oauth) {
    if (req.method !== "GET") return reply(405, { error: "method" });
    return await callback(req, deps, oauth[1] as Provider);
  }
  if (req.method !== "POST") return reply(405, { error: "method" });

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
      if (action !== "tick") return reply(400, { error: "bad_request" });
      const copies = await runDue(deps);
      const alerts = await sendAlerts(deps);
      return reply(200, { ...copies, alerts });
    }
    if (action === "export") {
      const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!sameSecret(bearer, deps.serviceKey)) return reply(401, { error: "secret" });
      const id = String(body.conversation_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return reply(400, { error: "bad_request" });
      deps.background(runDue(deps, id));
      return reply(202, { queued: true });
    }
    return await ownerAction(action, req, deps, body);
  } catch (e) {
    console.error("cloud-export:", action, failText(e).slice(0, 160));
    return reply(500, { error: "failed" });
  }
}

export async function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return reply(500, { error: "config" });
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const brevo = Deno.env.get("BREVO_API_KEY")?.trim();
  const from = Deno.env.get("ALERT_EMAIL_FROM")?.trim();
  return await handle(req, {
    db: createClient(url, serviceKey, options),
    asCaller: (authorization) => createClient(url, anonKey, { ...options, global: { headers: { Authorization: authorization } } }),
    adapters: {
      onedrive: oneDrive({ clientId: Deno.env.get("ONEDRIVE_CLIENT_ID")?.trim(), clientSecret: Deno.env.get("ONEDRIVE_CLIENT_SECRET")?.trim() }),
      dropbox: dropbox({ appKey: Deno.env.get("DROPBOX_APP_KEY")?.trim(), appSecret: Deno.env.get("DROPBOX_APP_SECRET")?.trim() }),
    },
    tokenSecret: Deno.env.get("EXPORT_TOKEN_ENCRYPTION_KEY")?.trim() || null,
    serviceKey,
    redirectBase: `${url.replace(/\/+$/, "")}/functions/v1/cloud-export/oauth/`,
    email: brevo && from ? { apiKey: brevo, from } : null,
    fetch,
    background: (task) => (runtime ? runtime.waitUntil(task) : void task),
    now: () => Date.now(),
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
