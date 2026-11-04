import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * CRM → Správy, "Komu": the shop's contacts that match the typed words (owner_contact_search: members only, only this
 * shop's contacts). The owner's own data on the owner's own screen; never cached.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "login" }, { status: 401 });
  const shop = request.nextUrl.searchParams.get("shop_id") ?? "";
  const q = (request.nextUrl.searchParams.get("q") ?? "").slice(0, 100);
  if (!UUID.test(shop)) return NextResponse.json({ error: "shop" }, { status: 400 });
  if (!q.trim()) return NextResponse.json({ rows: [] }, { headers: { "Cache-Control": "no-store" } });
  const { data, error } = await session.supabase.rpc("owner_contact_search", { p_shop_id: shop, p_q: q, p_limit: 8 });
  if (error) return NextResponse.json({ error: "failed" }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}
