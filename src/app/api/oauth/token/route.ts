import { json, preflight } from "@/lib/apiHttp";
import { createPublicClient } from "@/lib/supabase/public";

const OAUTH_ERRORS = ["invalid_grant", "invalid_client", "unsupported_grant_type", "invalid_request"];

/** Form fields (application/x-www-form-urlencoded, as OAuth asks) or JSON. */
async function fields(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

/**
 * The token endpoint (OAuth 2.1): authorization_code with the PKCE verifier, refresh_token (rotating). Public clients
 * send their client_id; the database checks everything and returns the tokens once.
 */
export async function POST(request: Request) {
  const f = await fields(request);
  const db = createPublicClient();
  if (!db) return json({ error: "temporarily_unavailable" }, 503);
  const { data, error } = await db.rpc("owner_mcp_token", {
    p_grant_type: f.grant_type ?? "",
    p_code: f.code ?? null,
    p_code_verifier: f.code_verifier ?? null,
    p_client_id: f.client_id ?? null,
    p_redirect_uri: f.redirect_uri ?? null,
    p_refresh_token: f.refresh_token ?? null,
  });
  if (error) {
    const code = OAUTH_ERRORS.includes(error.message) ? error.message : "invalid_request";
    return json({ error: code }, code === "invalid_client" ? 401 : 400);
  }
  const out = data as Record<string, unknown>;
  if (typeof out.error === "string") return json({ error: out.error }, 400);
  return json(out, 200, { Pragma: "no-cache" });
}

export const OPTIONS = preflight;
