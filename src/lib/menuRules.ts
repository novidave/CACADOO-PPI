/**
 * A restaurant's menu (update 80, 2026-11-05): the rules shared by the shop page, the owner's editor, the chat route
 * and the tests. No imports (the browser and Deno read it). Every decision about prices, sizes, "Vypredané dnes" and
 * what is shown lives in SQL (`shop_menu`, `food_item`, `food_quote`); this file only shapes what SQL returned.
 */

/** The EU's 14 allergens (Regulation 1169/2011, Annex II), by their usual numbers; names in the message files. */
export const ALLERGENS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
export type Allergen = (typeof ALLERGENS)[number];

/** The tags a dish may carry ("Vegetariánske", "Pikantné"). */
export const MENU_TAGS = ["veg", "spicy"] as const;
export type MenuTag = (typeof MENU_TAGS)[number];

export interface MenuVariant {
  id: string;
  label: string;
  price_cents: number;
  tracked: boolean;
  sold_out: boolean;
}

export interface MenuPhoto {
  large: string;
  small: string;
  width: number;
  height: number;
}

export interface MenuDish {
  id: string;
  name: string;
  name_i18n: Record<string, string> | null;
  description: string | null;
  category_id: string | null;
  /** null for a dish with sizes (each size has its own price). */
  price_cents: number | null;
  variants: MenuVariant[];
  /** "Sledovať zásobu": the dish's own Sklad quantity decides (a stock dot); off = available until "Vypredané dnes". */
  tracked: boolean;
  sold_out: boolean;
  allergens: number[];
  tags: MenuTag[];
  photo: MenuPhoto | null;
}

export interface MenuCategory {
  id: string;
  name: string;
}

export interface ShopMenu {
  today: string;
  currency: string;
  categories: MenuCategory[];
  items: MenuDish[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What shop_menu() returned, checked (anything unexpected is dropped, never guessed). */
export function readMenu(raw: unknown): ShopMenu | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { today?: unknown; currency?: unknown; categories?: unknown; items?: unknown };
  const cents = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const categories = (Array.isArray(r.categories) ? r.categories : []).flatMap((c): MenuCategory[] => {
    const x = c as { id?: unknown; name?: unknown };
    return typeof x?.id === "string" && typeof x.name === "string" ? [{ id: x.id, name: x.name }] : [];
  });
  const items = (Array.isArray(r.items) ? r.items : []).flatMap((d): MenuDish[] => {
    const x = d as Record<string, unknown>;
    if (typeof x?.id !== "string" || typeof x.name !== "string") return [];
    const variants = (Array.isArray(x.variants) ? x.variants : []).flatMap((v): MenuVariant[] => {
      const y = v as Record<string, unknown>;
      const price = cents(y?.price_cents);
      return typeof y?.id === "string" && typeof y.label === "string" && price !== null
        ? [{ id: y.id, label: y.label, price_cents: price, tracked: y.tracked === true, sold_out: y.sold_out === true }]
        : [];
    });
    const price = cents(x.price_cents);
    if (price === null && variants.length === 0) return [];
    const p = x.photo as Record<string, unknown> | null;
    const photo =
      p && typeof p.large === "string" && typeof p.small === "string" && typeof p.width === "number" && typeof p.height === "number"
        ? { large: p.large, small: p.small, width: p.width, height: p.height }
        : null;
    return [{
      id: x.id,
      name: x.name,
      name_i18n: x.name_i18n && typeof x.name_i18n === "object" ? (x.name_i18n as Record<string, string>) : null,
      description: typeof x.description === "string" && x.description.trim() ? x.description : null,
      category_id: typeof x.category_id === "string" ? x.category_id : null,
      price_cents: variants.length ? null : price,
      variants,
      tracked: x.tracked === true,
      sold_out: x.sold_out === true,
      allergens: (Array.isArray(x.allergens) ? x.allergens : []).filter((a): a is number => Number.isInteger(a) && a >= 1 && a <= 14),
      tags: (Array.isArray(x.tags) ? x.tags : []).filter((t): t is MenuTag => (MENU_TAGS as readonly unknown[]).includes(t)),
      photo,
    }];
  });
  return {
    today: typeof r.today === "string" ? r.today : "",
    currency: typeof r.currency === "string" ? r.currency : "EUR",
    categories,
    items,
  };
}

/** The menu's sections in the owner's order: each category with its dishes, then the dishes without one. */
export function menuSections(menu: ShopMenu): { category: MenuCategory | null; dishes: MenuDish[] }[] {
  const known = new Set(menu.categories.map((c) => c.id));
  const sections = menu.categories
    .map((category) => ({ category, dishes: menu.items.filter((d) => d.category_id === category.id) }))
    .filter((s) => s.dishes.length > 0);
  const rest = menu.items.filter((d) => !d.category_id || !known.has(d.category_id));
  return rest.length ? [...sections, { category: null, dishes: rest }] : sections;
}

/** The allergens the shown dishes carry (the legend lists only those), in their numbers' order. */
export function allergenLegend(dishes: { allergens: number[] }[]): number[] {
  return [...new Set(dishes.flatMap((d) => d.allergens))].filter((a) => a >= 1 && a <= 14).sort((a, b) => a - b);
}

/** What "Objednať" sends to the chat route: the menu items' ids (a dish or one size), at most 10, each once. */
export function cleanOrderItems(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 10) return null;
  const ids: string[] = [];
  for (const id of raw) {
    if (typeof id !== "string" || !UUID.test(id)) return null;
    if (!ids.includes(id.toLowerCase())) ids.push(id.toLowerCase());
  }
  return ids;
}

