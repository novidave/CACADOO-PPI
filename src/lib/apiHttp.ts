import "server-only";
import { createHash } from "node:crypto";
import { ApiError } from "./publicApi";
import { createPublicClient } from "./supabase/public";

/** Open to any website or tool (read-only, no cookies). */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version, Retry-After",
  "Access-Control-Max-Age": "86400",
};

export const LIMIT_PER_MINUTE = 60;

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS_HEADERS, ...extra },
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

/**
 * Logs the call to api_usage and enforces 60 calls per minute per caller.
 * Only a hash of the IP is stored; the salt changes every day, so a caller
 * cannot be followed from one day to the next. If the database cannot be
 * reached the call is allowed (it is read-only anyway).
 */
export async function rateLimit(request: Request, endpoint: string): Promise<Response | null> {
  const day = new Date().toISOString().slice(0, 10);
  const salt = process.env.API_HASH_SALT ?? "ppi";
  const ipHash = createHash("sha256").update(`${day}:${salt}:${clientIp(request)}`).digest("hex");
  const supabase = createPublicClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("api_hit", {
    p_ip_hash: ipHash,
    p_endpoint: endpoint,
    p_limit: LIMIT_PER_MINUTE,
  });
  if (!error && data === false) {
    return json({ error: `Too many requests: at most ${LIMIT_PER_MINUTE} per minute. Please wait a minute.` }, 429, {
      "Retry-After": "60",
    });
  }
  return null;
}

/** Wraps a GET handler: rate limit, JSON errors, CORS. */
export async function handle(request: Request, endpoint: string, run: () => Promise<unknown>): Promise<Response> {
  const limited = await rateLimit(request, endpoint);
  if (limited) return limited;
  try {
    return json(await run());
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error(endpoint, e);
    return json({ error: "Internal error" }, 500);
  }
}
