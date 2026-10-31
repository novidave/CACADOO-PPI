// Unit tests of the owner MCP's shared rules (database update 61): scopes, OAuth metadata, the 401 header, bearer
// tokens, the authorization request and the error texts. Run: npm run test:mcp
import {
  authorizationServer, authorizeQuery, bearerToken, parseScopes, protectedResource, readAuthorize, redirectWith, toolError,
  wwwAuthenticate,
} from "./ownerMcpRules.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const SITE = "https://cacaduu.example";
const CLIENT = "cmc_" + "a".repeat(64);
const CHALLENGE = "x3oksxij2DV0_Rlip7GoIqV3OMDhQr4LMSB58cEqNHg";

Deno.test("scopes: only known ones, always with shop.read, none asked = all", () => {
  eq(parseScopes(null), ["shop.read", "shop.write", "messages.send"], "none = all");
  eq(parseScopes("shop.write admin"), ["shop.read", "shop.write"], "read added, unknown dropped");
  eq(parseScopes("shop.read,messages.send"), ["shop.read", "messages.send"], "comma too");
});

Deno.test("metadata: the resource points to the site's authorization server with PKCE S256 and public clients", () => {
  const r = protectedResource(SITE);
  eq([r.resource, r.authorization_servers], [`${SITE}/mcp/owner`, [SITE]], "resource");
  const a = authorizationServer(SITE);
  eq([a.issuer, a.authorization_endpoint, a.token_endpoint, a.registration_endpoint],
    [SITE, `${SITE}/api/oauth/authorize`, `${SITE}/api/oauth/token`, `${SITE}/api/oauth/register`], "endpoints");
  eq([a.code_challenge_methods_supported, a.token_endpoint_auth_methods_supported], [["S256"], ["none"]], "PKCE, no secrets");
  eq(wwwAuthenticate(SITE, "invalid_token"),
    `Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp/owner", error="invalid_token"`, "401 header");
});

Deno.test("bearer tokens: only a plain token after Bearer", () => {
  eq(bearerToken("Bearer cma_" + "0".repeat(64)), "cma_" + "0".repeat(64), "token");
  eq([bearerToken(null), bearerToken("Basic abc"), bearerToken("Bearer short"), bearerToken("Bearer a b")], [null, null, null, null], "refused");
});

Deno.test("the authorization request: code + S256 + a registered-looking client; the query round-trips", () => {
  const q = new URLSearchParams({ response_type: "code", client_id: CLIENT, redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: CHALLENGE, code_challenge_method: "S256", state: "xyz", scope: "shop.read messages.send", resource: `${SITE}/mcp/owner` });
  const r = readAuthorize(q);
  if ("error" in r) throw new Error(r.error);
  eq([r.scope, r.state, r.resource], [["shop.read", "messages.send"], "xyz", `${SITE}/mcp/owner`], "read");
  const again = readAuthorize(new URLSearchParams(authorizeQuery(r)));
  eq(again, r, "round trip");
  for (const [k, v, why] of [["response_type", "token", "response_type"], ["code_challenge_method", "plain", "code_challenge_method"],
    ["code_challenge", "short", "code_challenge"], ["client_id", "other", "client_id"], ["redirect_uri", "not a url", "redirect_uri"]]) {
    const bad = new URLSearchParams(q);
    bad.set(k, v);
    eq(readAuthorize(bad), { error: why }, why);
  }
});

Deno.test("redirects keep the client's own query; refusals become plain texts for the AI", () => {
  eq(redirectWith("http://localhost:7777/cb?x=1", { code: "c", state: null, iss: SITE }), `http://localhost:7777/cb?x=1&code=c&iss=${encodeURIComponent(SITE)}`, "query");
  eq(toolError("scope: shop.write").includes("shop.write"), true, "scope named");
  eq(toolError("bad_argument: quantity / price"), "Invalid argument: quantity / price.", "argument");
  eq(toolError("something odd"), "The request failed.", "unknown");
});
