import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { callerHash } from "./apiHttp";
import { createPublicClient } from "./supabase/public";

/**
 * "Mám prístupový kľúč" in a shop's assistant. The key goes only to the database
 * (unlock_shop_folders), never to the AI and never into the conversation; the database
 * answers with a session token (24 hours; the chat box locks it again when it closes) whose
 * hash it keeps. The website keeps that token in a signed, HttpOnly cookie for this one
 * shop, sent only to the shop's /api/shops/<slug>/ addresses. Which folders a token opens,
 * and what may be viewed or downloaded, is decided by the database on every search and file
 * (search_shop_docs, shop_file_path, shop_folder_files, shop_view_file, shop_download_file,
 * shop_zip_ticket — database update 24).
 */

const COOKIE_PREFIX = "ppi_docs_";
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function secret(): string | null {
  const value = process.env.SESSION_COOKIE_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

/** On when SESSION_COOKIE_SECRET (at least 32 characters) is set on the server. */
export function docsKeysEnabled(): boolean {
  return secret() !== null;
}

const cookieName = (slug: string) => `${COOKIE_PREFIX}${slug}`;
const cookiePath = (slug: string) => `/api/shops/${slug}/`;

function signature(slug: string, token: string, key: string): string {
  return createHmac("sha256", key).update(`${slug}:${token}`).digest("base64url");
}

/** token.signature → token, only when signed by this website for this shop. */
export function verifyCookie(slug: string, value: string | undefined, key = secret()): string | null {
  if (!key || !value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const token = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(signature(slug, token, key));
  return given.length === expected.length && timingSafeEqual(given, expected) ? token : null;
}

export function signCookie(slug: string, token: string, key = secret()): string | null {
  return key ? `${token}.${signature(slug, token, key)}` : null;
}

/** The shopper's session token for this shop (from the cookie), or null. */
export async function docsToken(slug: string): Promise<string | null> {
  if (!SLUG.test(slug)) return null;
  return verifyCookie(slug, (await cookies()).get(cookieName(slug))?.value);
}

export type UnlockResult =
  | { status: "ok"; folders: string[]; expires_at: string; open: OpenSession | null }
  | { status: "wrong" | "too_many" | "unavailable" };


function client() {
  const supabase = createPublicClient();
  if (!supabase) throw new Error("Supabase is not configured");
  return supabase;
}

/** Checks the key (at most 5 wrong ones per caller and shop in 15 minutes) and keeps the session. */
export async function unlock(request: Request, slug: string, key: string): Promise<UnlockResult> {
  if (!SLUG.test(slug) || !docsKeysEnabled()) return { status: "unavailable" };
  const { data, error } = await client().rpc("unlock_shop_folders", {
    p_slug: slug,
    p_key: key.slice(0, 100),
    p_ip_hash: callerHash(request),
  });
  if (error) throw new Error(`unlock failed: ${error.message}`);
  const result = data as { status: string; token?: string; expires_at?: string; folders?: string[] };
  if (result.status !== "ok" || !result.token || !result.expires_at) {
    return { status: result.status === "too_many" ? "too_many" : result.status === "wrong" ? "wrong" : "unavailable" };
  }
  const value = signCookie(slug, result.token);
  if (!value) return { status: "unavailable" };
  (await cookies()).set(cookieName(slug), value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: cookiePath(slug),
    expires: new Date(result.expires_at),
  });
  return {
    status: "ok",
    folders: result.folders ?? [],
    expires_at: result.expires_at,
    open: await sessionStatus(slug, result.token).catch(() => null),
  };
}

/** "Lock again": the database forgets the session and the cookie goes. */
export async function lock(slug: string): Promise<void> {
  const token = await docsToken(slug);
  if (token) await client().rpc("lock_shop_folders", { p_slug: slug, p_token: token });
  (await cookies()).delete({ name: cookieName(slug), path: cookiePath(slug) });
}

export interface FolderFile {
  kind: "document" | "picture";
  id: string;
  name: string;
  pages: number;
  bytes: number;
  can_download: boolean;
  viewable: boolean;
}

export interface OpenFolder {
  id: string;
  name: string;
  mode: "view" | "download";
  files: FolderFile[];
}

export interface OpenSession {
  folders: string[];
  expires_at: string;
  /** Downloads left in this unlocked session (20 at the start). */
  downloads_left: number;
  /** The open private folders with their files (database update 24; empty before it). */
  open: OpenFolder[];
}

/** Which private folders are open now, with their files, or null. */
export async function sessionStatus(slug: string, given?: string): Promise<OpenSession | null> {
  const token = given ?? (await docsToken(slug));
  if (!token) return null;
  const { data, error } = await client().rpc("shop_folder_session", { p_slug: slug, p_token: token });
  if (error || !data) return null;
  const session = data as { folders: string[]; expires_at: string; downloads_left?: number };
  const { data: rows } = await client().rpc("shop_folder_files", { p_slug: slug, p_token: token });
  const open = new Map<string, OpenFolder>();
  for (const row of (rows ?? []) as (FolderFile & { folder_id: string; folder: string; access_mode: "view" | "download" })[]) {
    const folder = open.get(row.folder_id) ?? { id: row.folder_id, name: row.folder, mode: row.access_mode, files: [] };
    folder.files.push({
      kind: row.kind,
      id: row.id,
      name: row.name,
      pages: row.pages,
      bytes: Number(row.bytes),
      can_download: row.can_download,
      viewable: row.viewable,
    });
    open.set(row.folder_id, folder);
  }
  return { folders: session.folders, expires_at: session.expires_at, downloads_left: session.downloads_left ?? 20, open: [...open.values()] };
}

// ---------------------------------------------------------------- viewer, downloads, ZIP (update 24)

/** The viewer's page addresses are signed for 10 minutes and only for this session. */
const PAGE_SECONDS = 600;
const tokenTag = (token: string) => createHash("sha256").update(token).digest("base64url").slice(0, 22);
const pageSignature = (key: string, parts: (string | number)[]) =>
  createHmac("sha256", key).update(["page", ...parts].join(":")).digest("base64url");

/** /api/shops/<slug>/folder/page/<kind>/<id>/<page>?l=&e=&s= — the watermarked page, valid 10 minutes. */
export function signedPageUrl(
  slug: string,
  kind: "document" | "picture",
  id: string,
  page: number,
  token: string,
  lang: string,
  now = Date.now(),
): string | null {
  const key = secret();
  if (!key) return null;
  const expires = Math.floor(now / 1000) + PAGE_SECONDS;
  const sig = pageSignature(key, [slug, kind, id, page, lang, expires, tokenTag(token)]);
  return `/api/shops/${slug}/folder/page/${kind}/${id}/${page}?${new URLSearchParams({ l: lang, e: String(expires), s: sig })}`;
}

/** A page address: signed by this website for this session, and not expired. */
export function verifyPageUrl(
  slug: string,
  kind: string,
  id: string,
  page: number,
  token: string,
  query: URLSearchParams,
  now = Date.now(),
): boolean {
  const key = secret();
  const expires = Number(query.get("e"));
  const lang = query.get("l") ?? "";
  if (!key || !Number.isInteger(expires) || expires * 1000 < now || expires * 1000 > now + PAGE_SECONDS * 1000 + 60_000) return false;
  const given = Buffer.from(query.get("s") ?? "");
  const expected = Buffer.from(pageSignature(key, [slug, kind, id, page, lang, expires, tokenTag(token)]));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type FilesAnswer = { status: number; data: Record<string, unknown> | null };

/** Calls shop-files with this shopper's session token; its refusals come back as their status. */
async function shopFiles(body: Record<string, unknown>): Promise<FilesAnswer> {
  const { data, error } = await client().functions.invoke<Record<string, unknown>>("shop-files", { body });
  if (!error) return { status: 200, data: data ?? null };
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) return { status: context.status, data: await context.json().catch(() => null) };
  return { status: 502, data: null };
}

export interface ViewManifest {
  name: string;
  can_download: boolean;
  pages: { page: number; url: string; width: number | null; height: number | null }[];
}

/** "Otvoriť": the file's page pictures as signed, watermarked addresses (one opening counted). */
export async function viewManifest(
  slug: string,
  kind: "document" | "picture",
  id: string,
  lang: string,
  count: boolean,
): Promise<ViewManifest | null> {
  const token = await docsToken(slug);
  if (!token) return null;
  const { status, data } = await shopFiles({ action: "view", slug, kind, id, token, count });
  if (status !== 200 || !data) return null;
  const pages = (data.pages as { page: number; width: number | null; height: number | null }[]) ?? [];
  const signed = pages.map((p) => ({ ...p, url: signedPageUrl(slug, kind, id, p.page, token, lang) }));
  if (signed.some((p) => !p.url)) return null;
  return { name: String(data.name ?? ""), can_download: data.can_download === true, pages: signed as ViewManifest["pages"] };
}

/** One page for the viewer: its picture (10-minute storage address) and the shop for the watermark. */
export async function viewPage(
  slug: string,
  kind: "document" | "picture",
  id: string,
  page: number,
): Promise<{ url: string; shop: { name: string; timezone: string } } | null> {
  const token = await docsToken(slug);
  if (!token) return null;
  const { status, data } = await shopFiles({ action: "view", slug, kind, id, token, page });
  if (status !== 200 || typeof data?.url !== "string" || !/^https?:\/\//.test(data.url)) return null;
  return { url: data.url, shop: data.shop as { name: string; timezone: string } };
}

export type GetResult = { url: string } | { error: "limit" | "not_found" | "empty" | "too_big" | "unavailable" };

function toGet(answer: FilesAnswer): GetResult {
  if (answer.status === 200 && typeof answer.data?.url === "string" && /^https?:\/\//.test(answer.data.url)) return { url: answer.data.url };
  const code = String(answer.data?.error ?? "");
  if (code === "limit" || code === "empty" || code === "too_big" || code === "not_found") return { error: code };
  return { error: answer.status === 404 ? "not_found" : "unavailable" };
}

/** "Stiahnuť": a 10-minute address that downloads the original (shop-files counts it). */
export async function downloadUrl(slug: string, kind: "document" | "picture", id: string): Promise<GetResult> {
  const token = await docsToken(slug);
  if (!token) return { error: "not_found" };
  return toGet(await shopFiles({ action: "download", slug, kind, id, token }));
}

/** "Stiahnuť celý priečinok (ZIP)": a single-use address of shop-files, valid 10 minutes. */
export async function zipUrl(slug: string, folderId: string): Promise<GetResult> {
  const token = await docsToken(slug);
  if (!token) return { error: "not_found" };
  return toGet(await shopFiles({ action: "zip", slug, folder_id: folderId, token }));
}

/** A 10-minute signed address of a file this shopper may open (shop-files decides with the database), or null. */
export async function fileUrl(slug: string, kind: "picture" | "document", id: string): Promise<string | null> {
  const token = await docsToken(slug);
  const { data, error } = await client().functions.invoke<{ url?: string }>("shop-files", {
    body: { slug, kind, id, token },
  });
  if (error || typeof data?.url !== "string" || !/^https?:\/\//.test(data.url)) return null;
  return data.url;
}
