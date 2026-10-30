import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { exportCsv, type ExportRow } from "@/lib/conversationExport";
import { PRIVATE, UUID } from "@/lib/conversationPdfs";
import { sectionUrl } from "@/lib/dashboardPages";
import { getSession } from "@/lib/auth";
import type { MyShop } from "@/lib/myShops";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "Stiahnuť CSV" (database update 55): every message of the shop's conversations that started between two days (the
 * shop's time zone), one row each, for Excel. owner_conversations_export() decides (members of the shop only, at most
 * 50 000 rows) and writes the export in the activity log.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const shopId = url.searchParams.get("shop") ?? "";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const langParam = url.searchParams.get("lang") ?? "";
  const lang: Locale = isLocale(langParam) ? langParam : "sk";
  const session = await getSession();
  if (!session) return new Response("Please log in", { status: 401, headers: PRIVATE });
  const { supabase } = session;
  const { data: shopRows } = await supabase.rpc("my_shops");
  const shop = ((shopRows ?? []) as MyShop[]).find((s) => s.id === shopId);
  if (!UUID.test(shopId) || !shop) return new Response("Not found", { status: 404, headers: PRIVATE });
  const back = (err: string) =>
    new Response(null, { status: 303, headers: { ...PRIVATE, Location: sectionUrl(lang, "conversations", { shop: shop.slug, err }) } });
  if (!DAY.test(from) || !DAY.test(to) || to < from) return back("conversations_range");

  const { data, error } = await supabase.rpc("owner_conversations_export", { p_shop_id: shop.id, p_from: from, p_to: to });
  if (error) return back(error.code === "22023" ? "conversations_range" : "conversations_export");
  const c = (await getDictionary(lang)).conversations;
  const csv = exportCsv((data ?? []) as ExportRow[], shop.timezone, {
    header: [
      c.csv_conversation,
      c.csv_started,
      c.csv_status,
      c.csv_starred,
      c.csv_unanswered,
      c.csv_access_key,
      c.csv_language,
      c.csv_time,
      c.csv_role,
      c.csv_text,
      c.csv_text_owner,
      c.csv_files,
      c.csv_products,
    ],
    yes: c.yes,
    no: c.no,
    shopper: c.shopper,
    assistant: c.assistant,
    status: { new: c.status_new, read: c.status_read, archived: c.status_archived },
  });
  return new Response(csv, {
    headers: {
      ...PRIVATE,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="konverzacie_${from}_${to}.csv"`,
    },
  });
}
