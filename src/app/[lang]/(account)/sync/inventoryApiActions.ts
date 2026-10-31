"use server";

import { getSession } from "@/lib/auth";

/**
 * "Pripojiť skladový program (API)" (database update 49), called from the owner's browser. The key never comes here:
 * it goes from the browser straight to the inventory-connect function. These two only approve the fields and
 * disconnect; owner_inventory_* checks the membership again.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = ["source_code", "name", "ean", "brand", "quantity", "price", "currency", "description", "category"];

type Result = { ok: true } | { ok: false; error: string };

async function owner() {
  const s = await getSession();
  return s?.supabase ?? null;
}

/** "Schváliť a spustiť": the owner's mapping (program field per Cacaduu field) and, without quantities, the consent. */
export async function approveInventory(input: { shopId: string; mapping: Record<string, string>; withoutQuantity: boolean }): Promise<Result> {
  const supabase = await owner();
  if (!supabase || !UUID.test(input.shopId)) return { ok: false, error: "login" };
  const mapping = Object.fromEntries(
    Object.entries(input.mapping ?? {}).filter(([field, column]) => FIELDS.includes(field) && typeof column === "string" && column.length > 0 && column.length <= 200),
  );
  const { error } = await supabase.rpc("owner_inventory_approve", {
    p_shop_id: input.shopId,
    p_mapping: mapping,
    p_without_quantity: Boolean(input.withoutQuantity),
  });
  if (error) return { ok: false, error: ["mapping", "not_connected", "invalid_key"].includes(error.message) ? error.message : "failed" };
  return { ok: true };
}

/** "Odpojiť": the row with the encrypted key is deleted at once; files are accepted again. */
export async function disconnectInventory(shopId: string): Promise<Result> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "login" };
  const { error } = await supabase.rpc("owner_inventory_disconnect", { p_shop_id: shopId });
  if (error) return { ok: false, error: "failed" };
  return { ok: true };
}
