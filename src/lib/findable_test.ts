// Unit tests (Deno) of what makes a shop on its own domain findable (database updates 33 and 36):
// robots.txt, llms.txt, the Google and Bing meta tags, the IndexNow key file, the JSON-LD of item
// pages (with the checks of Google's Rich Results Test) and where search results and the API link.
// Run: npm run test:site
import { assert, assertEquals } from "jsr:@std/assert@1";
import { canonicalItemUrl, canonicalShopUrl, itemHref, shopHref, siteItemUrl } from "./customDomain.ts";
import { recordName } from "./domainName.ts";
import { indexNowKey, keyFileResponse } from "./indexnow.ts";
import { itemJsonLd, storeJsonLd } from "./jsonLd.ts";
import { AI_BOTS, mainLlmsShops, SITE_PRIVATE_PATHS, siteLlmsTxt, siteRobotsTxt, verificationMetadata } from "./siteFiles.ts";
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
    slug: "potraviny-centrum",
    apiBase: "https://ppi.example",
    shop: SHOP,
    calendar: [{ date: "2026-10-16", special: { closed: true, ranges: [], note: "Inventúra" }, holiday: null }],
    facts: { categories: ["Potraviny", "Káva"], brands: ["Lavazza", "Rajo"], items: 120, stock_categories: ["Káva a čaj"], auto_holidays: true },
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
  assert(text.includes("- Phone: +421 900 000 000") && text.includes("- E-mail: obchod@example.invalid"), "phone and e-mail");
  assert(text.includes("- Public holidays (SK): the shop follows them"), "whether public holidays apply");
  assert(text.includes("Item categories on its item pages: Káva a čaj."), "the categories its items have");
  assert(text.includes('get_shop with slug "potraviny-centrum"') && text.includes("https://ppi.example/mcp"), "Cacaduu's MCP for this shop");
  assert(text.includes("https://ppi.example/api/v1/shops/potraviny-centrum"), "Cacaduu's REST API for this shop");
  assert(text.includes("every source_url points to https://potraviny.sk/"), "the API links back to the domain");
  // Every page address is on the shop's own domain; Cacaduu is named only for its API and MCP.
  const urls = text.match(/https:\/\/[^\s)"]+/g) ?? [];
  assert(urls.length > 5 && urls.every((u) => u.startsWith("https://potraviny.sk/") || /^https:\/\/ppi\.example\/(mcp|api\/)/.test(u)), urls.join(" "));
  assert(!text.includes("/shops/potraviny-centrum\n") && !/dashboard|folder|access key|\/api\/shops\//i.test(text), "no private pages or routes");
  assert(!text.includes("Not listed by the shop."), "categories given");

  const bare = siteLlmsTxt({ host: "x.sk", lang: "en", slug: "x", apiBase: "https://ppi.example", shop: { ...SHOP, opening_hours: null, phone: null, email: null }, calendar: [], facts: null, words: sk.stock });
  assert(bare.includes("Not given by the shop") && bare.includes("Not listed by the shop."), "missing data said, never invented");
  assert(!bare.includes("Phone:") && !bare.includes("E-mail:") && !bare.includes("Public holidays") && !bare.includes("Brands"), "nothing invented");

  const regular = siteLlmsTxt({
    host: "x.sk", lang: "en", slug: "x", apiBase: "https://ppi.example", shop: SHOP, calendar: [],
    facts: { categories: [], brands: [], items: 3, stock_categories: [], auto_holidays: false }, words: sk.stock,
  });
  assert(regular.includes("- Public holidays: the shop keeps its regular hours on them"), "holidays switched off");
  assert(regular.includes("Not listed by the shop."), "no categories at all");
});

