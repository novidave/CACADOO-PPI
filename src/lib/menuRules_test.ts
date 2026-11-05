// `npm run test:food` (with food_test.ts) — a restaurant's menu on the website (update 80). What is shown, sold out
// today, priced and orderable is decided in SQL (DB block "update 80"); these tests check how the page shapes it: the
// sections in the owner's order, the allergen legend (only the numbers used, every name in sk / hu / en), schema.org's
// Menu JSON-LD, what "Objednať" may send to the chat route, and that what shop_menu() returned is read strictly.
import { assert, assertEquals } from "jsr:@std/assert@1";
import en from "../i18n/messages/en.json" with { type: "json" };
import hu from "../i18n/messages/hu.json" with { type: "json" };
import sk from "../i18n/messages/sk.json" with { type: "json" };
import { ALLERGENS, allergenLegend, allergensFromText, cleanImportRows, cleanOrderItems, menuJsonLd, menuRowLines, menuSections, orderLines, readMenu } from "./menuRules.ts";

const PIZZA = "11111111-1111-4111-8111-111111111111";
const P32 = "22222222-2222-4222-8222-222222222222";
const P45 = "33333333-3333-4333-8333-333333333333";
const SOUP = "44444444-4444-4444-8444-444444444444";
const COLA = "55555555-5555-4555-8555-555555555555";

const raw = {
  today: "2026-11-05",
  currency: "EUR",
  categories: [{ id: "c-pizza", name: "Pizza" }, { id: "c-soup", name: "Polievky" }, { id: "c-empty", name: "Prázdna" }],
  items: [
    {
      id: PIZZA, name: "Pizza Diavola", name_i18n: { en: "Diavola pizza" }, description: "Saláma, feferóny", category_id: "c-pizza",
      price_cents: null, tracked: false, sold_out: false, allergens: [1, 7], tags: ["spicy"],
      variants: [
        { id: P32, label: "32 cm", price_cents: 750, tracked: false, sold_out: true },
        { id: P45, label: "45 cm", price_cents: 1190, tracked: false, sold_out: false },
      ],
      photo: { large: "s/i/a-1600.webp", small: "s/i/a-800.webp", width: 1600, height: 1200 },
    },
    { id: SOUP, name: "Kapustnica", description: "", category_id: "c-soup", price_cents: 320, tracked: false, sold_out: true, allergens: [9, 1], tags: ["veg"], variants: [] },
    { id: COLA, name: "Kofola 0,33 l", category_id: null, price_cents: 150, tracked: true, sold_out: false, allergens: [], tags: [], variants: [] },
    // dropped: no id, no price and no sizes, an unknown tag and allergen are filtered
    { name: "Bez id", price_cents: 100 },
    { id: "66666666-6666-4666-8666-666666666666", name: "Bez ceny", price_cents: null, variants: [] },
    { id: "77777777-7777-4777-8777-777777777777", name: "Divné", price_cents: 200, allergens: [0, 15, 3], tags: ["vegan", "veg"], variants: [] },
  ],
};

Deno.test("shop_menu() is read strictly: bad rows dropped, sizes carry the prices, unknown tags and allergens gone", () => {
  const menu = readMenu(raw)!;
  assertEquals(menu.items.map((d) => d.name), ["Pizza Diavola", "Kapustnica", "Kofola 0,33 l", "Divné"]);
  assertEquals(menu.items[0].price_cents, null);
  assertEquals(menu.items[0].variants.map((v) => v.price_cents), [750, 1190]);
  assertEquals(menu.items[1].description, null, "an empty description is none");
  assertEquals(menu.items[3].allergens, [3]);
  assertEquals(menu.items[3].tags, ["veg"]);
  assertEquals(readMenu(null), null, "not a restaurant");
  assertEquals(readMenu({ items: "x" })!.items, []);
});

