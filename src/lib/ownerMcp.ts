import "server-only";
import { createPublicClient } from "./supabase/public";
import { supabaseEnv } from "./supabase/env";
import { refreshShop } from "./publicCache";
import { toolError } from "./ownerMcpRules";

/**
 * The owner's MCP server (database update 61), server side: every tool goes through one database function,
 * owner_mcp_call(token, tool, args), which checks the token, its scope, the shop and the plan and then acts as the
 * owner — the website holds no secret for it. A message goes out only through crm-messages with the same token and a
 * confirmation id from preview_message.
 */

export interface Grant {
  scopes: string[];
  name: string;
  shops: { slug: string; name: string }[];
}

export class McpError extends Error {
  constructor(message: string, readonly unauthorized = false) {
    super(message);
  }
}

/** The grant behind a bearer token, or null when the token is unknown, expired or revoked. */
export async function whoami(token: string): Promise<Grant | null> {
  const db = createPublicClient();
  if (!db) throw new McpError("not configured");
  const { data, error } = await db.rpc("owner_mcp_whoami", { p_token: token });
  if (error) {
    if (error.message === "invalid_token") return null;
    throw new McpError(error.message);
  }
  return data as Grant;
}

/** One tool call as the owner; refreshes the shop's public pages when the database says something visible changed. */
export async function callTool(token: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const db = createPublicClient();
  if (!db) throw new McpError(toolError("failed"));
  const { data, error } = await db.rpc("owner_mcp_call", { p_token: token, p_tool: tool, p_args: args });
  if (error) throw new McpError(toolError(error.message), error.message === "invalid_token");
  const out = data as { shop?: string | null; result: unknown; changed?: boolean };
  if (out.changed) refreshShop(out.shop ?? null);
  return out.result;
}

/** send_message: crm-messages checks the confirmation in the database (as the owner) and sends exactly the preview. */
export async function sendPreviewed(token: string, confirmationId: string): Promise<{ id: string; status: string }> {
  const env = supabaseEnv();
  if (!env) throw new McpError(toolError("failed"));
  const res = await fetch(`${env.url}/functions/v1/crm-messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: env.key, Authorization: `Bearer ${env.key}`, "x-ppi-mcp": token },
    body: JSON.stringify({ action: "mcp_send", confirmation_id: confirmationId }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res) throw new McpError("The message service could not be reached. Try again later.");
  const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string; error?: string };
  if (!res.ok || !body.id) throw new McpError(toolError(body.error ?? "failed"), body.error === "invalid_token");
  return { id: body.id, status: body.status ?? "sent" };
}
