import { json, preflight } from "@/lib/apiHttp";
import { authorizationServer } from "@/lib/ownerMcpRules";
import { siteUrl } from "@/lib/site";

/** RFC 8414 metadata of Cacaduu's authorization server for the owner's MCP server (database update 61). */
export function GET() {
  return json(authorizationServer(siteUrl()), 200, { "Cache-Control": "public, max-age=3600" });
}

export const OPTIONS = preflight;
