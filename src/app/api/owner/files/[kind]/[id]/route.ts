import { getSession } from "@/lib/auth";

/**
 * "Open" for one of the owner's own PDFs or pictures in Môj obchod: redirects to a 10-minute
 * signed address from the doc-ingest function, which checks with the owner's own login (RLS)
 * that the file belongs to one of their shops. Never for shoppers: they open files only
 * through /api/shops/<slug>/files, where the database decides.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

export async function GET(_request: Request, ctx: RouteContext<"/api/owner/files/[kind]/[id]">) {
  const { kind, id } = await ctx.params;
  if ((kind !== "document" && kind !== "picture") || !UUID.test(id)) {
    return new Response("Not found", { status: 404, headers: PRIVATE });
  }
  const session = await getSession();
  if (!session) return new Response("Please log in", { status: 401, headers: PRIVATE });
  const { data, error } = await session.supabase.functions.invoke<{ url?: string }>("doc-ingest", {
    body: { action: "open_file", kind, id },
  });
  const url = error ? null : data?.url;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return new Response("Not found", { status: 404, headers: PRIVATE });
  return new Response(null, { status: 302, headers: { Location: url, ...PRIVATE } });
}
