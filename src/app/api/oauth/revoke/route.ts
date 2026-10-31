import { CORS_HEADERS, preflight } from "@/lib/apiHttp";
import { createPublicClient } from "@/lib/supabase/public";

/** Token revocation (RFC 7009): an access or refresh token ends its grant. Always 200. */
export async function POST(request: Request) {
  const token = new URLSearchParams(await request.text()).get("token");
  const db = createPublicClient();
  if (db && token && token.length <= 200) await db.rpc("owner_mcp_revoke", { p_token: token });
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}

export const OPTIONS = preflight;