Deno.test("the sections follow the owner's order, empty categories are left out, dishes without one come last", () => {
  const sections = menuSections(readMenu(raw)!);
  assertEquals(sections.map((s) => s.category?.name ?? null), ["Pizza", "Polievky", null]);
  assertEquals(sections[2].dishes.map((d) => d.name), ["Kofola 0,33 l", "Divné"]);
});

Deno.test("the allergen legend lists only the numbers the dishes carry, in order; every allergen has its name in sk / hu / en", () => {
  assertEquals(allergenLegend(readMenu(raw)!.items), [1, 3, 7, 9]);
  assertEquals(allergenLegend([]), []);
  assertEquals(ALLERGENS.length, 14);
  for (const [lang, dict] of [["sk", sk], ["hu", hu], ["en", en]] as const) {
    const menu = (dict as unknown as { menu: Record<string, string> }).menu;
    for (const a of ALLERGENS) assert(menu[`allergen_${a}`]?.trim(), `${lang}: menu.allergen_${a}`);
  }
});

Deno.test("Objednať: a dish without sizes is one line, a dish with sizes one line per size (a dish sold out today sells none)", () => {
  const menu = readMenu(raw)!;
  assertEquals(orderLines(menu.items[0]).map((l) => [l.id, l.label, l.price_cents, l.sold_out]), [[P32, "32 cm", 750, true], [P45, "45 cm", 1190, false]]);
  assertEquals(orderLines(menu.items[1]).map((l) => [l.id, l.label, l.sold_out]), [[SOUP, null, true]]);
  const soldDish = { ...menu.items[0], sold_out: true };
  assert(orderLines(soldDish).every((l) => l.sold_out));
});

Deno.test("what Objednať may send to the chat route: UUIDs only, each once, at most 10", () => {
  assertEquals(cleanOrderItems(undefined), []);
  assertEquals(cleanOrderItems([P45, P45.toUpperCase(), SOUP]), [P45, SOUP]);
  assertEquals(cleanOrderItems(["1; drop table"]), null);
  assertEquals(cleanOrderItems([{ id: P45 }]), null);
  assertEquals(cleanOrderItems(Array.from({ length: 11 }, () => P45)), null);
  assertEquals(cleanOrderItems("x"), null);
});

Deno.test("the Menu JSON-LD: sections, items, one offer per size, sold out today, vegetarian, the page's words", () => {
  const menu = readMenu(raw)!;
  const ld = menuJsonLd(menu, "https://davide.sk/", {
    name: (d) => d.name_i18n?.en ?? d.name,
    description: (d) => d.description,
    section: (c) => c?.name ?? "Other",
    image: (p) => `https://cdn.example/${p.large}`,
  });
  assertEquals(ld["@type"], "Menu");
  assertEquals(ld["@id"], "https://davide.sk/#menu");
  assertEquals(ld.hasMenuSection.map((s) => s.name), ["Pizza", "Polievky", "Other"]);
  const pizza = ld.hasMenuSection[0].hasMenuItem[0] as Record<string, unknown>;
  assertEquals(pizza.name, "Diavola pizza");
  assertEquals(pizza.image, "https://cdn.example/s/i/a-1600.webp");
  assertEquals(pizza.offers, [
    { "@type": "Offer", name: "32 cm", price: "7.50", priceCurrency: "EUR", availability: "https://schema.org/SoldOut" },
    { "@type": "Offer", name: "45 cm", price: "11.90", priceCurrency: "EUR", availability: "https://schema.org/InStock" },
  ]);
  const soup = ld.hasMenuSection[1].hasMenuItem[0] as Record<string, unknown>;
  assertEquals(soup.suitableForDiet, "https://schema.org/VegetarianDiet");
  assertEquals(soup.offers, { "@type": "Offer", price: "3.20", priceCurrency: "EUR", availability: "https://schema.org/SoldOut" });
  assert(!("description" in soup), "no empty description");
});

