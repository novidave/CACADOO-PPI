import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { getSession } from "@/lib/auth";
import type { MyShop } from "@/lib/myShops";
import { isKind, movementsSheet, productsSheet, type MovementRow, type SkladKind, type SkladRow } from "@/lib/sklad";
import { writeXlsx } from "@/lib/xlsx";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PRIVATE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

/**
 * Sklad → Export (database update 67): "Produkty (XLSX)" (every Sklad product, a column per location) and "Pohyby
 * (XLSX)" (the same filters as the Pohyby page, ≤ 50 000 rows; the purchase price only on receipts). Only the shop's
 * owners: owner_sklad_products / owner_sklad_movements decide; the file is never cached.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const shopId = url.searchParams.get("shop") ?? "";
  const kindParam = url.searchParams.get("kind");
  const kind = kindParam === "movements" ? "movements" : kindParam === "count" ? "count" : "products";
  const langParam = url.searchParams.get("lang") ?? "";
  const lang: Locale = isLocale(langParam) ? langParam : "sk";
  const session = await getSession();
  if (!session) return new Response("Please log in", { status: 401, headers: PRIVATE });
  const { supabase } = session;
  const { data: shopRows } = await supabase.rpc("my_shops");
  const shop = ((shopRows ?? []) as MyShop[]).find((s) => s.id === shopId);
  if (!UUID.test(shopId) || !shop) return new Response("Not found", { status: 404, headers: PRIVATE });
  const s = (await getDictionary(lang)).sklad;
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: shop.timezone }).format(new Date());

  let rows: string[][];
  let countNo = "";
  if (kind === "count") {
    // update 70: one count's report — every counted product, expected (at its count time), counted, difference, value
    const countId = url.searchParams.get("count") ?? "";
    if (!UUID.test(countId)) return new Response("Not found", { status: 404, headers: PRIVATE });
    const { data, error } = await supabase.rpc("owner_sklad_count_diff", { p_shop_id: shop.id, p_count_id: countId });
    if (error || !data) return new Response("Export failed", { status: 500, headers: PRIVATE });
    const d = data as { count: { number: string }; rows: { name: string; code: string | null; expected: number; counted: number; diff: number; value: number | null; who: string | null; recount: boolean }[] };
    countNo = d.count.number;
    rows = [
      [s.x_product, s.x_code, s.ic_x_expected, s.ic_x_counted, s.ic_x_diff, s.ic_x_value, s.ic_x_who, s.ic_x_recount],
      ...d.rows.map((r) => [r.name, r.code ?? "", String(r.expected), String(r.counted), String(r.diff), r.value === null ? "" : String(r.value), r.who ?? "", r.recount ? "✓" : ""]),
    ];
  } else if (kind === "products") {
    const all: SkladRow[] = [];
    for (let offset = 0; offset < 100_000; offset += 500) {
      const { data, error } = await supabase.rpc("owner_sklad_products", { p_shop_id: shop.id, p_q: null, p_filter: "all", p_limit: 500, p_offset: offset });
      if (error) return new Response("Export failed", { status: 500, headers: PRIVATE });
      const page = (data as { rows: SkladRow[] }).rows;
      all.push(...page);
      if (page.length < 500) break;
    }
    rows = productsSheet(all, { name: s.x_name, code: s.x_code, ean: s.x_ean, unit: s.x_unit, price: s.x_price, min: s.x_min, shelf: s.x_shelf, total: s.x_total });
  } else {
    const item = url.searchParams.get("item") ?? "";
    const mkind = url.searchParams.get("mkind") ?? "";
    const loc = url.searchParams.get("loc") ?? "";
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    const { data, error } = await supabase.rpc("owner_sklad_movements", {
      p_shop_id: shop.id,
      p_item_id: UUID.test(item) ? item : null,
      p_kind: isKind(mkind) ? mkind : null,
      p_location_id: UUID.test(loc) ? loc : null,
      p_from: DAY.test(from) ? from : null,
      p_to: DAY.test(to) ? to : null,
      p_limit: 50_000,
      p_offset: 0,
    });
    if (error) return new Response("Export failed", { status: 500, headers: PRIVATE });
    const kinds = Object.fromEntries(
      (["receipt", "sale", "writeoff", "count", "correction", "transfer"] as SkladKind[]).map((k) => [k, (s as Record<string, string>)[`kind_${k}`] ?? k]),
    ) as Record<SkladKind, string>;
    rows = movementsSheet(
      (data as { rows: MovementRow[] }).rows,
      { time: s.x_time, product: s.x_product, code: s.x_code, kind: s.x_kind, qty: s.x_qty, location: s.x_location, to: s.x_to, cost: s.x_cost, reason: s.x_reason, ref: s.x_ref, device: s.x_device },
      kinds,
      shop.timezone,
    );
  }
  const sheet = kind === "products" ? s.x_sheet_products : kind === "count" ? s.ic_x_sheet : s.x_sheet_movements;
  const bytes = await writeXlsx([{ name: sheet, rows, header: true }]);
  const file = kind === "count" ? `inventura-${countNo}-${shop.slug}.xlsx` : `${kind === "products" ? "sklad-produkty" : "sklad-pohyby"}-${shop.slug}-${day}.xlsx`;
  return new Response(bytes as BodyInit, {
    headers: {
      ...PRIVATE,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${file}"`,
    },
  });
}
