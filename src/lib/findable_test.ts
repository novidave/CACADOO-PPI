// Unit tests (Deno) of what makes a shop on its own domain findable (database update 33):
// robots.txt, llms.txt, the JSON-LD of item pages and where search results link.
// Run: npm run test:site
import { assert, assertEquals } from "jsr:@std/assert@1";
import { itemHref, shopHref, siteItemUrl } from "./customDomain.ts";
import { recordName } from "./domainName.ts";
import { itemJsonLd, storeJsonLd } from "./jsonLd.ts";
import { AI_BOTS, SITE_PRIVATE_PATHS, siteLlmsTxt, siteRobotsTxt } from "./siteFiles.ts";
import type { PublicShop } from "./data.ts";
import type { StockRow } from "./stock.ts";
import sk from "../i18n/messages/sk.json" with { type: "json" };

const SHOP: PublicShop = {
  id: "shop-1",
  slug: "potraviny-centrum",
  name: "Potraviny Centrum",
  address: "Námestie osloboditeľov 10",
  city: "Michalovce",
  country: "SK",
  timezone: "Europe/Bratislava",
  phone: "+421 900 000 000",
  website: null,
  logo_url: null,
  opening_hours: { mon: [["08:00", "12:00"], ["13:00", "17:00"]], sat: [["08:00", "12:00"]] },
  lat: 48.75,
  lng: 21.92,
  freshness_state: "current",
  freshness_age_minutes: 5,
  latest_file_time: "2026-10-14T08:00:00Z",
  has_toilet: false,
  has_douchette: false,
  has_card_terminal: true,
  email: "obchod@example.invalid",
  facebook_url: null,
  assistant_label: null,
  assistant_welcome: null,
  booking_url: null,
};

const ITEM = {
  item_id: "11111111-1111-4111-8111-111111111111",
  item_name: "Káva zrnková 1 kg",
  ean: "8000070012345",
  brand: "Lavazza",
  shop_id: "shop-1",
  shop_slug: "potraviny-centrum",
  shop_name: "Potraviny Centrum",
  shop_address: "Námestie osloboditeľov 10",
  shop_city: "Michalovce",
  shop_country: "SK",
  shop_timezone: "Europe/Bratislava",
  shop_lat: 48.75,
  shop_lng: 21.92,
  price: 18.9,
  currency: "EUR",
  quantity: 12,
  availability: "in_stock_count",
  is_available: true,
  freshness_state: "current",
  freshness_age_minutes: 5,
  latest_file_time: "2026-10-14T08:00:00Z",
  updated_at: "2026-10-14T08:00:00Z",
  item_name_lang: "sk",
  item_name_i18n: { en: "Coffee beans 1 kg" },
} as unknown as StockRow;

const input = { hours: SHOP.opening_hours, timeZone: SHOP.timezone, days: [] };

Deno.test("robots.txt of an own domain: public pages for everyone and AI crawlers, never the owner's or private pages", () => {
  const text = siteRobotsTxt("potraviny.sk");
  const lines = text.split("\n");
  assert(lines.includes("User-agent: *") && lines.includes("Allow: /"), "everyone may read");
  for (const bot of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]) assert(lines.includes(`User-agent: ${bot}`), bot);
  assertEquals(AI_BOTS.length, lines.filter((l) => l.startsWith("User-agent: ") && l !== "User-agent: *").length);
  // Both groups keep the same private paths out.
  for (const path of ["/api/", "/*/dashboard", "/*/sync", "/*/login", "/auth/"]) {
    assertEquals(lines.filter((l) => l === `Disallow: ${path}`).length, 2, path);
  }
  assertEquals(SITE_PRIVATE_PATHS.filter((p) => p === "/api/").length, 1, "private folders, keys, files and the assistant live under /api/");
  assert(lines.includes("Sitemap: https://potraviny.sk/sitemap.xml"), "the sitemap");
  assert(!/Disallow: \/\s*$/m.test(text), "never the whole site");
});

