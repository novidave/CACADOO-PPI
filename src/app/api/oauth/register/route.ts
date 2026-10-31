import { callerHash, json, preflight } from "@/lib/apiHttp";
import { createPublicClient } from "@/lib/supabase/public";

/**
 * Dynamic client registration (RFC 7591) for AI assistants that connect to the owner's MCP server: public clients
 * only (no secret, PKCE). The database checks the redirect addresses and allows 10 per caller an hour.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const uris = Array.isArray(body?.redirect_uris) ? (body!.redirect_uris as unknown[]).filter((u) => typeof u === "string") : [];
  if (!body || uris.length === 0) return json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required." }, 400);
  const method = body.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    return json({ error: "invalid_client_metadata", error_description: "Only public clients (token_endpoint_auth_method: none)." }, 400);
  }
  const db = createPublicClient();
  if (!db) return json({ error: "temporarily_unavailable" }, 503);
  const { data, error } = await db.rpc("owner_mcp_register", {
    p_name: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : "",
    p_redirect_uris: (uris as string[]).slice(0, 10),
    p_caller: callerHash(request),
  });
  if (error) {
    if (error.message === "redirect_uri") {
      return json({ error: "invalid_redirect_uri", error_description: "https addresses only (or http://localhost)." }, 400);
    }
    if (error.message === "too_many") return json({ error: "too_many_requests" }, 429, { "Retry-After": "3600" });
    return json({ error: "server_error" }, 500);
  }
  const client = data as { client_id: string; client_name: string; redirect_uris: string[] };
  return json(
    {
      ...client,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
}

export const OPTIONS = preflight;
