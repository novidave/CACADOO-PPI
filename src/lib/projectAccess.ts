import "server-only";
import { cookies } from "next/headers";
import { docsKeysEnabled, signCookie, verifyCookie } from "./docsAccess";
import { createPublicClient } from "./supabase/public";

/**
 * A customer's project in the shop assistant (update 95). The SMS code goes only to the database (project_unlock),
 * never to the AI; the database answers with a session token for THIS conversation (24 hours) whose hash it keeps.
 * The website keeps the token in a signed, HttpOnly cookie for this one shop, sent only to the shop's
 * /api/shops/<slug>/ addresses (the chat route reads it); "Nová konverzácia", closing the chat or leaving the page
 * locks it again. What a token may read is decided by the database on every question (search_contact_project).
 */

const COOKIE_PREFIX = "ppi_proj_";
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const cookieName = (slug: string) => `${COOKIE_PREFIX}${slug}`;
const cookiePath = (slug: string) => `/api/shops/${slug}/`;

/** On when SESSION_COOKIE_SECRET (the same key as the folders' cookie) is set on the server. */
export const projectsEnabled = docsKeysEnabled;

/** The shopper's project session token for this shop (from the cookie), or null. */
export async function projectToken(slug: string): Promise<string | null> {
  if (!SLUG.test(slug)) return null;
  // a different prefix in the signed text keeps a folders cookie from passing as a project one
  return verifyCookie(`project:${slug}`, (await cookies()).get(cookieName(slug))?.value);
}

function client() {
  const supabase = createPublicClient();
  if (!supabase) throw new Error("Supabase is not configured");
  return supabase;
}

export type UnlockProject = { status: "ok"; expires_at: string } | { status: "wrong"; attempts_left: number } | { status: "expired" | "too_many" | "not_found" | "unavailable" };

/** The code from the page's own form → a session for this conversation (the cookie). */
export async function unlockProject(
  slug: string,
  codeId: string,
  code: string,
  conversation: { id: string; token: string },
): Promise<UnlockProject> {
  if (!SLUG.test(slug) || !projectsEnabled()) return { status: "unavailable" };
  const { data, error } = await client().rpc("project_unlock", {
    p_code_id: codeId,
    p_code: code.replace(/\s/g, "").slice(0, 12),
    p_conversation_id: conversation.id,
    p_conversation_token: conversation.token,
  });
  if (error) throw new Error(`project unlock failed: ${error.message}`);
  const r = data as { ok: boolean; reason?: string; attempts_left?: number; token?: string; expires_at?: string };
  if (!r.ok || !r.token || !r.expires_at) {
    if (r.reason === "wrong_code") return { status: "wrong", attempts_left: r.attempts_left ?? 0 };
    return { status: r.reason === "expired" ? "expired" : r.reason === "too_many_attempts" ? "too_many" : "not_found" };
  }
  const value = signCookie(`project:${slug}`, r.token);
  if (!value) return { status: "unavailable" };
  (await cookies()).set(cookieName(slug), value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: cookiePath(slug),
    expires: new Date(r.expires_at),
  });
  return { status: "ok", expires_at: r.expires_at };
}

/** "Nová konverzácia", the chat box closes or the page is left: the database ends the session and the cookie goes. */
export async function lockProject(slug: string): Promise<void> {
  const token = await projectToken(slug);
  if (token) await client().rpc("project_lock", { p_token: token });
  (await cookies()).delete({ name: cookieName(slug), path: cookiePath(slug) });
}
