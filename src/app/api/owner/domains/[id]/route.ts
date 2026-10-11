import { getSession } from "@/lib/auth";
import { callDomains } from "@/lib/domains";

/**
 * The progress screen of "Predplatné a doména" asks here every few seconds (GET), and
 * "Skontrolovať" sends POST. The owner's own login reads the row (RLS: own shop only);
 * DNS records are given only for the shop's own domain (a bought one never needs them).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

async function read(id: string) {
  const session = await getSession();
  if (!session || !UUID.test(id)) return { session: null, row: null };
  const { data } = await session.supabase
    .from("domain_orders")
    .select("id, kind, hostname, site_host, www, status, test_mode, dns_records, registrar_service_id, last_check_at, next_check_at, live_at, live_email_at, expires_at")
    .eq("id", id)
    .maybeSingle();
  return { session, row: data as Record<string, unknown> | null };
}

function view(row: Record<string, unknown>) {
  return {
    id: row.id,
    kind: row.kind,
    hostname: row.hostname,
    site_host: row.site_host,
    status: row.status,
    test_mode: row.test_mode,
    dns_records: row.kind === "connected" ? row.dns_records : null,
    auto_dns: row.kind === "connected" && Boolean(row.registrar_service_id),
    last_check_at: row.last_check_at,
    next_check_at: row.next_check_at,
    live_at: row.live_at,
    email_sent: Boolean(row.live_email_at),
    expires_at: row.expires_at,
  };
}

export async function GET(_request: Request, ctx: RouteContext<"/api/owner/domains/[id]">) {
  const { id } = await ctx.params;
  const { session, row } = await read(id);
  if (!session) return Response.json({ error: "login" }, { status: 401, headers: PRIVATE });
  if (!row) return Response.json({ error: "not_found" }, { status: 404, headers: PRIVATE });
  return Response.json(view(row), { headers: PRIVATE });
}

export async function POST(_request: Request, ctx: RouteContext<"/api/owner/domains/[id]">) {
  const { id } = await ctx.params;
  const { session, row } = await read(id);
  if (!session) return Response.json({ error: "login" }, { status: 401, headers: PRIVATE });
  if (!row) return Response.json({ error: "not_found" }, { status: 404, headers: PRIVATE });
  const { error } = await callDomains(session.supabase, { action: "recheck", order_id: id });
  const fresh = (await read(id)).row ?? row;
  return Response.json({ ...view(fresh), error }, { status: error === "too_soon" ? 429 : 200, headers: PRIVATE });
}
