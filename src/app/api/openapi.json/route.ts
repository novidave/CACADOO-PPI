import { CORS_HEADERS, LIMIT_PER_MINUTE } from "@/lib/apiHttp";
import { DATA_RULES } from "@/lib/publicApi";
import { siteUrl } from "@/lib/site";

const lang = { name: "lang", in: "query", required: false, schema: { type: "string", enum: ["sk", "hu", "en"], default: "en" }, description: "Language of name_translated and of the source_url pages." };

const freshness = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["current", "recent", "stale"] },
    age_minutes: { type: ["integer", "null"] },
    updated_at: { type: ["string", "null"], format: "date-time", description: "Time the shop's latest stock file was made." },
  },
};

const item = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string", description: "As the shop wrote it.", example: "Farba fas. biela 5L" },
    name_translated: { type: ["string", "null"], description: "The name in the requested language (lang); null until translated.", example: "White facade paint 5 l" },
    name_lang: { type: ["string", "null"], description: "Language of name (ISO 639-1).", example: "sk" },
    brand: { type: ["string", "null"] },
    ean: { type: ["string", "null"] },
    price: { type: ["number", "null"] },
    currency: { type: "string", example: "EUR" },
    availability: { type: ["string", "null"], enum: ["in_stock_count", "in_stock", "low_stock", "out_of_stock", "available", "not_available", null], description: "Null when the shop's data is stale." },
    availability_text: { type: ["string", "null"], example: "Low stock" },
    is_available: { type: "boolean" },
    quantity: { type: ["number", "null"], description: "Only for shops that publish exact quantities." },
    freshness,
    distance_km: { type: ["number", "null"] },
    shop: { type: "object", properties: { slug: { type: "string" }, name: { type: "string" }, address: { type: ["string", "null"] }, city: { type: ["string", "null"] }, country: { type: ["string", "null"] }, timezone: { type: ["string", "null"] }, lat: { type: ["number", "null"] }, lng: { type: ["number", "null"] }, source_url: { type: "string", format: "uri" } } },
    source_url: { type: "string", format: "uri", description: "PPI page to cite." },
  },
};

const shop = {
  type: "object",
  properties: {
    slug: { type: "string" }, name: { type: "string" }, address: { type: ["string", "null"] }, city: { type: ["string", "null"] },
    country: { type: ["string", "null"] }, lat: { type: ["number", "null"] }, lng: { type: ["number", "null"] }, timezone: { type: "string" },
    phone: { type: ["string", "null"] }, website: { type: ["string", "null"] },
    opening_hours: { type: ["object", "null"], description: '{"mon":[["08:00","17:00"]],...} in the shop\'s time zone' },
    open_now: { type: ["boolean", "null"] },
    facilities: { type: "object", properties: { customer_toilet: { type: "boolean" }, douchette: { type: "boolean" }, card_payment: { type: "boolean" } } },
    freshness,
    source_url: { type: "string", format: "uri" },
  },
};

const errors = {
  "404": { description: "Not found" },
  "429": { description: `Rate limit: ${LIMIT_PER_MINUTE} requests per minute per caller` },
};

export function GET() {
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "PPI public stock API",
      version: "1.0.0",
      description: `Read-only, no login. Which nearby shops have a product in stock right now, at what price, and how fresh that is. ${DATA_RULES} Limit: ${LIMIT_PER_MINUTE} requests per minute per caller.`,
    },
    servers: [{ url: siteUrl() }],
    paths: {
      "/api/v1/search": {
        get: {
          summary: "Search items in stock near a place",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" }, description: "Product name in Slovak, Hungarian or English (every word must match, any order), brand, EAN, shop name, street or town; accents and case ignored." },
            { name: "lat", in: "query", schema: { type: "number" } },
            { name: "lng", in: "query", schema: { type: "number" } },
            { name: "near", in: "query", schema: { type: "string" }, description: "Town name where PPI has shops (e.g. Michalovce) or 'lat,lng'. Used when lat/lng are not given." },
            { name: "radius_km", in: "query", schema: { type: "number", default: 10, maximum: 500 } },
            { name: "only_available", in: "query", schema: { type: "boolean", default: false } },
            lang,
          ],
          responses: { "200": { description: "Up to 50 results: available first, then fresher, then nearer.", content: { "application/json": { schema: { type: "object", properties: { count: { type: "integer" }, results: { type: "array", items: item } } } } } }, ...errors },
        },
      },
      "/api/v1/shops": { get: { summary: "All active shops", parameters: [lang], responses: { "200": { description: "Shops", content: { "application/json": { schema: { type: "object", properties: { shops: { type: "array", items: shop } } } } } }, ...errors } } },
      "/api/v1/shops/{slug}": { get: { summary: "One shop", parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }, lang], responses: { "200": { description: "Shop", content: { "application/json": { schema: { type: "object", properties: { shop } } } } }, ...errors } } },
      "/api/v1/shops/{slug}/items": { get: { summary: "A shop's public items, 50 per page", parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }, { name: "page", in: "query", schema: { type: "integer", default: 1 } }, { name: "q", in: "query", schema: { type: "string" } }, lang], responses: { "200": { description: "Items", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: item }, total: { type: "integer" }, pages: { type: "integer" } } } } } }, ...errors } } },
      "/api/v1/items/{id}": { get: { summary: "One item and the same product (EAN) in other shops", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }, lang], responses: { "200": { description: "Item", content: { "application/json": { schema: { type: "object", properties: { item, also_available_at: { type: "array", items: item } } } } } }, ...errors } } },
    },
  };
  return new Response(JSON.stringify(spec, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600", ...CORS_HEADERS },
  });
}
