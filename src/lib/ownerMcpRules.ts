/**
 * The owner's MCP server (database update 61): the rules shared by the OAuth endpoints, the consent page and the MCP
 * route — no server-only imports, so `ownerMcpRules_test.ts` can run them (npm run test:mcp).
 */

/** What a grant may do; shop.read is always part of it. */
export const SCOPES = ["shop.read", "shop.write", "messages.send"] as const;
export type Scope = (typeof SCOPES)[number];

/** Where the MCP server lives under the site. */
export const MCP_PATH = "/mcp/owner";

/** The scopes asked for ("shop.read shop.write"), only known ones, always with shop.read; none asked = all. */
export function parseScopes(value: string | null | undefined): Scope[] {
  const asked = (value ?? "").split(/[\s,]+/).filter(Boolean);
  const known = SCOPES.filter((s) => asked.includes(s));
  if (asked.length === 0) return [...SCOPES];
  return known.includes("shop.read") ? known : (["shop.read", ...known] as Scope[]);
}

/** RFC 9728: where the MCP server says which authorization server issues its tokens. */
export function protectedResource(site: string) {
  return {
    resource: `${site}${MCP_PATH}`,
    authorization_servers: [site],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Cacaduu – Môj obchod",
    resource_documentation: `${site}/sk/dashboard/ai`,
  };
}

/** RFC 8414: the authorization server's endpoints (public clients, PKCE S256, rotating refresh tokens). */
export function authorizationServer(site: string) {
  return {
    issuer: site,
    authorization_endpoint: `${site}/api/oauth/authorize`,
    token_endpoint: `${site}/api/oauth/token`,
    registration_endpoint: `${site}/api/oauth/register`,
    revocation_endpoint: `${site}/api/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
  };
}

/** The 401 header that sends an MCP client to the metadata above. */
export function wwwAuthenticate(site: string, error?: "invalid_token") {
  const parts = [`resource_metadata="${site}/.well-known/oauth-protected-resource${MCP_PATH}"`];
  if (error) parts.push(`error="${error}"`);
  return `Bearer ${parts.join(", ")}`;
}

/** The bearer token of a request, or null. */
export function bearerToken(header: string | null): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})\s*$/i.exec(header ?? "");
  return m ? m[1] : null;
}

/** The client's redirect address with the answer added (its own query kept). */
export function redirectWith(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  return url.toString();
}

export interface AuthorizeRequest {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scope: Scope[];
  resource: string | null;
}

/**
 * The authorization request's own checks (the database checks the client and its redirect addresses). Returns the
 * request, or the reason it is refused: response_type, code_challenge_method, code_challenge, client_id,
 * redirect_uri, state.
 */
export function readAuthorize(q: URLSearchParams): AuthorizeRequest | { error: string } {
  if (q.get("response_type") !== "code") return { error: "response_type" };
  if (q.get("code_challenge_method") !== "S256") return { error: "code_challenge_method" };
  const challenge = q.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return { error: "code_challenge" };
  const client = q.get("client_id") ?? "";
  if (!/^cmc_[0-9a-f]{64}$/.test(client)) return { error: "client_id" };
  const redirect = q.get("redirect_uri") ?? "";
  try {
    new URL(redirect);
  } catch {
    return { error: "redirect_uri" };
  }
  const state = q.get("state");
  if (state !== null && state.length > 500) return { error: "state" };
  return {
    client_id: client,
    redirect_uri: redirect,
    code_challenge: challenge,
    state,
    scope: parseScopes(q.get("scope")),
    resource: q.get("resource")?.slice(0, 300) ?? null,
  };
}

/** The same request as the consent page's query (so a login in between keeps it). */
export function authorizeQuery(r: AuthorizeRequest): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: r.client_id,
    redirect_uri: r.redirect_uri,
    code_challenge: r.code_challenge,
    code_challenge_method: "S256",
    scope: r.scope.join(" "),
  });
  if (r.state !== null) q.set("state", r.state);
  if (r.resource) q.set("resource", r.resource);
  return q.toString();
}

/** The database's refusals as text an AI assistant can act on (English, for the model). */
export function toolError(message: string): string {
  const reason = message.split(":")[0].trim();
  const texts: Record<string, string> = {
    invalid_token: "The connection to Cacaduu expired or was disconnected. Reconnect the Cacaduu connector.",
    scope: `This connection is not allowed to do that (${message.split(":")[1]?.trim() ?? "scope"}). The owner can allow it when connecting again or in Môj obchod → AI asistenti.`,
    too_many: "Too many requests in a minute. Wait a minute and try again.",
    shop_required: "This connection covers several shops: name the shop (its slug from list_shops).",
    shop_not_in_grant: "That shop is not part of this connection. Use list_shops.",
    forbidden: "The owner is no longer a member of that shop.",
    no_plan: "This works only for shops with the Cacaduu Pro plan.",
    not_found: "Not found in this shop.",
    unknown_tool: "Unknown tool.",
    bad_argument: `Invalid argument${message.includes(":") ? `: ${message.split(":").slice(1).join(":").trim()}` : ""}.`,
    hours: "Invalid opening hours: use {\"mon\": [[\"08:00\",\"17:00\"]], \"sun\": []} (HH:MM, closing may be 24:00 or after midnight).",
    dates: "Invalid dates: YYYY-MM-DD, from yesterday up to 400 days ahead, at most 62 days in one range and 10 ranges.",
    ranges: "Invalid time ranges for a special day.",
    empty: "Nothing to change.",
    confirmation: "That confirmation is unknown, used or older than 10 minutes. Call preview_message again.",
    preview_changed: "The message would no longer be the same as in the preview (the contact or template changed). Preview it again.",
    sms_quota: "The shop's monthly SMS limit is used up.",
    no_recipient: "The contact has no phone number / e-mail for this channel.",
    subject: "An e-mail needs a subject.",
    too_long: "The message is too long.",
    channel: "Channel must be sms or email.",
    email: "That e-mail address is not valid.",
    facebook: "The Facebook address must be on facebook.com.",
    booking: "The booking link must be an https address.",
    phone: "That phone number is not valid.",
    slot_taken: "That time is already booked.",
  };
  return texts[reason] ?? "The request failed.";
}
