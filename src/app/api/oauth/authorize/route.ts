import { NextResponse } from "next/server";
import { defaultLocale, isLocale } from "@/i18n/config";
import { createPublicClient } from "@/lib/supabase/public";
import { authorizeQuery, readAuthorize, redirectWith } from "@/lib/ownerMcpRules";

/**
 * The authorization endpoint (OAuth 2.1, code + PKCE S256): checks the request and the client's redirect address,
 * then shows the consent page in the owner's language. A wrong client or address is never redirected to.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const asked = readAuthorize(url.searchParams);
  if ("error" in asked) {
    return new Response(`Invalid authorization request: ${asked.error}`, { status: 400, headers: { "Content-Type": "text/plain" } });
  }
  const db = createPublicClient();
  if (!db) return new Response("Temporarily unavailable", { status: 503 });
  const { data } = await db.rpc("owner_mcp_client", { p_client_id: asked.client_id });
  const client = data as { redirect_uris: string[] } | null;
  if (!client) return new Response("Unknown client", { status: 400, headers: { "Content-Type": "text/plain" } });
  if (!client.redirect_uris.includes(asked.redirect_uri)) {
    return new Response("This redirect address is not registered for the client", { status: 400, headers: { "Content-Type": "text/plain" } });
  }
  if (url.searchParams.get("prompt") === "none") {
    return NextResponse.redirect(redirectWith(asked.redirect_uri, { error: "login_required", state: asked.state }), 303);
  }
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)ppi_lang=([a-z-]+)/)?.[1];
  const lang = cookie && isLocale(cookie) ? cookie : defaultLocale;
  return NextResponse.redirect(new URL(`/${lang}/oauth/authorize?${authorizeQuery(asked)}`, url), 303);
}
