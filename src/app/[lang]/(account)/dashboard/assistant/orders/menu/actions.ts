"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { refreshShop } from "@/lib/publicCache";

/**
 * Objednávky jedla → Menu (database update 80): the owner's categories and dishes. Every rule is in SQL
 * (owner_menu_* — members; Sklad's products, prices with VAT, the plan's product limit, sizes, "Vypredané dnes" until
 * the shop's midnight), so nothing here is trusted: the forms only carry what the owner typed. Each save refreshes the
 * shop's public pages (its Menu).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = ["name", "price", "category", "name_taken", "not_empty", "allergens", "tags", "variants", "label", "plan_limit", "rows"] as const;
const reason = (message: string | undefined) => {
  const found = REASONS.find((r) => r === message);
  if (!found) return "err_failed";
  if (found === "plan_limit") return "err_limit";
  if (found === "label") return "err_variants";
  if (found === "tags") return "err_failed";
  return `err_${found}`;
};

async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const page = (query: Record<string, string>, anchor = ""): never => {
    redirect(`/${lang}/dashboard/assistant/orders/menu?${new URLSearchParams({ ...(slug ? { shop: slug } : {}), ...query })}${anchor}`);
  };
  const done = (ok: string, anchor = "", extra: Record<string, string> = {}): never => {
    if (slug) refreshShop(slug);
    return page({ ok, ...extra }, anchor);
  };
  return { lang, session, shopId, slug, page, done };
}

const text = (formData: FormData, name: string, max: number) => String(formData.get(name) ?? "").trim().slice(0, max);
const ids = (value: string) => {
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string" && UUID.test(id)).slice(0, 300) : [];
  } catch {
    return [];
  }
};

/** "Pridať kategóriu" / "Premenovať". */
export async function saveCategory(formData: FormData) {
  const { session, shopId, page, done } = await start(formData);
  const id = text(formData, "category_id", 40);
  const { error } = await session.supabase.rpc("owner_menu_save_category", {
    p_shop_id: shopId,
    p_id: UUID.test(id) ? id : null,
    p_name: text(formData, "name", 80),
  });
  if (error) page({ err: reason(error.message) }, "#categories");
  done("ok_category", "#categories");
}

/** "Zmazať kategóriu": only an empty one (SQL refuses one with dishes). */
export async function deleteCategory(formData: FormData) {
  const { session, shopId, page, done } = await start(formData);
  const id = text(formData, "category_id", 40);
  if (!UUID.test(id)) page({ err: "err_failed" });
  const { error } = await session.supabase.rpc("owner_menu_delete_category", { p_shop_id: shopId, p_id: id });
  if (error) page({ err: reason(error.message) }, "#categories");
  done("ok_category_deleted", "#categories");
}

/** The categories' order (drag or ▲ ▼), all ids in their new order. */
export async function orderCategories(formData: FormData) {
  const { session, shopId, page, done } = await start(formData);
  const { error } = await session.supabase.rpc("owner_menu_order_categories", { p_shop_id: shopId, p_ids: ids(text(formData, "ids", 20_000)) });
  if (error) page({ err: reason(error.message) }, "#categories");
  done("ok_order", "#categories");
}

/** The dishes' order inside a category. */
export async function orderDishes(formData: FormData) {
  const { session, shopId, page, done } = await start(formData);
  const anchor = `#cat-${text(formData, "anchor", 40)}`;
  const { error } = await session.supabase.rpc("owner_menu_order_items", { p_shop_id: shopId, p_ids: ids(text(formData, "ids", 20_000)) });
  if (error) page({ err: reason(error.message) }, anchor);
  done("ok_order", anchor);
}

/** The dish form ("Nové jedlo" / "Upraviť"): name, description, category, price or sizes, allergens, tags, tracking. */
export async function saveDish(formData: FormData) {
  const { session, shopId, page, done } = await start(formData);
  const id = text(formData, "item_id", 40);
  const labels = formData.getAll("size_label").map((v) => String(v).trim().slice(0, 60));
  const prices = formData.getAll("size_price").map((v) => String(v).trim().slice(0, 20));
  const sizeIds = formData.getAll("size_id").map((v) => String(v));
  const variants = labels
    .map((label, i) => ({ id: UUID.test(sizeIds[i] ?? "") ? sizeIds[i] : null, label, price: prices[i] ?? "" }))
    .filter((v) => v.label || v.price)
    .map((v) => (v.id ? v : { label: v.label, price: v.price }));
  const category = text(formData, "category_id", 40);
  const body = {
    name: text(formData, "name", 220),
    description: text(formData, "description", 620),
    category_id: UUID.test(category) ? category : null,
    price: text(formData, "price", 20),
    allergens: formData.getAll("allergen").map((v) => Number(v)).filter((n) => Number.isInteger(n)),
    tags: formData.getAll("tag").map((v) => String(v)),
    track_stock: formData.get("track_stock") === "on",
    hidden: formData.get("hidden") === "on",
    variants,
  };
  const { data, error } = await session.supabase.rpc("owner_menu_save_item", { p_shop_id: shopId, p_item_id: UUID.test(id) ? id : null, p: body });
  if (error) page({ err: reason(error.message), ...(UUID.test(id) ? { edit: id } : { edit: "new" }) }, "#dish");
  done("ok_saved", `#dish-${data}`, { edit: String(data) });
}

