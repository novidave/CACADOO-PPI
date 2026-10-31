import { json, preflight } from "@/lib/apiHttp";
import { protectedResource } from "@/lib/ownerMcpRules";
import { siteUrl } from "@/lib/site";

/** RFC 9728 metadata of the owner's MCP server (database update 61). */
export function GET() {
  return json(protectedResource(siteUrl()), 200, { "Cache-Control": "public, max-age=3600" });
}

export const OPTIONS = preflight;
