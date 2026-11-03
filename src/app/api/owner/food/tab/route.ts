import { getSession } from "@/lib/auth";
import { foodTab } from "@/lib/foodOwner";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

/**
 * Asistent → Objednávky (database update 74): read every 10 s by the open page — whether ordering is on, how many
 * orders are new and when the last one came (owner_food_tab: members only). No order data; never cached.
 */
export async function GET(request: Request) {
  const shopId = new URL(request.url).searchParams.get("shop") ?? "";
  const session = await getSession();
  if (!session) return Response.json({ error: "login" }, { status: 401, headers: PRIVATE });
  if (!UUID.test(shopId)) return Response.json({ error: "shop" }, { status: 404, headers: PRIVATE });
  const tab = await foodTab(session.supabase, shopId);
  if (!tab) return Response.json({ error: "forbidden" }, { status: 403, headers: PRIVATE });
  return Response.json(tab, { headers: PRIVATE });
}