/** The inline price of a dish without sizes, or the prices of its sizes (each size keeps its name). */
export async function saveDishPrice(formData: FormData) {
  const { session, shopId, page, done } = await start(formData);
  const id = text(formData, "item_id", 40);
  if (!UUID.test(id)) page({ err: "err_failed" });
  const sizeIds = formData.getAll("size_id").map((v) => String(v));
  const labels = formData.getAll("size_label").map((v) => String(v));
  const prices = formData.getAll("size_price").map((v) => String(v).trim().slice(0, 20));
  const p = sizeIds.length
    ? { variants: sizeIds.map((sid, i) => ({ id: UUID.test(sid) ? sid : null, label: labels[i] ?? "", price: prices[i] ?? "" })) }
    : { price: text(formData, "price", 20) };
  const { error } = await session.supabase.rpc("owner_menu_save_item", { p_shop_id: shopId, p_item_id: id, p });
  if (error) page({ err: reason(error.message) }, `#dish-${id}`);
  done("ok_saved", `#dish-${id}`);
}

/** "Skryť" / "Zobraziť". */
export async function setDishHidden(formData: FormData) {
  const { session, shopId, page, done } = await start(formData);
  const id = text(formData, "item_id", 40);
  const hidden = formData.get("hidden") === "1";
  if (!UUID.test(id)) page({ err: "err_failed" });
  const { error } = await session.supabase.rpc("owner_menu_save_item", { p_shop_id: shopId, p_item_id: id, p: { hidden } });
  if (error) page({ err: reason(error.message) }, `#dish-${id}`);
  done(hidden ? "ok_hidden" : "ok_shown", `#dish-${id}`);
}

/** "Duplikovať": the same dish with its sizes, right after the original. */
export async function duplicateDish(formData: FormData) {
  const { session, shopId, page, done } = await start(formData);
  const id = text(formData, "item_id", 40);
  if (!UUID.test(id)) page({ err: "err_failed" });
  const { data, error } = await session.supabase.rpc("owner_menu_duplicate_item", { p_shop_id: shopId, p_item_id: id });
  if (error) page({ err: reason(error.message) }, `#dish-${id}`);
  done("ok_duplicated", `#dish-${data}`);
}

/** "Vypredané dnes" on / off (one tap; ends by itself at the shop's midnight). */
export async function setSoldOut(formData: FormData) {
  const { session, shopId, page, done } = await start(formData);
  const id = text(formData, "item_id", 40);
  const on = formData.get("sold_out") === "1";
  const anchor = `#dish-${text(formData, "dish_id", 40) || id}`;
  if (!UUID.test(id)) page({ err: "err_failed" });
  const { error } = await session.supabase.rpc("owner_menu_set_sold_out", { p_shop_id: shopId, p_item_id: id, p_sold_out: on });
  if (error) page({ err: reason(error.message) }, anchor);
  done(on ? "ok_sold_out" : "ok_back", anchor);
}

export interface ImportRowInput {
  category: string;
  name: string;
  description: string;
  price: string;
  variants: { label: string; price: string }[];
  allergens: number[];
  tags: string[];
}

/**
 * "Uložiť do menu" after the import's review: the rows the owner kept and edited, in ONE transaction
 * (owner_menu_import_save: all or nothing; nothing was stored before). Prices exactly as the owner confirmed them.
 */
export async function saveImport(shopId: string, slug: string, rows: ImportRowInput[]): Promise<{ ok: true; dishes: number } | { ok: false; error: string; row?: number }> {
  const session = await getSession();
  if (!session) return { ok: false, error: "err_failed" };
  if (!UUID.test(shopId) || !Array.isArray(rows) || rows.length === 0) return { ok: false, error: "err_rows" };
  const clean = rows.slice(0, 300).map((r) => ({
    category: String(r.category ?? "").trim().slice(0, 60),
    name: String(r.name ?? "").trim().slice(0, 200),
    description: String(r.description ?? "").trim().slice(0, 600),
    price: String(r.price ?? "").trim().slice(0, 20),
    variants: (Array.isArray(r.variants) ? r.variants : []).slice(0, 8).map((v) => ({ label: String(v.label ?? "").trim().slice(0, 40), price: String(v.price ?? "").trim().slice(0, 20) })),
    allergens: (Array.isArray(r.allergens) ? r.allergens : []).filter((a) => Number.isInteger(a) && a >= 1 && a <= 14),
    tags: (Array.isArray(r.tags) ? r.tags : []).filter((t) => t === "veg" || t === "spicy"),
  }));
  const { data, error } = await session.supabase.rpc("owner_menu_import_save", { p_shop_id: shopId, p_rows: clean });
  if (error) return { ok: false, error: reason(error.message) };
  if (slug) refreshShop(slug);
  return { ok: true, dishes: Number((data as { dishes?: number } | null)?.dishes ?? clean.length) };
}