Deno.test("the import's proposal is made safe for the review table: no name = no row, prices only as written, sizes, allergens, tags", () => {
  const rows = cleanImportRows({
    dishes: [
      { category: " Pizza ", name: "Diavola", description: "saláma", price: 0, sizes: [{ label: "32 cm", price: 7.5 }, { label: "45 cm", price: 11.9 }, { label: "", price: 3 }], allergens: [7, 1, 1, 15], tags: ["spicy", "vegan"] },
      { category: "", name: "Kapustnica", description: "", price: 3.2, sizes: [], allergens: [], tags: [] },
      { category: "Nápoje", name: "Voda", description: "", price: 0, sizes: [], allergens: [], tags: [] },
      { category: "x", name: "  ", price: 5 },
    ],
  });
  assertEquals(rows.map((r) => r.name), ["Diavola", "Kapustnica", "Voda"]);
  assertEquals(rows[0], { category: "Pizza", name: "Diavola", description: "saláma", price: "", variants: [{ label: "32 cm", price: "7.50" }, { label: "45 cm", price: "11.90" }], allergens: [1, 7], tags: ["spicy"] });
  assertEquals(rows[1].price, "3.20");
  assertEquals(rows[2].price, "", "no price shown in the menu = empty, never guessed");
  assertEquals(cleanImportRows({ dishes: "x" }), []);
  assertEquals(cleanImportRows(null), []);
  assertEquals(cleanImportRows({ dishes: Array.from({ length: 400 }, (_, i) => ({ name: `D${i}`, price: 1 })) }).length, 300, "one import holds 300 rows");
});

Deno.test("the review table's allergen field: numbers 1–14 only, each once, in order", () => {
  assertEquals(allergensFromText("7, 1;3 1 15 0"), [1, 3, 7]);
  assertEquals(allergensFromText(""), []);
});

Deno.test("the restaurant page's rows (update 84): a dish or each size, the owner's order or the search's, sold out kept", () => {
  const menu = readMenu(raw)!;
  const all = menuRowLines(menu, null);
  // the owner's order (shop_menu's), each size its own row with its own price; the dish with sizes has no row of its own
  assertEquals(all.map((r) => [r.id, r.label, r.price_cents, r.sold_out]), [
    [P32, "32 cm", 750, true],
    [P45, "45 cm", 1190, false],
    [SOUP, null, 320, true],
    [COLA, null, 150, false],
    ["77777777-7777-4777-8777-777777777777", null, 200, false],
  ]);
  assert(all.every((r) => r.id !== PIZZA), "a dish with sizes is ordered by its sizes");
  // "Vypredané dnes" on the dish covers its sizes
  const marked = readMenu({ ...raw, items: [{ ...raw.items[0], sold_out: true }] })!;
  assertEquals(menuRowLines(marked, null).map((r) => r.sold_out), [true, true]);
  // the search's order (best first), each dish once, ids the menu does not show dropped
  assertEquals(menuRowLines(menu, [COLA, "99999999-9999-4999-8999-999999999999", PIZZA, COLA]).map((r) => r.id), [COLA, P32, P45]);
  assertEquals(menuRowLines(menu, []), []);
  // the row knows its dish (its name and translations)
  assertEquals(menuRowLines(menu, [PIZZA])[0].dish.name_i18n, { en: "Diavola pizza" });
});

Deno.test("the restaurant's texts: \"Jedlá\" and the dish page in sk / hu / en", () => {
  for (const d of [sk, hu, en]) {
    for (const key of ["tab_dishes", "tabs_label_dishes", "found_dish_one", "found_dish_few", "found_dish_other"] as const) {
      assert(d.shop[key], key);
    }
    for (const key of ["dish_available", "sizes", "dish_meta", "ask", "ask_prefill", "order", "order_message", "sold_out_today", "empty"] as const) {
      assert(d.menu[key], key);
    }
  }
  assertEquals(sk.shop.tab_dishes, "Jedlá");
});