Deno.test("PPI's own llms.txt links a shop with a live own domain there", () => {
  const sites = new Map([["potraviny-centrum", "potraviny.sk"]]);
  const text = mainLlmsShops(
    [
      { slug: "drogeria-kostolne", name: "Drogéria", city: "Kostolné", country: "SK" },
      { slug: "potraviny-centrum", name: "Potraviny Centrum", city: "Michalovce", country: "SK" },
    ],
    sites,
    "https://ppi.example",
  );
  assert(text.includes("(https://ppi.example/en/shops/drogeria-kostolne)"), "a shop without a domain: its PPI page");
  assert(text.includes("[Potraviny Centrum, Michalovce (SK)](https://potraviny.sk/en)"), "its own domain");
  assert(!text.includes("ppi.example/en/shops/potraviny-centrum"), "never its PPI page");
  assertEquals(mainLlmsShops([], sites, "https://ppi.example"), "- (none yet)");
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

  // Stale data: the page shows the price but no quantity — the Offer has the price, never an availability.
  const stale = itemJsonLd({ ...ITEM, freshness_state: "stale", availability: null, quantity: null } as unknown as StockRow, SHOP, "sk", "potraviny.sk", input, "https://ppi.example");
  const [staleProduct, staleStore] = stale["@graph"] as Record<string, unknown>[];
  const staleOffer = staleProduct.offers as Record<string, unknown>;
  assertEquals([staleOffer.price, staleOffer.priceCurrency], ["18.90", "EUR"], "the price as on the page");
  assert(!("availability" in staleOffer), "no availability when the data is not current");
  assertEquals(staleStore["@type"], "Store");
  // A stale row that still carries an availability key: still none (the page shows none).
  const staleKey = itemJsonLd({ ...ITEM, freshness_state: "stale" } as StockRow, SHOP, "sk", "potraviny.sk", input, "https://ppi.example");
  assert(!("availability" in ((staleKey["@graph"] as Record<string, unknown>[])[0].offers as Record<string, unknown>)), "the freshness decides");
  // Sold out, as the page says "Vypredané".
  const soldOut = itemJsonLd({ ...ITEM, quantity: 0, availability: "out_of_stock", is_available: false } as StockRow, SHOP, "sk", "potraviny.sk", input, "https://ppi.example");
  assertEquals(((soldOut["@graph"] as Record<string, unknown>[])[0].offers as Record<string, unknown>).availability, "https://schema.org/OutOfStock");
  // No price in the file: no Offer at all (never invented).
  const noPrice = itemJsonLd({ ...ITEM, price: null } as StockRow, SHOP, "sk", "potraviny.sk", input, "https://ppi.example");
  assertEquals((noPrice["@graph"] as Record<string, unknown>[])[0].offers, undefined);

  // Without an own domain: the PPI addresses.
  const onPpi = itemJsonLd(ITEM, SHOP, "hu", null, input, "https://ppi.example");
  assertEquals((onPpi["@graph"] as Record<string, unknown>[])[0].url, `https://ppi.example/hu/items/${ITEM.item_id}`);
  assertEquals(storeJsonLd(SHOP, "hu", "potraviny.sk", input, "https://ppi.example")["@id"], "https://potraviny.sk/hu", "the Hungarian home page");
});

/**
 * What Google's Rich Results Test requires of a Product snippet and a LocalBusiness (Store), as
 * listed in Google's structured data documentation: the problems found, empty when it passes.
 */
function richResultsProblems(graph: Record<string, unknown>[]): string[] {
  const problems: string[] = [];
  for (const node of graph) {
    if (node["@type"] === "Product") {
      if (typeof node.name !== "string" || !node.name) problems.push("Product: name");
      const offer = node.offers as Record<string, unknown> | undefined;
      if (!offer && !node.review && !node.aggregateRating) problems.push("Product: offers, review or aggregateRating");
      if (offer) {
        if (offer["@type"] !== "Offer") problems.push("Offer: @type");
        if (!/^\d+(\.\d+)?$/.test(String(offer.price ?? ""))) problems.push("Offer: price");
        if (!/^[A-Z]{3}$/.test(String(offer.priceCurrency ?? ""))) problems.push("Offer: priceCurrency");
        if (offer.availability !== undefined && !/^https:\/\/schema\.org\/(InStock|OutOfStock)$/.test(String(offer.availability))) problems.push("Offer: availability");
      }
    }
    if (node["@type"] === "Store") {
      if (typeof node.name !== "string" || !node.name) problems.push("Store: name");
      const address = node.address as Record<string, unknown> | undefined;
      if (!address || address["@type"] !== "PostalAddress") problems.push("Store: address");
    }
  }
  return problems;
}

