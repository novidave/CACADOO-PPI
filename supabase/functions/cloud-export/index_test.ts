// Unit tests of cloud-export: tokens encrypted, OneDrive and Dropbox against in-memory stand-ins
// (OAuth, token refresh, folders, never overwriting or deleting), the folder per conversation,
// copies that are idempotent and retried, statuses, owners only, the 24-hour e-mail.
// Run: npm run test:functions
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  ALERT_SUBJECT,
  alertText,
  cleanFolderPath,
  cleanName,
  CloudError,
  conversationFolder,
  decryptToken,
  type Deps,
  dropbox,
  dropboxArg,
  dropboxContentHash,
  encryptToken,
  exportConversation,
  handle,
  isShareLink,
  oneDrive,
  pkceChallenge,
  type Provider,
  quickXorHash,
  sha256Hex,
  tokenKey,
  versionName,
} from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
}

async function rejects(work: () => Promise<unknown>, check: (e: unknown) => boolean, label: string) {
  try {
    await work();
  } catch (e) {
    if (check(e)) return;
    throw new Error(`${label}: wrong error ${e instanceof Error ? e.message : e}`);
  }
  throw new Error(`${label}: no error`);
}

const SHOP = "11111111-2222-4333-8444-555555555555";
const OTHER_SHOP = "99999999-2222-4333-8444-555555555555";
const CONV = "3f2a9c1b-7d4e-4a5b-9c6d-0e1f2a3b4c5d";
const IMG = "aaaaaaaa-0000-4000-8000-000000000001";
const DOC = "aaaaaaaa-0000-4000-8000-000000000002";
const SECRET = "token-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const SERVICE_KEY = "service-role-key-0123456789abcdefghijklmnop";
const CRON = "cron-secret-0123456789abcdef0123456789abcdef";
const enc = new TextEncoder();
const bytesOf = (n: number, a: number, s: number) => Uint8Array.from({ length: n }, (_, i) => (i * a + (i >> s)) & 255);

// ---------------------------------------------------------------- tokens, PKCE, hashes

