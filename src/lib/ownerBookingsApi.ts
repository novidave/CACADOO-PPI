import "server-only";
import { json, rateLimit } from "./apiHttp";
import { callTool, McpError } from "./ownerMcp";
import { bearerToken, wwwAuthenticate } from "./ownerMcpRules";
import { siteUrl } from "./site";

/**
 * Update 63/64: the owner's booking API (/api/owner/bookings…) for apps and integrations. It takes the same bearer token
 * as the owner's MCP server (an OAuth access token or a personal key cmk_… from Môj obchod → AI asistenti) and goes
 * through the same one door, owner_mcp_call(): the token's scopes, the shop in the grant, the plan, 120 calls a minute,
 * and every booking rule in SQL. Moving or cancelling answers with what would change unless `confirm` is true.
 */
export async function ownerBookingCall(request: Request, tool: string, args: Record<string, unknown>): Promise<Response> {
  const limited = await rateLimit(request, "/api/owner/bookings", 120);
  if (limited) return limited;
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return json({ error: "Missing bearer token." }, 401, { "WWW-Authenticate": wwwAuthenticate(siteUrl()) });
  try {
    return json({ result: await callTool(token, tool, args) });
  } catch (e) {
    if (e instanceof McpError && e.unauthorized) {
      return json({ error: e.message }, 401, { "WWW-Authenticate": wwwAuthenticate(siteUrl(), "invalid_token") });
    }
    return json({ error: e instanceof McpError ? e.message : "The request failed." }, 400);
  }
}

/** The query's text values (only the given keys, trimmed, ≤ 200 characters). */
export function queryArgs(request: Request, keys: string[]): Record<string, unknown> {
  const sp = new URL(request.url).searchParams;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = sp.get(k)?.trim();
    if (v) out[k] = /^(days|people|limit|offset)$/.test(k) ? Number(v) : v.slice(0, 200);
  }
  return out;
}

/** A JSON body as an object (anything else = {}). */
export async function bodyArgs(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