Deno.test("Rich Results checks pass for a product page on the own domain, fresh and stale", () => {
  for (const row of [ITEM, { ...ITEM, freshness_state: "stale", availability: null, quantity: null } as unknown as StockRow]) {
    const data = itemJsonLd(row, SHOP, "sk", "potraviny.sk", input, "https://ppi.example");
    assertEquals(data["@context"], "https://schema.org");
    assertEquals(richResultsProblems(data["@graph"] as Record<string, unknown>[]), [], row.freshness_state);
    // One valid JSON document, as it goes into <script type="application/ld+json">.
    assertEquals(JSON.parse(JSON.stringify(data)), data);
  }
  const store = storeJsonLd(SHOP, "sk", "potraviny.sk", input, "https://ppi.example") as Record<string, unknown>;
  assertEquals(richResultsProblems([store]), []);
  assertEquals(store.email, "obchod@example.invalid", "the shop's e-mail");
  const withFacebook = storeJsonLd({ ...SHOP, facebook_url: "https://www.facebook.com/potravinycentrum" }, "sk", "potraviny.sk", input, "https://ppi.example") as Record<string, unknown>;
  assert((withFacebook.sameAs as string[]).includes("https://www.facebook.com/potravinycentrum"), "sameAs: its Facebook page");
  // The company under the address (update 48): postal code, registered name and tax number; nothing when not given.
  const withCompany = storeJsonLd({ ...SHOP, zip: "040 01", company_name: "Potraviny s.r.o.", dic: "2020123456" }, "sk", "potraviny.sk", input, "https://ppi.example") as Record<string, unknown>;
  assertEquals((withCompany.address as Record<string, unknown>).postalCode, "040 01");
  assertEquals(withCompany.legalName, "Potraviny s.r.o.");
  assertEquals(withCompany.taxID, "2020123456");
  assertEquals(richResultsProblems([withCompany]), []);
  assert(!("legalName" in store) && !("taxID" in store) && !("postalCode" in (store.address as Record<string, unknown>)), "nothing invented");
  const special = storeJsonLd(SHOP, "sk", "potraviny.sk", {
    ...input,
    days: [{ date: "2026-10-16", special: { closed: true, ranges: [], note: null }, holiday: null }],
  }, "https://ppi.example", new Date("2026-10-14T10:00:00Z")) as Record<string, unknown>;
  assert(Array.isArray(special.specialOpeningHoursSpecification), "specialOpeningHoursSpecification for a special day");
  // The rule itself: without an Offer (no price) the Product snippet fails — so a price is never left out when the page has one.
  assertEquals(richResultsProblems([{ "@type": "Product", name: "x" }]), ["Product: offers, review or aggregateRating"]);
});

Deno.test("API and MCP source_url: the canonical page — the own domain when live, else PPI", () => {
  const sites = new Map([["potraviny-centrum", "potraviny.sk"]]);
  assertEquals(canonicalItemUrl(sites, "https://ppi.example", "en", "potraviny-centrum", ITEM.item_id), `https://potraviny.sk/en/items/${ITEM.item_id}`);
  assertEquals(canonicalShopUrl(sites, "https://ppi.example", "sk", "potraviny-centrum", "SK"), "https://potraviny.sk/");
  assertEquals(canonicalShopUrl(sites, "https://ppi.example", "en", "potraviny-centrum", "SK"), "https://potraviny.sk/en");
  assertEquals(canonicalItemUrl(sites, "https://ppi.example", "hu", "drogeria-kostolne", ITEM.item_id), `https://ppi.example/hu/items/${ITEM.item_id}`);
  assertEquals(canonicalShopUrl(sites, "https://ppi.example", "hu", "drogeria-kostolne", "SK"), "https://ppi.example/hu/shops/drogeria-kostolne");
});

Deno.test("Google and Bing meta tags: only on the shop's own domain, only values of their format", () => {
  const google = "AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcd";
  const bing = "0123456789ABCDEF0123456789ABCDEF";
  const meta = { host: "potraviny.sk", google, bing };
  assertEquals(verificationMetadata(meta, "potraviny.sk"), { google, other: { "msvalidate.01": bing } }, "both tags");
  assertEquals(verificationMetadata(meta, "POTRAVINY.SK:443"), { google, other: { "msvalidate.01": bing } }, "host as sent");
  assertEquals(verificationMetadata(meta, "ppi.example"), null, "never on PPI's own address");
  assertEquals(verificationMetadata(meta, "www.potraviny.sk"), null, "only the domain itself");
  assertEquals(verificationMetadata({ ...meta, bing: null }, "potraviny.sk"), { google }, "Google only");
  assertEquals(verificationMetadata({ ...meta, google: null }, "potraviny.sk"), { other: { "msvalidate.01": bing } }, "Bing only");
  assertEquals(verificationMetadata({ host: "potraviny.sk", google: '"><script>', bing: "xyz" }, "potraviny.sk"), null, "nothing of another format");
  assertEquals(verificationMetadata(null, "potraviny.sk"), null, "no live domain");
});

Deno.test("IndexNow key file: one key (INDEXNOW_KEY), served only under its own name", async () => {
  const key = "0123456789abcdef0123456789abcdef";
  assertEquals(indexNowKey({ INDEXNOW_KEY: ` ${key} ` }), key);
  assertEquals(indexNowKey({ INDEXNOW_KEY: "short" }), null, "too short");
  assertEquals(indexNowKey({ INDEXNOW_KEY: "a/b/c/d/e/f" }), null, "not a key");
  assertEquals(indexNowKey({}), null, "not set");
  const ok = keyFileResponse(key, key);
  assertEquals([ok.status, ok.headers.get("content-type"), await ok.text()], [200, "text/plain; charset=utf-8", key], "the key itself");
  assertEquals(keyFileResponse("somethingelse1", key).status, 404, "another name");
  assertEquals(keyFileResponse(key, null).status, 404, "no key set (or the domain is not live)");
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