Deno.test("Tokens are encrypted, bound to their shop and use, and refuse to open when changed", async () => {
  const key = await tokenKey(SECRET);
  const sealed = await encryptToken(key, "access-token-value", `${SHOP}:onedrive:access`);
  assert(sealed.startsWith("v1.") && !sealed.includes("access-token-value"), "not readable");
  eq(await decryptToken(key, sealed, `${SHOP}:onedrive:access`), "access-token-value", "opens");
  assert((await encryptToken(key, "access-token-value", `${SHOP}:onedrive:access`)) !== sealed, "a new IV every time");
  await rejects(() => decryptToken(key, sealed, `${OTHER_SHOP}:onedrive:access`), () => true, "another shop's row");
  await rejects(() => decryptToken(key, sealed, `${SHOP}:onedrive:refresh`), () => true, "the other token's place");
  const parts = sealed.split(".");
  const flipped = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}${parts[2].endsWith("A") ? "B" : "A"}${parts[2].slice(-1)}`;
  await rejects(() => decryptToken(key, flipped, `${SHOP}:onedrive:access`), () => true, "changed");
  const otherKey = await tokenKey(SECRET + "x");
  await rejects(() => decryptToken(otherKey, sealed, `${SHOP}:onedrive:access`), () => true, "another key");
  await rejects(() => tokenKey("short"), (e) => /32 characters/.test(String(e)), "short secret");
});

Deno.test("PKCE: the RFC 7636 example", async () => {
  eq(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "S256");
});

Deno.test("File hashes match OneDrive's QuickXorHash and Dropbox's content hash", async () => {
  // Reference values from Microsoft's algorithm (C port) and the official Dropbox SDK hasher.
  eq(quickXorHash(new Uint8Array()), "AAAAAAAAAAAAAAAAAAAAAAAAAAA=", "empty");
  eq(quickXorHash(enc.encode("Hello, world!")), "SCgDG9jwBhaA4A5vnQMbyBACAAA=", "text");
  eq(quickXorHash(bytesOf(1_000_003, 31, 8)), "3MbzMH4uQ3IiKUAOJPtAF+E0+D8=", "1 MB");
  eq(await dropboxContentHash(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "empty");
  eq(await dropboxContentHash(enc.encode("Hello, world!")), "6246efc88ae4aa025e48c9c7adc723d5c97171a1fa6233623c7251ab8e57602f", "text");
  eq(await dropboxContentHash(bytesOf(9 * 1024 * 1024 + 5, 7, 12)), "0478160b0e96f0bede78cadb475a2d2f87a2053beea2f787b8a2bca071c6b826",
    "3 blocks of 4 MiB");
});

// ---------------------------------------------------------------- names and folders

Deno.test("Names and folders: cleaned for both clouds; links and climbing up refused", () => {
  eq(cleanName('ponuka: "č. 12"?.pdf'), "ponuka_ _č. 12__.pdf", "reserved characters");
  eq(cleanName("  ../plot  ..."), ".._plot", "no path, no trailing dots or spaces");
  eq(cleanName("CON.txt"), "_CON.txt", "reserved Windows names");
  eq(cleanName(""), "subor", "never empty");
  eq(cleanFolderPath("/Cacadoo/Potraviny Centrum"), "/Cacadoo/Potraviny Centrum", "as written");
  eq(cleanFolderPath("Cacadoo//Obchod: Košice/"), "/Cacadoo/Obchod_ Košice", "made a clean path");
  eq(cleanFolderPath("/Cacadoo/../Dokumenty"), null, "never climbs up");
  eq(cleanFolderPath("https://1drv.ms/f/s!AbCdEf"), null, "a share link is not a folder");
  assert(isShareLink("https://www.dropbox.com/scl/fo/abc/xyz?rlkey=1") && isShareLink("onedrive.live.com/?id=1") &&
    !isShareLink("/Cacadoo/Obchod"), "share links");
  eq(versionName("konverzacia.pdf", 2), "konverzacia (2).pdf", "suffix before the extension");
  eq(versionName("README", 3), "README (3)", "without an extension");
  eq(conversationFolder("/Cacadoo/Potraviny Centrum", "2026-10-10T12:05:00Z", "Europe/Bratislava", CONV),
    "/Cacadoo/Potraviny Centrum/2026-10/2026-10-10_14-05_3f2a9c1b", "month and conversation in the shop's time zone");
  eq(conversationFolder("/C", "2026-10-31T23:30:00Z", "Europe/Athens", CONV), "/C/2026-11/2026-11-01_01-30_3f2a9c1b", "next month there");
  eq(dropboxArg({ path: "/Cacadoo/Potraviny Čierna" }), '{"path":"/Cacadoo/Potraviny \\u010cierna"}', "Dropbox header is ASCII");
});

// ---------------------------------------------------------------- the clouds: in-memory stand-ins

interface Stored {
  bytes: Uint8Array;
  id: string;
}

/** A OneDrive and Dropbox stand-in: files and folders in memory, tokens, every request logged. */
function fakeClouds() {
  const log: string[] = [];
  const files = new Map<string, Stored>(); // "/path" (lowercase for Dropbox) → file
  const folders = new Set<string>(["/"]);
  const tokens = { onedrive: new Set<string>(["od-access-1"]), dropbox: new Set<string>(["db-access-1"]) };
  const refresh = { onedrive: "od-refresh-1", dropbox: "db-refresh-1" };
  let n = 0;
  let throttle = 0;
  const id = () => `item-${++n}`;
  const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
  const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

  async function onedriveGraph(req: Request, url: URL): Promise<Response> {
    const auth = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    if (!tokens.onedrive.has(auth)) return json(401, { error: { code: "InvalidAuthenticationToken" } });
    if (throttle > 0) {
      throttle--;
      return json(429, { error: { code: "tooManyRequests" } }, { "Retry-After": "120" });
    }
    const path = decodeURIComponent(url.pathname.replace("/v1.0/me/drive", ""));
    if (path === "" && req.method === "GET") return json(200, { owner: { user: { displayName: "Ján Novák", email: "jan@example.invalid" } } });
    // root:/a/b , root:/a/b:/children , root:/a/b:/content , root/children
    const m = /^\/root(?::(\/[^:]*))?(?::?\/(children|content))?$/.exec(path);
    if (!m) return json(400, { error: { code: "invalidRequest" } });
    const target = m[1] ?? "/";
    const what = m[2];
    if (!what && req.method === "GET") {
      if (folders.has(target)) return json(200, { id: `folder:${target}`, name: target, folder: { childCount: 0 } });
      const f = files.get(target);
      return f ? json(200, { id: f.id, size: f.bytes.length, file: { hashes: { quickXorHash: quickXorHash(f.bytes) } } })
        : json(404, { error: { code: "itemNotFound" } });
    }
    if (what === "children" && req.method === "GET") {
      if (!folders.has(target)) return json(404, { error: { code: "itemNotFound" } });
      const kids = [...folders].filter((f) => f !== "/" && parent(f) === target).map((f) => ({ name: f.slice(f.lastIndexOf("/") + 1), folder: {} }));
      return json(200, { value: kids });
    }
    if (what === "children" && req.method === "POST") {
      const b = await req.json();
      assert(b["@microsoft.graph.conflictBehavior"] === "fail", "folders never replace anything");
      if (!folders.has(target)) return json(404, { error: { code: "itemNotFound" } });
      const path2 = (target === "/" ? "" : target) + "/" + b.name;
      if (folders.has(path2) || files.has(path2)) return json(409, { error: { code: "nameAlreadyExists" } });
      folders.add(path2);
      log.push(`onedrive mkdir ${path2}`);
      return json(201, { id: id(), name: b.name, folder: {} });
    }
    if (what === "content" && req.method === "PUT") {
      assert(url.searchParams.get("@microsoft.graph.conflictBehavior") === "fail", "uploads never replace anything");
      if (!folders.has(parent(target))) return json(404, { error: { code: "itemNotFound" } });
      if (files.has(target) || folders.has(target)) {
        log.push(`onedrive refused ${target}`);
        return json(409, { error: { code: "nameAlreadyExists" } });
      }
      const bytes = new Uint8Array(await req.arrayBuffer());
      const f = { bytes, id: id() };
      files.set(target, f);
      log.push(`onedrive put ${target} ${bytes.length}`);
      return json(201, { id: f.id, size: bytes.length, file: { hashes: { quickXorHash: quickXorHash(bytes) } } });
    }
    return json(405, { error: { code: "notSupported" } });
  }

  const dbxKey = (p: string) => p.toLowerCase();
  async function dropboxApi(req: Request, url: URL): Promise<Response> {
    const auth = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    if (url.pathname === "/oauth2/token") return token(req, "dropbox");
    if (!tokens.dropbox.has(auth)) return json(401, { error_summary: "expired_access_token/" });
    if (throttle > 0) {
      throttle--;
      return json(429, { error_summary: "too_many_requests/" }, { "Retry-After": "60" });
    }
    if (url.pathname === "/2/users/get_current_account") return json(200, { name: { display_name: "Ján" }, email: "jan@example.invalid" });
    if (url.pathname === "/2/auth/token/revoke") {
      tokens.dropbox.delete(auth);
      log.push("dropbox revoke");
      return new Response("null", { status: 200 });
    }
    if (url.hostname === "content.dropboxapi.com" && url.pathname === "/2/files/upload") {
      const raw = req.headers.get("Dropbox-API-Arg") ?? "";
      assert(/^[\x20-\x7e]*$/.test(raw), "the header is ASCII");
      const arg = JSON.parse(raw);
      assert(arg.mode === "add" && arg.autorename === false && arg.strict_conflict === true, "uploads never replace anything");
      const key = dbxKey(arg.path);
      if (!folders.has(dbxKey(parent(arg.path)))) return json(409, { error_summary: "path/not_found/" });
      if (files.has(key) || folders.has(key)) {
        log.push(`dropbox refused ${arg.path}`);
        return json(409, { error_summary: "path/conflict/file/" });
      }
      const bytes = new Uint8Array(await req.arrayBuffer());
      const f = { bytes, id: `id:${id()}` };
      files.set(key, f);
      log.push(`dropbox put ${arg.path} ${bytes.length}`);
      return json(200, { ".tag": "file", id: f.id, size: bytes.length, content_hash: await dropboxContentHash(bytes) });
    }
    const b = await req.json().catch(() => ({}));
    if (url.pathname === "/2/files/get_metadata") {
      const key = dbxKey(b.path);
      if (folders.has(key)) return json(200, { ".tag": "folder", id: `folder:${key}` });
      const f = files.get(key);
      return f ? json(200, { ".tag": "file", id: f.id, size: f.bytes.length, content_hash: await dropboxContentHash(f.bytes) })
        : json(409, { error_summary: "path/not_found/.." });
    }
    if (url.pathname === "/2/files/list_folder") {
      const key = b.path === "" ? "/" : dbxKey(b.path);
      if (!folders.has(key)) return json(409, { error_summary: "path/not_found/" });
      const kids = [...folders].filter((f) => f !== "/" && parent(f) === key).map((f) => ({ ".tag": "folder", name: f.slice(f.lastIndexOf("/") + 1) }));
      return json(200, { entries: kids, has_more: false, cursor: "c" });
    }
    if (url.pathname === "/2/files/create_folder_v2") {
      assert(b.autorename === false, "folders never renamed");
      const key = dbxKey(b.path);
      if (folders.has(key)) return json(409, { error_summary: "path/conflict/folder/" });
      if (files.has(key)) return json(409, { error_summary: "path/conflict/file/" });
      if (!folders.has(dbxKey(parent(b.path)))) return json(409, { error_summary: "path/not_found/" });
      folders.add(key);
      log.push(`dropbox mkdir ${b.path}`);
      return json(200, { metadata: { name: b.path } });
    }
    return json(400, { error_summary: "unknown/" });
  }

  async function token(req: Request, provider: Provider): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const secretOk = provider === "onedrive" ? form.get("client_secret") === "od-secret" : form.get("client_secret") === "db-secret";
    if (!secretOk) return json(401, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code") {
      if (form.get("code") !== `${provider}-code` || !form.get("code_verifier")) return json(400, { error: "invalid_grant" });
      log.push(`${provider} token code verifier=${form.get("code_verifier")?.length}`);
      tokens[provider].add(`${provider}-access-new`);
      return json(200, { access_token: `${provider}-access-new`, refresh_token: `${provider}-refresh-new`, expires_in: 3600, scope: "x" });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (form.get("refresh_token") !== refresh[provider]) return json(400, { error: "invalid_grant" });
      const access = `${provider}-access-${++n}`;
      tokens[provider].add(access);
      log.push(`${provider} refresh`);
      return json(200, provider === "onedrive"
        ? { access_token: access, refresh_token: "od-refresh-rotated", expires_in: 3600 }
        : { access_token: access, expires_in: 14400 });
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  const brevo: { body: Record<string, unknown>; key: string | null }[] = [];
  const fetchFake: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (req.method === "DELETE") throw new Error(`a DELETE was sent: ${url}`);
    if (url.hostname === "login.microsoftonline.com") return token(req, "onedrive");
    if (url.hostname === "graph.microsoft.com") return onedriveGraph(req, url);
    if (url.hostname.endsWith("dropboxapi.com")) {
      if (/delete|move|copy/.test(url.pathname)) throw new Error(`a destructive call was sent: ${url}`);
      return dropboxApi(req, url);
    }
    if (url.hostname === "api.brevo.com") {
      brevo.push({ body: await req.json(), key: req.headers.get("api-key") });
      return json(201, { messageId: "m1" });
    }
    throw new Error(`unexpected request ${url}`);
  };
  return {
    log,
    files,
    folders,
    tokens,
    refresh,
    brevo,
    fetch: fetchFake,
    throttleNext: (k: number) => (throttle = k),
  };
}

const adaptersFor = (f: typeof fetch) => ({
  onedrive: oneDrive({ clientId: "od-client", clientSecret: "od-secret" }, f),
  dropbox: dropbox({ appKey: "db-key", appSecret: "db-secret" }, f),
});

Deno.test("OneDrive: consent URL with the narrowest scope and PKCE; folders and files never replaced; errors", async () => {
  const cloud = fakeClouds();
  const od = adaptersFor(cloud.fetch).onedrive;
  const url = new URL(od.authorizeUrl({ state: "s1", challenge: "c1", redirectUri: "https://p.supabase.co/functions/v1/cloud-export/oauth/onedrive" }));
  eq([url.host, url.searchParams.get("scope"), url.searchParams.get("code_challenge_method"), url.searchParams.get("state"),
    url.searchParams.get("response_type")], ["login.microsoftonline.com", "offline_access Files.ReadWrite", "S256", "s1", "code"], "consent URL");
  const t = await od.exchange("onedrive-code", "v".repeat(64), "https://x/oauth/onedrive");
  eq([t.access, t.refresh], ["onedrive-access-new", "onedrive-refresh-new"], "tokens from the code");
  await rejects(() => od.exchange("wrong", "v", "https://x"), (e) => e instanceof CloudError && e.kind === "expired", "a bad code");
  await rejects(() => od.refresh("old"), (e) => e instanceof CloudError && e.kind === "expired", "a refresh token no longer valid");
  eq((await od.refresh("od-refresh-1")).refresh, "od-refresh-rotated", "Microsoft rotates refresh tokens");
  await rejects(() => oneDrive({ clientId: "od-client", clientSecret: "wrong" }, cloud.fetch).refresh("od-refresh-1"),
    (e) => e instanceof CloudError && e.kind === "other", "a wrong app secret is not the owner's expired connection");

  const tk = "od-access-1";
  eq(await od.createFolder(tk, "/Cacadoo"), "created", "mkdir");
  eq(await od.createFolder(tk, "/Cacadoo"), "exists", "mkdir again");
  eq(await od.createFolder(tk, "/Cacadoo/Obchod Košice #1"), "created", "special characters");
  eq(await od.listFolders(tk, "/Cacadoo"), ["Obchod Košice #1"], "folders");
  const first = await od.upload(tk, "/Cacadoo/a.pdf", enc.encode("first"), "application/pdf");
  assert(first !== "exists" && first.size === 5 && first.hash === quickXorHash(enc.encode("first")), "uploaded");
  eq(await od.upload(tk, "/Cacadoo/a.pdf", enc.encode("second"), "application/pdf"), "exists", "never replaced");
  eq(new TextDecoder().decode(cloud.files.get("/Cacadoo/a.pdf")!.bytes), "first", "the first file stays");
  eq((await od.stat(tk, "/Cacadoo/a.pdf"))?.size, 5, "stat");
  eq(await od.stat(tk, "/Cacadoo/none.pdf"), null, "missing");
  eq((await od.stat(tk, "/Cacadoo"))?.folder, true, "a folder");
  await rejects(() => od.stat("expired", "/Cacadoo"), (e) => e instanceof CloudError && e.kind === "auth", "401 → renew");
  cloud.throttleNext(1);
  await rejects(() => od.stat(tk, "/Cacadoo"), (e) => e instanceof CloudError && e.kind === "throttled" && e.retryAfter === 120, "429");
  eq((await od.account(tk)).name, "Ján Novák", "account");
});

Deno.test("Dropbox: consent URL with offline access, scopes and PKCE; never replaced; revoke", async () => {
  const cloud = fakeClouds();
  const db = adaptersFor(cloud.fetch).dropbox;
  const url = new URL(db.authorizeUrl({ state: "s1", challenge: "c1", redirectUri: "https://x/oauth/dropbox" }));
  eq([url.host, url.searchParams.get("token_access_type"), url.searchParams.get("scope"), url.searchParams.get("code_challenge_method")],
    ["www.dropbox.com", "offline", "files.metadata.read files.content.write account_info.read", "S256"], "consent URL");
  const t = await db.exchange("dropbox-code", "v".repeat(64), "https://x/oauth/dropbox");
  eq(t.refresh, "dropbox-refresh-new", "refresh token");
  eq((await db.refresh("db-refresh-1")).refresh, "db-refresh-1", "Dropbox keeps the refresh token");
  const tk = "db-access-1";
  eq(await db.createFolder(tk, "/Cacadoo"), "created", "mkdir");
  eq(await db.createFolder(tk, "/cacadoo"), "exists", "case does not matter");
  eq(await db.createFolder(tk, "/Cacadoo/Potraviny Čierna"), "created", "diacritics");
  const sent = await db.upload(tk, "/Cacadoo/Potraviny Čierna/štítok.jpg", enc.encode("jpeg"), "image/jpeg");
  assert(sent !== "exists" && sent.hash === (await dropboxContentHash(enc.encode("jpeg"))), "uploaded with its hash");
  eq(await db.upload(tk, "/Cacadoo/Potraviny Čierna/štítok.jpg", enc.encode("other"), "image/jpeg"), "exists", "never replaced");
  eq(await db.listFolders(tk, "/"), ["cacadoo"], "folders at the top");
  eq(await db.stat(tk, "/Cacadoo/none"), null, "missing");
  await rejects(() => db.listFolders(tk, "/Nowhere"), (e) => e instanceof CloudError && e.kind === "not_folder", "no such folder");
  await db.revoke(tk);
  assert(cloud.log.includes("dropbox revoke"), "token revoked");
  await rejects(() => db.stat(tk, "/Cacadoo"), (e) => e instanceof CloudError && e.kind === "auth", "revoked token");
});

// ---------------------------------------------------------------- the function: fakes for Supabase

type Result = { data: unknown; error: { message: string; code?: string } | null };
const ok = (data: unknown): Result => ({ data, error: null });

interface World {
  provider?: Provider;
  connection?: Record<string, unknown> | null;
  deleted?: boolean;
  member?: boolean;
  plan?: boolean;
  claims?: string[][];
  done?: Record<string, string>;
  alerts?: unknown[];
  storage?: Map<string, Uint8Array>;
  email?: boolean;
  deleteAfter?: number;
  ownerRpc?: (name: string, args: Record<string, unknown>) => Result;
}

async function connection(provider: Provider, extra: Record<string, unknown> = {}) {
  const key = await tokenKey(SECRET);
  return {
    shop_id: SHOP,
    provider,
    folder_path: "/Cacadoo/Potraviny Centrum",
    access_token_enc: await encryptToken(key, provider === "onedrive" ? "od-access-1" : "db-access-1", `${SHOP}:${provider}:access`),
    refresh_token_enc: await encryptToken(key, provider === "onedrive" ? "od-refresh-1" : "db-refresh-1", `${SHOP}:${provider}:refresh`),
    access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    status: "ok",
    ...extra,
  };
}

const PDF = enc.encode("%PDF-1.7 conversation");
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]);
const OFFER = enc.encode("%PDF-1.4 offer");

function fakes(cloud: ReturnType<typeof fakeClouds>, world: World) {
  const log: string[] = [];
  const tasks: Promise<unknown>[] = [];
  const storage = world.storage ?? new Map<string, Uint8Array>([
    [`${SHOP}/${CONV}/2026-10-10_14-05_3f2a9c1b.pdf`, PDF],
    [`${SHOP}/${CONV}/files/${IMG}.jpg`, JPG],
    [`${SHOP}/${CONV}/files/${DOC}.pdf`, OFFER],
  ]);
  const done: Record<string, string> = { ...(world.done ?? {}) };
  const claims = [...(world.claims ?? [])];
  let deletedChecks = 0;
  const exportData = () => ({
    conversation: {
      id: CONV,
      shop_id: SHOP,
      started_at: "2026-10-10T12:05:00Z",
      pdf_path: `${SHOP}/${CONV}/2026-10-10_14-05_3f2a9c1b.pdf`,
      pdf_name: "2026-10-10_14-05_3f2a9c1b.pdf",
      deleted: Boolean(world.deleted),
    },
    shop: { name: "Potraviny Centrum", timezone: "Europe/Bratislava" },
    connection: world.connection === undefined ? null : world.connection,
    attachments: [
      { id: IMG, name: "IMG_0042.jpg", kind: "jpeg", bytes: JPG.length, path: `${SHOP}/${CONV}/files/${IMG}.jpg` },
      { id: DOC, name: "ponuka: č.12?.pdf", kind: "pdf", bytes: OFFER.length, path: `${SHOP}/${CONV}/files/${DOC}.pdf` },
    ],
    done,
  });
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      log.push(`rpc ${name} ${JSON.stringify(args)}`);
      if (name === "cloud_export_data") return Promise.resolve(ok(exportData()));
      if (name === "cloud_export_claim") return Promise.resolve(ok(claims.shift() ?? []));
      if (name === "cloud_export_item_done") done[String(args.p_key)] = String(args.p_remote_path);
      if (name === "assistant_cron_ok") return Promise.resolve(ok(args.p_secret === CRON));
      if (name === "cloud_alerts_due") return Promise.resolve(ok(world.alerts ?? []));
      if (name === "cloud_state_take") {
        const st = states.get(String(args.p_state_hash));
        states.delete(String(args.p_state_hash));
        return Promise.resolve(ok(st ?? null));
      }
      if (name === "cloud_state_save") {
        states.set(String(args.p_state_hash), {
          shop_id: args.p_shop_id,
          provider: args.p_provider,
          user_id: args.p_user_id,
          verifier: args.p_verifier,
          folder_path: args.p_folder,
          return_url: args.p_return_url,
        });
      }
      if (name === "cloud_disconnect") return Promise.resolve(ok(true));
      return Promise.resolve(ok(null));
    },
    from: (table: string) => ({
      select: () => ({
        eq: (_c: string, value: string) => ({
          maybeSingle: () => {
            if (table === "cloud_connections") return Promise.resolve(ok(value === SHOP ? world.connection ?? null : null));
            if (table === "shops") return Promise.resolve(ok({ name: "Potraviny Centrum" }));
            if (table === "assistant_conversations") {
              deletedChecks++;
              const gone = world.deleteAfter !== undefined && deletedChecks > world.deleteAfter;
              return Promise.resolve(ok({ shopper_deleted_at: gone ? new Date().toISOString() : null }));
            }
            return Promise.resolve(ok(null));
          },
        }),
      }),
    }),
    storage: {
      from: (_bucket: string) => ({
        download: (path: string) => {
          const bytes = storage.get(path);
          return Promise.resolve(bytes ? ok(new Blob([bytes as BlobPart])) : { data: null, error: { message: "not found" } });
        },
      }),
    },
  };
  const states = new Map<string, Record<string, unknown>>();
  const caller = {
    auth: { getUser: (token: string) => Promise.resolve({ data: { user: token === "owner-jwt" ? { id: "user-a" } : null } }) },
    rpc: (name: string, args: Record<string, unknown>) => {
      log.push(`caller ${name} ${JSON.stringify(args)}`);
      if (world.ownerRpc) {
        const r = world.ownerRpc(name, args);
        if (r) return Promise.resolve(r);
      }
      if (name === "is_shop_member") return Promise.resolve(ok(world.member !== false && args.p_shop_id === SHOP));
      if (name === "shop_has_plan") return Promise.resolve(ok(world.plan !== false));
      return Promise.resolve(ok(null));
    },
  };
  const deps: Deps = {
    db: db as unknown as SupabaseClient,
    asCaller: () => caller as unknown as SupabaseClient,
    adapters: adaptersFor(cloud.fetch),
    tokenSecret: SECRET,
    serviceKey: SERVICE_KEY,
    redirectBase: "https://p.supabase.co/functions/v1/cloud-export/oauth/",
    email: world.email === false ? null : { apiKey: "brevo-key", from: "ppi@example.invalid" },
    fetch: cloud.fetch,
    background: (task) => tasks.push(task),
    now: () => Date.now(),
  };
  return { deps, log, tasks, done, states };
}

const FOLDER = "/Cacadoo/Potraviny Centrum/2026-10/2026-10-10_14-05_3f2a9c1b";
const finishOf = (log: string[]) => log.filter((l) => l.startsWith("rpc cloud_export_finish")).map((l) => JSON.parse(l.slice(l.indexOf("{"))));

// ---------------------------------------------------------------- copying one conversation

for (const provider of ["onedrive", "dropbox"] as Provider[]) {
  const put = provider === "onedrive" ? "onedrive put" : "dropbox put";
  const key = (p: string) => (provider === "dropbox" ? p.toLowerCase() : p);

  Deno.test(`${provider}: a conversation goes to <target>/<YYYY-MM>/<YYYY-MM-DD_HH-MM_id>/ with subory/, once`, async () => {
    const cloud = fakeClouds();
    const { deps, log } = fakes(cloud, { connection: await connection(provider) });
    eq(await exportConversation(deps, CONV), "done", "done");
    eq(cloud.log.filter((l) => l.startsWith(put)), [
      `${put} ${FOLDER}/konverzacia.pdf ${PDF.length}`,
      `${put} ${FOLDER}/subory/IMG_0042.jpg ${JPG.length}`,
      `${put} ${FOLDER}/subory/ponuka_ č.12_.pdf ${OFFER.length}`,
    ], "the folder structure");
    eq(new TextDecoder().decode(cloud.files.get(key(`${FOLDER}/konverzacia.pdf`))!.bytes), new TextDecoder().decode(PDF), "the PDF itself");
    eq(finishOf(log), [{ p_id: CONV, p_path: FOLDER, p_error: null, p_retry: true, p_retry_after: null }], "status: Uložené v cloude");
    assert(log.some((l) => l.startsWith("rpc cloud_connection_result") && l.includes('"p_error":null')), "the connection is fine");
    eq(log.filter((l) => l.startsWith("rpc cloud_export_item_done")).length, 3, "every file recorded");
    // the same again: everything is recorded → nothing sent
    const sends = cloud.log.length;
    eq(await exportConversation(deps, CONV), "done", "again");
    eq(cloud.log.slice(sends).filter((l) => l.startsWith(put)), [], "never twice");
  });

  Deno.test(`${provider}: the same file already there is not sent again; a different one gets " (2)"; nothing replaced`, async () => {
    const cloud = fakeClouds();
    const { deps } = fakes(cloud, { connection: await connection(provider) });
    // a copy that went through before its record was lost, and the owner's own file of the same name
    for (const p of ["/Cacadoo", "/Cacadoo/Potraviny Centrum", "/Cacadoo/Potraviny Centrum/2026-10", FOLDER, `${FOLDER}/subory`]) cloud.folders.add(key(p));
    cloud.files.set(key(`${FOLDER}/konverzacia.pdf`), { bytes: PDF, id: "earlier" });
    cloud.files.set(key(`${FOLDER}/subory/IMG_0042.jpg`), { bytes: enc.encode("the owner's own picture"), id: "owners" });
    eq(await exportConversation(deps, CONV), "done", "done");
    assert(!cloud.log.some((l) => l.includes(`${FOLDER}/konverzacia.pdf`) && l.startsWith(put)), "the identical PDF is not sent again");
    assert(cloud.log.includes(`${put} ${FOLDER}/subory/IMG_0042 (2).jpg ${JPG.length}`), "a new version gets a suffix");
    eq(new TextDecoder().decode(cloud.files.get(key(`${FOLDER}/subory/IMG_0042.jpg`))!.bytes), "the owner's own picture", "the owner's file is untouched");
  });

  Deno.test(`${provider}: an expired access token is renewed (kept encrypted); an invalid refresh → "connect again"`, async () => {
    const cloud = fakeClouds();
    cloud.tokens[provider].clear(); // the stored access token no longer works
    const { deps, log } = fakes(cloud, { connection: await connection(provider) });
    eq(await exportConversation(deps, CONV), "done", "renewed and done");
    const saved = log.find((l) => l.startsWith("rpc cloud_connection_tokens"))!;
    assert(saved && !/access-\d/.test(saved) && /"p_access_enc":"v1\./.test(saved), "the new token is saved encrypted only");
    if (provider === "onedrive") assert(/"p_refresh_enc":"v1\./.test(saved), "a rotated refresh token is saved too");
    else assert(/"p_refresh_enc":null/.test(saved), "Dropbox keeps its refresh token");

    const cloud2 = fakeClouds();
    cloud2.tokens[provider].clear();
    cloud2.refresh[provider] = "something-else";
    const f2 = fakes(cloud2, { connection: await connection(provider) });
    eq(await exportConversation(f2.deps, CONV), "failed", "failed");
    eq(finishOf(f2.log)[0].p_error, "Pripojenie k cloudu vypršalo – pripojte ho znova", "the reason shown");
    assert(f2.log.some((l) => l.startsWith("rpc cloud_connection_result") && l.includes('"p_expired":true')), "marked expired");
  });

  Deno.test(`${provider}: a busy cloud → Chyba and tried again later; a deleted conversation stops at once`, async () => {
    const cloud = fakeClouds();
    cloud.throttleNext(100);
    const { deps, log } = fakes(cloud, { connection: await connection(provider) });
    eq(await exportConversation(deps, CONV), "failed", "failed");
    eq(finishOf(log)[0], { p_id: CONV, p_path: null, p_error: "Cloud je preťažený, skúsime to znova", p_retry: true,
      p_retry_after: provider === "onedrive" ? 120 : 60 }, "retried later, not before the cloud's Retry-After");

    const cloud2 = fakeClouds();
    const f2 = fakes(cloud2, { connection: await connection(provider), deleteAfter: 1 });
    eq(await exportConversation(f2.deps, CONV), "skipped", "stopped");
    eq(cloud2.log.filter((l) => l.startsWith(put)).length, 1, "only what went before the shopper deleted it");
  });
}

Deno.test("Nothing is copied for a conversation the shopper deleted or a shop without a cloud", async () => {
  for (const world of [{ deleted: true }, { connection: null }]) {
    const cloud = fakeClouds();
    const { deps, log } = fakes(cloud, { ...world, connection: "connection" in world ? null : await connection("onedrive") });
    eq(await exportConversation(deps, CONV), "skipped", JSON.stringify(world));
    eq(cloud.log, [], "no request to the cloud");
    assert(!log.some((l) => l.startsWith("rpc cloud_export_item_done")), "nothing recorded");
  }
});

// ---------------------------------------------------------------- connecting (OAuth)

function post(body: Record<string, unknown>, headers: Record<string, string> = { Authorization: "Bearer owner-jwt" }) {
  return new Request("https://p.supabase.co/functions/v1/cloud-export", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function call(deps: Deps, body: Record<string, unknown>, headers?: Record<string, string>) {
  const res = await handle(post(body, headers), deps);
  return [res.status, await res.json()] as const;
}

const RETURN = "https://ppi.example/sk/dashboard?shop=potraviny-centrum&at=cloud";

Deno.test("Connect: owners of a Pro shop only; a share link is explained; the state is kept hashed with PKCE", async () => {
  const cloud = fakeClouds();
  {
    const { deps } = fakes(cloud, {});
    eq(await call(deps, { action: "connect", shop_id: SHOP, provider: "onedrive", return_url: RETURN }, {}), [401, { error: "login" }], "no login");
  }
  {
    const { deps } = fakes(cloud, { member: false });
    eq(await call(deps, { action: "connect", shop_id: SHOP, provider: "onedrive", return_url: RETURN }), [403, { error: "not_member" }], "not theirs");
  }
  {
    const { deps } = fakes(cloud, { plan: false });
    eq(await call(deps, { action: "connect", shop_id: SHOP, provider: "dropbox", return_url: RETURN }), [403, { error: "no_plan" }], "Pro only");
  }
  {
    const { deps } = fakes(cloud, {});
    eq(await call(deps, { action: "connect", shop_id: SHOP, provider: "gdrive", return_url: RETURN }), [400, { error: "bad_request" }], "no Google Drive");
    eq(await call(deps, { action: "connect", shop_id: SHOP, provider: "onedrive", folder: "https://1drv.ms/f/s!Abc", return_url: RETURN }),
      [400, { error: "share_link" }], "a share link cannot be written to");
    eq(await call(deps, { action: "connect", shop_id: SHOP, provider: "onedrive", return_url: "https://evil.example/x" }),
      [400, { error: "bad_request" }], "only back to Môj obchod");
    deps.adapters.onedrive = oneDrive({}, cloud.fetch);
    eq(await call(deps, { action: "connect", shop_id: SHOP, provider: "onedrive", return_url: RETURN }), [503, { error: "not_configured" }], "no app yet");
  }
  const { deps, log, states } = fakes(cloud, {});
  const [status, body] = await call(deps, { action: "connect", shop_id: SHOP, provider: "onedrive", return_url: RETURN });
  eq(status, 200, "ok");
  const url = new URL(body.url);
  const state = url.searchParams.get("state")!;
  assert(state.length >= 40 && url.searchParams.get("code_challenge"), "random state and a challenge");
  assert(states.has(await sha256Hex(state)) && !log.some((l) => l.includes(state)), "the state is kept only as its hash");
  eq(states.get(await sha256Hex(state))!.folder_path, "/Cacadoo/Potraviny Centrum", "default folder /Cacadoo/<shop>");
  eq(url.searchParams.get("redirect_uri"), "https://p.supabase.co/functions/v1/cloud-export/oauth/onedrive", "back to this function");
});

Deno.test("The provider's answer: tokens encrypted, the folder made, back to Môj obchod; a state works once", async () => {
  for (const provider of ["onedrive", "dropbox"] as Provider[]) {
    const cloud = fakeClouds();
    const { deps, log } = fakes(cloud, {});
    const [, body] = await call(deps, { action: "connect", shop_id: SHOP, provider, folder: "/Cacadoo/Môj obchod", return_url: RETURN });
    const state = new URL(body.url).searchParams.get("state")!;
    const back = `https://p.supabase.co/functions/v1/cloud-export/oauth/${provider}?code=${provider}-code&state=${state}`;
    const res = await handle(new Request(back), deps);
    eq([res.status, res.headers.get("Location")], [302, `${RETURN}&ok=cloud_connected#cloud`], `${provider}: back with ok`);
    const saved = log.find((l) => l.startsWith("rpc cloud_connection_save"))!;
    assert(saved && !saved.includes(`${provider}-access-new`) && !saved.includes(`${provider}-refresh-new`), "no token in clear");
    const args = JSON.parse(saved.slice(saved.indexOf("{")));
    const key = await tokenKey(SECRET);
    eq(await decryptToken(key, args.p_refresh_enc, `${SHOP}:${provider}:refresh`), `${provider}-refresh-new`, "the refresh token opens");
    eq([args.p_folder, args.p_site_url, args.p_account_email], ["/Cacadoo/Môj obchod", "https://ppi.example", "jan@example.invalid"], "saved");
    assert(cloud.folders.has(provider === "dropbox" ? "/cacadoo/môj obchod" : "/Cacadoo/Môj obchod"), "the folder exists in the cloud");
    assert(cloud.log.some((l) => /token code verifier=64/.test(l)), "the PKCE verifier was sent");
    const again = await handle(new Request(back), deps);
    eq(again.status, 400, "a state works once");
    assert((await again.text()).includes("Odkaz vypršal"), "a plain page explains it");
  }
  const cloud = fakeClouds();
  const { deps } = fakes(cloud, {});
  const [, body] = await call(deps, { action: "connect", shop_id: SHOP, provider: "dropbox", return_url: RETURN });
  const state = new URL(body.url).searchParams.get("state")!;
  const denied = await handle(new Request(`https://p.supabase.co/functions/v1/cloud-export/oauth/dropbox?error=access_denied&state=${state}`), deps);
  eq(denied.headers.get("Location"), `${RETURN}&err=cloud_denied#cloud`, "the owner said no");
  const [, body2] = await call(deps, { action: "connect", shop_id: SHOP, provider: "dropbox", return_url: RETURN });
  const state2 = new URL(body2.url).searchParams.get("state")!;
  eq((await handle(new Request(`https://p.supabase.co/functions/v1/cloud-export/oauth/onedrive?code=x&state=${state2}`), deps)).status, 400,
    "a state of another cloud is refused");
});

