/// <reference lib="deno.ns" />
// PPI · shop-files Edge Function
//
// A signed address (valid 10 minutes) for one file a shopper may open from the shop's
// assistant: a picture the assistant may show, or a PDF the owner allows to download.
// POST {slug, kind: "picture" | "document", id, token} → {url} or 404.
// The database decides (shop_file_path): only the shop's Public folder and the private
// folders the shopper's session token opens (token from "I have an access key"), only
// for active shops with the paid plan. The website calls this from its own server with
// the token from the shopper's cookie; the files themselves stay in the private bucket.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name
// "shop-files" → paste this file → Deploy, then switch OFF "Verify JWT" (shoppers have
// no login; the token and the database decide). No secrets needed.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export const BUCKET = "shop-docs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const SIGNED_SECONDS = 600;

export async function signFile(req: Request, db: SupabaseClient): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "bad_request", message: "JSON body expected" });
  }
  const slug = String(body?.slug ?? "");
  const kind = body?.kind === "picture" || body?.kind === "document" ? body.kind : null;
  const id = String(body?.id ?? "");
  const token = typeof body?.token === "string" && body.token.length <= 200 ? body.token : null;
  if (!SLUG.test(slug) || !kind || !UUID.test(id)) {
    return reply(400, { error: "bad_request", message: "slug, kind and id are required" });
  }

  const { data: path, error } = await db.rpc("shop_file_path", {
    p_slug: slug,
    p_kind: kind,
    p_id: id,
    p_session_token: token,
  });
  if (error) return reply(500, { error: "database", message: error.message });
  if (typeof path !== "string" || !path) return reply(404, { error: "not_found", message: "No such file for you" });

  const { data: signed, error: signError } = await db.storage.from(BUCKET).createSignedUrl(path, SIGNED_SECONDS);
  if (signError || !signed?.signedUrl) return reply(404, { error: "not_found", message: "The file is missing" });
  return reply(200, { url: signed.signedUrl, expires_in: SIGNED_SECONDS });
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return reply(405, { error: "method", message: "POST only" });
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return reply(500, { error: "config", message: "Function is missing Supabase settings" });
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return await signFile(req, db);
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