/** The orderable lines of a dish: its sizes, or the dish itself (sold out ones stay, marked). */
export function orderLines(dish: MenuDish): { id: string; label: string | null; price_cents: number; sold_out: boolean; tracked: boolean }[] {
  if (dish.variants.length) {
    return dish.variants.map((v) => ({ id: v.id, label: v.label, price_cents: v.price_cents, sold_out: v.sold_out || dish.sold_out, tracked: v.tracked }));
  }
  return [{ id: dish.id, label: null, price_cents: dish.price_cents ?? 0, sold_out: dish.sold_out, tracked: dish.tracked }];
}

/**
 * The restaurant page's rows (update 84: the dishes in the shop page's "Jedlá / Zoznam" box): every orderable line —
 * a dish, or each of its sizes — in the owner's order, or in the search's order (`found` = shop_menu_search's dish ids,
 * best first; ids the menu does not show are dropped). Sold out = "Vypredané dnes" (the dish's mark covers its sizes) or
 * a tracked line's Sklad quantity, as shop_menu() decided.
 */
export function menuRowLines(menu: ShopMenu, found: string[] | null): { dish: MenuDish; id: string; label: string | null; price_cents: number; sold_out: boolean }[] {
  const byId = new Map(menu.items.map((d) => [d.id, d]));
  const dishes = found ? [...new Set(found)].flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])) : menu.items;
  return dishes.flatMap((dish) => orderLines(dish).map((l) => ({ dish, id: l.id, label: l.label, price_cents: l.price_cents, sold_out: l.sold_out })));
}

const money = (cents: number) => (cents / 100).toFixed(2);

/**
 * schema.org's Menu for the restaurant's page (JSON-LD, under `hasMenu` of the Restaurant): MenuSection per category,
 * MenuItem per dish with one Offer (or one per size), sold out today = SoldOut, vegetarian = VegetarianDiet. Names,
 * descriptions and sections as the page shows them (`text` gives the page language's words).
 */
export function menuJsonLd(
  menu: ShopMenu,
  url: string,
  text: {
    name: (dish: MenuDish) => string;
    description: (dish: MenuDish) => string | null;
    section: (category: MenuCategory | null) => string;
    image?: (photo: MenuPhoto) => string;
  },
) {
  const offer = (cents: number, soldOut: boolean, name?: string) => ({
    "@type": "Offer",
    ...(name ? { name } : {}),
    price: money(cents),
    priceCurrency: menu.currency,
    availability: soldOut ? "https://schema.org/SoldOut" : "https://schema.org/InStock",
  });
  return {
    "@type": "Menu",
    "@id": `${url}#menu`,
    url: `${url}#menu`,
    hasMenuSection: menuSections(menu).map((s) => ({
      "@type": "MenuSection",
      name: text.section(s.category),
      hasMenuItem: s.dishes.map((dish) => {
        const description = text.description(dish);
        return {
          "@type": "MenuItem",
          name: text.name(dish),
          ...(description ? { description } : {}),
          ...(dish.photo && text.image ? { image: text.image(dish.photo) } : {}),
          ...(dish.tags.includes("veg") ? { suitableForDiet: "https://schema.org/VegetarianDiet" } : {}),
          offers: dish.variants.length
            ? dish.variants.map((v) => offer(v.price_cents, v.sold_out || dish.sold_out, v.label))
            : offer(dish.price_cents ?? 0, dish.sold_out),
        };
      }),
    })),
  };
}

/** One row of the import's review table (the AI's proposal, then the owner's edits); prices as typed text. */
export interface ImportRow {
  category: string;
  name: string;
  description: string;
  price: string;
  variants: { label: string; price: string }[];
  allergens: number[];
  tags: MenuTag[];
}

const priceText = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 100_000 ? v.toFixed(2) : "");
const plainText = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * What the AI proposed from a menu PDF or photo, made safe for the review table: rows without a dish name dropped,
 * text cut to the database's lengths, prices as 2-decimal text (no price = empty, never guessed), at most 8 sizes,
 * allergens only 1–14 each once, tags only veg / spicy; at most 300 rows (the database's limit for one import).
 */
export function cleanImportRows(raw: unknown): ImportRow[] {
  const rows = raw && typeof raw === "object" && Array.isArray((raw as { dishes?: unknown }).dishes) ? (raw as { dishes: unknown[] }).dishes : [];
  return rows.flatMap((r): ImportRow[] => {
    const x = (r ?? {}) as Record<string, unknown>;
    const name = plainText(x.name, 200);
    if (!name) return [];
    const variants = (Array.isArray(x.sizes) ? x.sizes : []).flatMap((s) => {
      const y = (s ?? {}) as Record<string, unknown>;
      const label = plainText(y.label, 40);
      return label ? [{ label, price: priceText(y.price) }] : [];
    }).slice(0, 8);
    return [{
      category: plainText(x.category, 60),
      name,
      description: plainText(x.description, 600),
      price: variants.length ? "" : priceText(x.price),
      variants,
      allergens: [...new Set((Array.isArray(x.allergens) ? x.allergens : []).filter((a): a is number => Number.isInteger(a) && a >= 1 && a <= 14))].sort((a, b) => a - b),
      tags: [...new Set((Array.isArray(x.tags) ? x.tags : []).filter((t): t is MenuTag => (MENU_TAGS as readonly unknown[]).includes(t)))],
    }];
  }).slice(0, 300);
}

/** "1, 3,7" → [1, 3, 7] (numbers 1–14 only, each once). */
export function allergensFromText(text: string): number[] {
  return [...new Set(text.split(/[^0-9]+/).filter(Boolean).map(Number).filter((n) => n >= 1 && n <= 14))].sort((a, b) => a - b);
}
