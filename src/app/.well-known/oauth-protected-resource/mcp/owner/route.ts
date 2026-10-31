import { json, preflight } from "@/lib/apiHttp";
import { protectedResource } from "@/lib/ownerMcpRules";
import { siteUrl } from "@/lib/site";

/** RFC 9728 metadata at the resource's own path (/.well-known/oauth-protected-resource/mcp/owner). */
export function GET() {
  return json(protectedResource(siteUrl()), 200, { "Cache-Control": "public, max-age=3600" });
}

export const OPTIONS = preflight;
