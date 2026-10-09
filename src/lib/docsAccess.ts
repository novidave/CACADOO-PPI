import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { callerHash } from "./apiHttp";
import { createPublicClient } from "./supabase/public";

/**
 * "I have an access key" in a shop's assistant. The key goes only to the database
 * (unlock_shop_folders), never to the AI and never into the conversation; the database
 * answers with a session token (12 hours) whose hash it keeps. The website keeps that
 * token in a signed, HttpOnly cookie for this one shop, sent only to the shop's
 * /api/shops/<slug>/ addresses. Which folders a token opens is decided by the database
 * on every search and file (search_shop_docs, shop_file_path).
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
  | { status: "ok"; folders: string[]; expires_at: string }
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
  return { status: "ok", folders: result.folders ?? [], expires_at: result.expires_at };
}

/** "Lock again": the database forgets the session and the cookie goes. */
export async function lock(slug: string): Promise<void> {
  const token = await docsToken(slug);
  if (token) await client().rpc("lock_shop_folders", { p_slug: slug, p_token: token });
  (await cookies()).delete({ name: cookieName(slug), path: cookiePath(slug) });
}

/** Which private folders are open now (names only), or null. */
export async function sessionStatus(slug: string): Promise<{ folders: string[]; expires_at: string } | null> {
  const token = await docsToken(slug);
  if (!token) return null;
  const { data, error } = await client().rpc("shop_folder_session", { p_slug: slug, p_token: token });
  if (error || !data) return null;
  return data as { folders: string[]; expires_at: string };
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