// ---------------------------------------------------------------- owners: folder, disconnect, retry, older ones

Deno.test("Owners: choose or make the folder, refuse share links, disconnect (Dropbox revoked), retry, older ones", async () => {
  const cloud = fakeClouds();
  for (const p of ["/cacadoo", "/cacadoo/jar", "/cacadoo/leto"]) cloud.folders.add(p);
  const { deps, log, tasks } = fakes(cloud, {
    connection: await connection("dropbox"),
    ownerRpc: (name, args) => {
      if (name === "owner_cloud_retry") return args.p_conversation_id === CONV ? ok(true) : { data: null, error: { message: "Not your shop", code: "42501" } };
      if (name === "owner_cloud_backfill") return String(args.p_from) <= String(args.p_to) ? ok(7) : { data: null, error: { message: "period", code: "22023" } };
      return undefined as unknown as Result;
    },
  });
  eq(await call(deps, { action: "folders", shop_id: SHOP, path: "/Cacadoo" }), [200, { path: "/Cacadoo", folders: ["jar", "leto"] }], "subfolders");
  eq(await call(deps, { action: "create_folder", shop_id: SHOP, path: "/Cacadoo", name: "Konverzácie" }), [200, { path: "/Cacadoo/Konverzácie" }], "a new folder");
  assert(cloud.folders.has("/cacadoo/konverzácie"), "made in the cloud");
  eq(await call(deps, { action: "set_folder", shop_id: SHOP, path: "https://www.dropbox.com/scl/fo/abc" }), [400, { error: "share_link" }], "a share link");
  eq(await call(deps, { action: "set_folder", shop_id: SHOP, path: "/Cacadoo/Nový/Archív" }), [200, { path: "/Cacadoo/Nový/Archív" }], "set and made");
  assert(log.some((l) => l.startsWith("rpc cloud_set_folder") && l.includes("/Cacadoo/Nový/Archív")), "saved");
  eq(await call(deps, { action: "folders", shop_id: OTHER_SHOP, path: "/" }), [403, { error: "not_member" }], "another shop");
  eq(await call(deps, { action: "retry", conversation_id: CONV }), [200, { queued: true }], "Uložiť znova");
  eq(tasks.length, 1, "copied right away in the background");
  eq(await call(deps, { action: "retry", conversation_id: IMG }), [403, { error: "not_member" }], "not their conversation");
  eq(await call(deps, { action: "backfill", shop_id: SHOP, from: "2026-09-01", to: "2026-10-10" }), [200, { count: 7 }], "older conversations");
  eq(await call(deps, { action: "backfill", shop_id: SHOP, from: "2026-10-10", to: "2026-09-01" }), [400, { error: "period" }], "a wrong period");
  eq(await call(deps, { action: "disconnect", shop_id: SHOP }), [200, { disconnected: true }], "Odpojiť");
  assert(cloud.log.includes("dropbox revoke") && log.some((l) => l.startsWith("rpc cloud_disconnect")), "token revoked and deleted");
});