Deno.test("llms.txt of an own domain: name, address, hours, categories, sitemap and how to read the stock", () => {
  const text = siteLlmsTxt({
    host: "potraviny.sk",
    lang: "sk",
    shop: SHOP,
    calendar: [{ date: "2026-10-16", special: { closed: true, ranges: [], note: "Inventúra" }, holiday: null }],
    facts: { categories: ["Potraviny", "Káva"], brands: ["Lavazza", "Rajo"], items: 120 },
    words: sk.stock,
    now: new Date("2026-10-14T10:00:00Z"),
  });
  assert(text.startsWith("# Potraviny Centrum\n"), "the shop's name as the title");
  assert(text.includes("- Address: Námestie osloboditeľov 10, Michalovce, SK"), "address");
  assert(text.includes("- Monday: 8:00–12:00, 13:00–17:00") && text.includes("- Sunday: closed"), "regular hours");
  assert(text.includes("2026-10-16 (Friday): closed · Inventúra"), "a special day with the owner's note");
  assert(text.includes("- Potraviny\n- Káva"), "the owner's categories");
  assert(text.includes("Brands in the stock file: Lavazza, Rajo."), "brands");
  assert(text.includes("Sitemap (every item page): https://potraviny.sk/sitemap.xml"), "the sitemap");
  assert(text.includes('"12 ks na sklade"') && text.includes('"Vypredané"') && text.includes(`"${sk.stock.stale}"`), "the page's own words");
  assert(text.includes("do not say the item is in stock"), "stale data is not availability");
  assert(text.includes("https://potraviny.sk/sk/items/{id}"), "item pages on the domain");
  assert(!text.includes("cacadoo") && !text.includes("/shops/"), "only the shop's own domain");

  const bare = siteLlmsTxt({ host: "x.sk", lang: "en", shop: { ...SHOP, opening_hours: null }, calendar: [], facts: null, words: sk.stock });
  assert(bare.includes("Not given by the shop") && bare.includes("Not listed by the shop."), "missing data said, never invented");
});

Deno.test("item JSON-LD on the own domain: Product + Offer and the Store (LocalBusiness), canonical addresses", () => {
  const data = itemJsonLd(ITEM, SHOP, "sk", "potraviny.sk", input, "https://ppi.example");
  const [product, store] = data["@graph"] as Record<string, unknown>[];
  assertEquals(product["@type"], "Product");
  assertEquals(product.url, siteItemUrl("potraviny.sk", "sk", ITEM.item_id), "the item's address on the domain");
  const offer = product.offers as Record<string, unknown>;
  assertEquals([offer.price, offer.priceCurrency, offer.availability], ["18.90", "EUR", "https://schema.org/InStock"]);
  assertEquals(offer.seller, { "@id": "https://potraviny.sk/" }, "sold by the shop's Store");
  assertEquals(store["@type"], "Store");
  assertEquals(store["@id"], "https://potraviny.sk/", "the Store is the domain's home page");
  assert(Array.isArray(store.openingHoursSpecification), "with its opening hours");
  assertEquals((store.address as Record<string, string>).addressLocality, "Michalovce");
  assert(!JSON.stringify(data).includes("ppi.example"), "nothing on PPI's address once the domain is live");

  // Stale data: no offer (no price, no availability), the Store stays.
  const stale = itemJsonLd({ ...ITEM, freshness_state: "stale", availability: null, quantity: null } as unknown as StockRow, SHOP, "sk", "potraviny.sk", input, "https://ppi.example");
  const [staleProduct, staleStore] = stale["@graph"] as Record<string, unknown>[];
  assertEquals(staleProduct.offers, undefined, "no availability when the data is not current");
  assertEquals(staleStore["@type"], "Store");

  // Without an own domain: the PPI addresses.
  const onPpi = itemJsonLd(ITEM, SHOP, "hu", null, input, "https://ppi.example");
  assertEquals((onPpi["@graph"] as Record<string, unknown>[])[0].url, `https://ppi.example/hu/items/${ITEM.item_id}`);
  assertEquals(storeJsonLd(SHOP, "hu", "potraviny.sk", input, "https://ppi.example")["@id"], "https://potraviny.sk/hu", "the Hungarian home page");
});

Deno.test("search results link to the shop's own domain once it is live", () => {
  const sites = new Map([["potraviny-centrum", "potraviny.sk"]]);
  assertEquals(itemHref(sites, "en", "potraviny-centrum", ITEM.item_id), `https://potraviny.sk/en/items/${ITEM.item_id}`);
  assertEquals(shopHref(sites, "sk", "potraviny-centrum", "SK"), "https://potraviny.sk/");
  assertEquals(shopHref(sites, "hu", "potraviny-centrum", "SK"), "https://potraviny.sk/hu");
  assertEquals(itemHref(sites, "sk", "drogeria-kostolne", ITEM.item_id), `/sk/items/${ITEM.item_id}`, "other shops stay on PPI");
  assertEquals(shopHref(sites, "sk", "drogeria-kostolne", "SK"), "/sk/shops/drogeria-kostolne");
});

Deno.test("Search Console record names for a domain at another registrar", () => {
  assertEquals([recordName("davide.sk"), recordName("eshop.davide.sk"), recordName("a.b.davide.sk")], ["@", "eshop", "a.b"]);
});
