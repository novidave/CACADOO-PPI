import "server-only";
import { cache } from "react";
import { productPhotoUrl } from "./productPhotos";
import type { ShopTexts } from "./contentTranslations";
import { readMenu, type MenuCategory, type MenuDish, type ShopMenu } from "./menuRules";
import { supabaseEnv } from "./supabase/env";
import { createCachedPublicClient } from "./supabase/public";

/**
 * A restaurant's public Menu (update 80): shop_menu(slug) decides everything (active shops of kind food only; the
 * dishes that are not hidden, their sizes and prices from Sklad, "Vypredané dnes" until the shop's midnight, a tracked
 * item's stock). null = not a restaurant (or before update 80). Read through the short shared cache like every public
 * read; the owner's saves refresh it at once. The dish's photo (update 78's file, the owner's OK of 2026-11-05: a
 * restaurant's Menu shows its dishes' photos) gets its public address here.
 */
export const getShopMenu = cache(async (slug: string): Promise<ShopMenu | null> => {
  const db = createCachedPublicClient();
  if (!db) return null;
  const { data, error } = await db.rpc("shop_menu", { p_slug: slug });
  if (error || !data) return null;
  return withPhotoUrls(readMenu(data));
});

/** The dishes' photos with their public addresses (shop_menu() gives the stored paths). */
export function withPhotoUrls(menu: ShopMenu | null): ShopMenu | null {
  const env = supabaseEnv();
  if (!menu || !env) return menu;
  for (const dish of menu.items) {
    if (dish.photo) dish.photo = { ...dish.photo, large: productPhotoUrl(env.url, dish.photo.large), small: productPhotoUrl(env.url, dish.photo.small) };
  }
  return menu;
}

/** A dish photo's address on the owner's editor (its version against a cached old one). */
export function dishPhotoSrc(path: string, v: number): string {
  const env = supabaseEnv();
  return env ? `${productPhotoUrl(env.url, path)}?v=${v}` : "";
}

/** "Hľadať v menu": the dishes' ids, the best first (update 54's forgiving rule in shop_menu_search). */
export async function searchShopMenu(slug: string, q: string): Promise<string[]> {
  const query = q.trim().slice(0, 200);
  if (query.length < 2) return [];
  const db = createCachedPublicClient();
  if (!db) return [];
  const { data, error } = await db.rpc("shop_menu_search", { p_slug: slug, p_q: query });
  if (error || !Array.isArray(data)) return [];
  return (data as { item_id?: unknown }[]).flatMap((r) => (typeof r.item_id === "string" ? [r.item_id] : []));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The restaurant and the dish of a menu item (update 84): `{slug, dish}` for a dish or one of its sizes (a size gives
 * its dish) while the Menu shows it, else null — the item page then shows the dish (the product page's design).
 */
export const menuDishOf = cache(async (id: string): Promise<{ slug: string; dish: string } | null> => {
  if (!UUID.test(id)) return null;
  const db = createCachedPublicClient();
  if (!db) return null;
  const { data, error } = await db.rpc("shop_menu_dish_of", { p_item: id });
  if (error || !data || typeof data !== "object") return null;
  const r = data as { slug?: unknown; dish?: unknown };
  return typeof r.slug === "string" && typeof r.dish === "string" ? { slug: r.slug, dish: r.dish } : null;
});

/** A category's name in the page language: the translation of its dishes' category (update 40's item_category). */
export function categoryName(category: MenuCategory | null, dishes: MenuDish[], texts: ShopTexts | null, other: string) {
  if (!category) return other;
  const first = dishes[0];
  return texts && first ? texts.text("item_category", first.id, category.name) : category.name;
}