// ---------------------------------------------------------------- the archive's push and the job

Deno.test("The archive's push needs the service key; the job needs the Vault secret, copies what is due, e-mails once", async () => {
  const cloud = fakeClouds();
  {
    const { deps, tasks } = fakes(cloud, { connection: await connection("onedrive"), claims: [[CONV]] });
    eq(await call(deps, { action: "export", conversation_id: CONV }, { Authorization: "Bearer someone" }), [401, { error: "secret" }], "wrong key");
    eq(await call(deps, { action: "export", conversation_id: CONV }, { Authorization: `Bearer ${SERVICE_KEY}` }), [202, { queued: true }], "queued");
    await Promise.all(tasks);
    assert(cloud.log.some((l) => l.startsWith("onedrive put") && l.includes("konverzacia.pdf")), "copied");
  }
  const alert = {
    shop_id: SHOP,
    shop_name: "Potraviny Centrum",
    shop_slug: "potraviny-centrum",
    timezone: "Europe/Bratislava",
    provider: "onedrive",
    last_error: "Pripojenie k cloudu vypršalo – pripojte ho znova",
    failing_since: "2026-10-09T08:00:00Z",
    site_url: "https://ppi.example",
    emails: ["owner-a@example.invalid", "owner-c@example.invalid"],
  };
  {
    const cloud2 = fakeClouds();
    const { deps, log } = fakes(cloud2, { connection: await connection("dropbox"), claims: [[CONV]], alerts: [alert] });
    eq(await call(deps, { action: "tick" }, { "x-ppi-cron": "wrong" }), [401, { error: "secret" }], "wrong secret");
    eq(await call(deps, { action: "tick" }, { "x-ppi-cron": CRON }), [200, { done: 1, failed: 0, alerts: 1 }], "tick");
    eq(cloud2.brevo.length, 1, "one e-mail");
    const mail = cloud2.brevo[0];
    eq([mail.key, mail.body.subject, (mail.body.to as { email: string }[]).map((t) => t.email)],
      ["brevo-key", "Pripojenie k cloudu vypršalo – pripojte ho znova", ["owner-a@example.invalid", "owner-c@example.invalid"]], "to the owners");
    assert(String(mail.body.textContent).includes("https://ppi.example/sk/dashboard?shop=potraviny-centrum&at=cloud#cloud"), "with the link");
    assert(log.some((l) => l.startsWith("rpc cloud_alert_sent")), "noted as sent");
  }
  {
    const cloud3 = fakeClouds();
    const { deps, log } = fakes(cloud3, { alerts: [alert], email: false });
    eq(await call(deps, { action: "tick" }, { "x-ppi-cron": CRON }), [200, { done: 0, failed: 0, alerts: 0 }], "no e-mail set up");
    assert(!log.some((l) => l.startsWith("rpc cloud_alert_sent")), "not marked: sent once it is set up");
  }
  eq(ALERT_SUBJECT, "Pripojenie k cloudu vypršalo – pripojte ho znova", "subject");
  assert(alertText({ ...alert, provider: "onedrive" } as Parameters<typeof alertText>[0]).includes("od 9. 10. 2026 10:00 nedajú uložiť do OneDrive"),
    "the time in the shop's time zone");
});
