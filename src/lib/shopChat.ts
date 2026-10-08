import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { callerHash } from "./apiHttp";
import { formatPrice } from "./format";
import { translatedName } from "./names";
import { apiItem } from "./publicApi";
import { availabilityText, freshnessText, type StockRow } from "./stock";
import { createPublicClient } from "./supabase/public";

/**
 * The AI assistant on a shop page (a paid feature: only when shop_has_plan is true).
 * Claude Haiku answers about this one shop: its two tools are bound to the shop on the
 * server (search_items → shop_stock for this slug, get_item → public_stock for this
 * slug), so it cannot see other shops. Item cards and the shopping list are built only
 * from what those tools returned; availability, quantities and freshness come from the
 * database as everywhere else. A photo (shrunk in the browser) goes to Claude for this
 * one answer and is never stored.
 */

const MODEL = "claude-haiku-5-5";
/** Earlier messages sent along (the newest ones), and their length. */
export const MAX_HISTORY = 8;
export const MAX_TEXT = 1500;
/** The base64 JPEG from the browser (1568 px at most); a little over 2 MB of text. */
const MAX_PHOTO_CHARS = 2_800_000;
/** Messages per caller per hour (counted with the other API calls in api_usage). */
const HOURLY_LIMIT = 20;
const DEFAULT_MONTHLY_LIMIT = 1000;
/** Model turns that may still use tools; the turn after them must answer. */
const MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_CALLS = 10;
const RESULTS_PER_SEARCH = 15;
const MAX_CARDS = 10;
const MAX_LIST = 30;
const TIME_BUDGET_MS = 25_000;
/** Hard stop, inside the route's 60 seconds, so the shopper always gets an answer or a reason. */
const DEADLINE_MS = 50_000;

const LANGUAGE_NAMES: Record<Locale, string> = { sk: "Slovak", hu: "Hungarian", en: "English" };

const ITEM_COLUMNS =
  "item_id, item_name, ean, brand, shop_id, shop_slug, shop_name, shop_address, shop_city, shop_country, shop_timezone, shop_lat, shop_lng, price, currency, quantity, availability, is_available, freshness_state, freshness_age_minutes, latest_file_time, updated_at, item_name_lang, item_name_i18n";

export interface ChatShop {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  timezone: string;
  lat: number | null;
  lng: number | null;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ChatCard {
  href: string;
  name: string;
  translated: string | null;
  brand: string | null;
  price: string;
  availability: string | null;
  freshness: string;
}

export interface ChatListItem extends ChatCard {
  quantity: number;
  note: string;
}

export type PhotoMatch = "found" | "not_found" | "unsure";

export interface ChatReply {
  answer: string;
  cards: ChatCard[];
  list: ChatListItem[];
  /** Only when the message had a photo: what was read from it and whether this shop has it. */
  photo: { read: string; match: PhotoMatch } | null;
}

export type ChatVerdict = "ok" | "no_plan" | "caller_limit" | "shop_limit";

type FoundItem = ReturnType<typeof apiItem>;

function db() {
  const supabase = createPublicClient();
  if (!supabase) throw new Error("Supabase is not configured");
  return supabase;
}

/** On when the Anthropic key is set on the server (Vercel), never in the browser. */
export function shopChatEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function monthlyLimit(): number {
  const value = Number(process.env.CHAT_MONTHLY_LIMIT_PER_SHOP);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_MONTHLY_LIMIT;
}

/** An active shop by its page address, or null. */
export async function chatShop(slug: string): Promise<ChatShop | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const { data, error } = await db()
    .from("public_shops")
    .select("id, slug, name, address, city, country, timezone, lat, lng")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as ChatShop | null;
}

/** The database decides: paid plan, 20 messages an hour per caller, the shop's monthly cap. */
export async function chatAllowed(request: Request, shopId: string): Promise<ChatVerdict> {
  const { data, error } = await db().rpc("shop_chat_hit", {
    p_ip_hash: callerHash(request),
    p_shop_id: shopId,
    p_hourly_limit: HOURLY_LIMIT,
    p_monthly_limit: monthlyLimit(),
  });
  if (error) throw new Error(`limit check failed (database update 19 missing?): ${error.message}`);
  return data as ChatVerdict;
}

/** The newest earlier messages, starting with the shopper's, each cut to MAX_TEXT. */
export function cleanHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns = value
    .filter(
      (turn): turn is ChatTurn =>
        Boolean(turn) &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.text === "string" &&
        turn.text.trim() !== "",
    )
    .map((turn) => ({ role: turn.role, text: turn.text.trim().slice(0, MAX_TEXT) }))
    .slice(-MAX_HISTORY);
  while (turns[0]?.role === "assistant") turns.shift();
  return turns;
}

/** A JPEG from the browser as base64 (no data: prefix): null = no photo, "bad" = refused. */
export function cleanPhoto(value: unknown): string | null | "bad" {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_PHOTO_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return "bad";
  const head = Buffer.from(value.slice(0, 8), "base64");
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? value : "bad";
}

function systemPrompt(shop: ChatShop, lang: Locale): string {
  const where = [shop.city, shop.country].filter(Boolean).join(", ");
  return [
    `You are the shopping assistant of the shop "${shop.name}"${where ? ` (${where})` : ""} on PPI, a website that shows ` +
      "what local shops have in stock right now.",
    "You know only this shop's stock, through two tools: search_items and get_item. You cannot see other shops; never " +
      "name, compare or suggest other shops or websites.",
    `Answer in the language the shopper writes in; if that is unclear, in ${LANGUAGE_NAMES[lang]}.`,
    "",
    "What you do:",
    "- Answer questions about this shop's items, prices and availability, using only what the tools return.",
    "- Shopping list: when the shopper asks for one or asks what they need for a job, search for every thing the job " +
      "needs, then put the fitting items in shopping_list with a sensible quantity and a short note. Say in the answer " +
      "what you could not find in this shop.",
    "- Photo of a device, part, model plate, label or serial number: write in photo.read exactly what you can read " +
      "(brand, model, type, part or serial number, sizes) and what the thing is, then search this shop with those " +
      "words. photo.match: found = a returned item clearly is that part or is made for it (same model or part " +
      "number, or its name says it fits); not_found = you searched and nothing fits; unsure = the photo is hard to " +
      "read, several items could fit, or you would have to guess. When unsure, say what you read and ask the shopper " +
      "to confirm or to send a sharper photo. Never present a guess as a match.",
    "",
    "Rules:",
    "- Mention only items that a tool returned in this conversation, with their exact name, price and availability. " +
      "Never invent items, prices, availability or stock.",
    "- availability null means the shop's stock data is too old: say the current stock is not known; never say an " +
      "item is available.",
    "- Search with short terms of one to three words: the shop's own words and Slovak, Hungarian or English names, " +
      "brands, model or part numbers. Every word of a search must appear in the item. Make the searches you need at once.",
    "- answer: one to four short sentences of plain text, no links. The page shows every item in item_refs and " +
      "shopping_list as a card with its price, availability and a link.",
    "- item_refs: refs of the items the answer is about, best first, at most 10. shopping_list: only when a list was " +
      "asked for or the shopper asks what they need; otherwise empty.",
    '- photo: when the newest message has no photo, read "" and match "none".',
    "- Never ask for or use the shopper's location.",
  ].join("\n");
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_items",
    description:
      "Searches this shop's stock by text: product name (the shop's own words, or Slovak, Hungarian or English), " +
      `brand, EAN, model or part number. Accents and case are ignored; every word must appear. Returns up to ${RESULTS_PER_SEARCH} ` +
      "items with a ref, the name as the shop wrote it, its translation, brand, EAN, price and availability " +
      "(null when the stock data is too old). An empty query lists the first items.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "One short search term, one to three words." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_item",
    description:
      "All details of one item from an earlier search_items result: EAN, brand, price, availability, the exact " +
      "quantity when the shop publishes it, and when the stock was last updated.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { ref: { type: "string", description: "The item's ref from search_items, e.g. r3." } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
];

const ANSWER_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      answer: { type: "string" },
      item_refs: { type: "array", items: { type: "string" } },
      shopping_list: {
        type: "array",
        items: {
          type: "object",
          properties: { ref: { type: "string" }, quantity: { type: "integer" }, note: { type: "string" } },
          required: ["ref", "quantity", "note"],
          additionalProperties: false,
        },
      },
      photo: {
        type: "object",
        properties: {
          read: { type: "string" },
          match: { type: "string", enum: ["none", "found", "not_found", "unsure"] },
        },
        required: ["read", "match"],
        additionalProperties: false,
      },
    },
    required: ["answer", "item_refs", "shopping_list", "photo"],
    additionalProperties: false,
  },
};

interface Answer {
  answer: string;
  item_refs: string[];
  shopping_list: { ref: string; quantity: number; note: string }[];
  photo: { read: string; match: "none" | PhotoMatch };
}

/** A shop_stock / public_stock row of this shop in the API's item shape. */
function toItem(row: Partial<StockRow>, shop: ChatShop, lang: Locale): FoundItem {
  return apiItem(
    {
      ...row,
      shop_id: shop.id,
      shop_slug: shop.slug,
      shop_name: shop.name,
      shop_address: shop.address,
      shop_city: shop.city,
      shop_country: shop.country,
      shop_timezone: shop.timezone,
      shop_lat: shop.lat,
      shop_lng: shop.lng,
      distance_km: null,
    } as StockRow,
    lang,
  );
}

/** Runs one shopper message. Throws on any problem: the route then answers with an error. */
export async function runShopChat(
  shop: ChatShop,
  lang: Locale,
  history: ChatTurn[],
  message: string,
  photo: string | null,
): Promise<ChatReply> {
  const client = new Anthropic({ maxRetries: 1, timeout: 20_000 });
  const started = Date.now();
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const found = new Map<string, FoundItem>(); // ref → item, only from this shop's tools
  const refOf = new Map<string, string>(); // item id → ref
  let toolCalls = 0;

  const remember = (item: FoundItem) => {
    let ref = refOf.get(item.id);
    if (!ref) {
      ref = `r${refOf.size + 1}`;
      refOf.set(item.id, ref);
    }
    found.set(ref, item);
    return ref;
  };
  const brief = (item: FoundItem) => ({
    ref: remember(item),
    name: item.name,
    name_translated: item.name_translated,
    brand: item.brand,
    ean: item.ean,
    price: item.price === null ? null : `${item.price} ${item.currency}`,
    availability: item.availability_text,
  });

  async function runTool(call: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
    const fail = (content: string): Anthropic.ToolResultBlockParam => ({ type: "tool_result", tool_use_id: call.id, is_error: true, content });
    if (++toolCalls > MAX_TOOL_CALLS) return fail("No more tool calls: answer with what you have.");
    const input = call.input as { query?: unknown; ref?: unknown };
    if (call.name === "search_items") {
      const query = typeof input.query === "string" ? input.query.trim().slice(0, 100) : "";
      const { data, error } = await db().rpc("shop_stock", {
        p_slug: shop.slug,
        q: query || null,
        p_limit: RESULTS_PER_SEARCH,
        p_offset: 0,
      });
      if (error) return fail(`Search failed: ${error.message}`);
      const items = ((data ?? []) as Partial<StockRow>[]).map((row) => brief(toItem(row, shop, lang)));
      return { type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ query, items }) };
    }
    if (call.name === "get_item") {
      const known = found.get(typeof input.ref === "string" ? input.ref.trim() : "");
      if (!known) return fail("Unknown ref: use a ref from search_items.");
      // Read fresh, and only if it is still a public item of this shop.
      const { data, error } = await db()
        .from("public_stock")
        .select(ITEM_COLUMNS)
        .eq("item_id", known.id)
        .eq("shop_slug", shop.slug)
        .maybeSingle();
      if (error) return fail(`Lookup failed: ${error.message}`);
      if (!data) return fail("This item is no longer listed by the shop.");
      const item = toItem(data as Partial<StockRow>, shop, lang);
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify({
          ...brief(item),
          name_lang: item.name_lang,
          quantity: item.quantity,
          stock_updated_at: item.freshness.updated_at,
          stock_data: item.freshness.state === "stale" ? "too old: current stock unknown" : item.freshness.state,
        }),
      };
    }
    return fail(`Unknown tool ${call.name}`);
  }

  const messages: Anthropic.MessageParam[] = [
    ...history.map((turn): Anthropic.MessageParam => ({ role: turn.role, content: turn.text })),
    {
      role: "user",
      content: photo
        ? [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: photo } },
            { type: "text", text: message },
          ]
        : message,
    },
  ];

  for (let round = 0; ; round++) {
    const mustAnswer = round >= MAX_TOOL_ROUNDS || toolCalls >= MAX_TOOL_CALLS || Date.now() - started > TIME_BUDGET_MS;
    const response = await client.messages
      .create(
        {
          model: MODEL,
          max_tokens: 4096,
          system: systemPrompt(shop, lang),
          tools: TOOLS,
          tool_choice: { type: mustAnswer ? "none" : "auto" },
          // A photo needs a closer look; plain questions are quick.
          output_config: { effort: photo ? "medium" : "low", format: ANSWER_FORMAT },
          cache_control: { type: "ephemeral" },
          messages,
        },
        { signal: deadline },
      )
      .catch((e: unknown): never => {
        throw deadline.aborted ? new Error(`no answer within ${DEADLINE_MS / 1000} seconds`) : e;
      });

    if (response.stop_reason === "tool_use" && !mustAnswer) {
      const calls = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: await Promise.all(calls.map(runTool)) });
      continue;
    }
    if (response.stop_reason !== "end_turn") throw new Error(`the assistant stopped: ${response.stop_reason}`);

    const text = response.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") throw new Error("the assistant gave no answer");
    return toReply(JSON.parse(text.text) as Answer, found, Boolean(photo), shop, lang);
  }
}

/** Cards and the list only from items this shop's tools returned; unknown refs are dropped. */
async function toReply(
  answer: Answer,
  found: Map<string, FoundItem>,
  hadPhoto: boolean,
  shop: ChatShop,
  lang: Locale,
): Promise<ChatReply> {
  const dict = await getDictionary(lang);
  const card = (item: FoundItem): ChatCard => ({
    href: `/${lang}/items/${item.id}`,
    name: item.name,
    translated: translatedName(item.name, { [lang]: item.name_translated ?? undefined }, lang),
    brand: item.brand,
    price: formatPrice(item.price, lang, item.currency),
    availability: availabilityText(dict, item.availability, item.quantity),
    freshness: freshnessText(dict, item.freshness.state, item.freshness.age_minutes, item.freshness.updated_at, shop.timezone),
  });

  const cards = [...new Set(answer.item_refs ?? [])]
    .map((ref) => found.get(ref))
    .filter((item): item is FoundItem => Boolean(item))
    .slice(0, MAX_CARDS)
    .map(card);
  const seen = new Set<string>();
  const list = (answer.shopping_list ?? [])
    .flatMap((entry) => {
      const item = found.get(entry.ref);
      if (!item || seen.has(item.id)) return [];
      seen.add(item.id);
      const quantity = Number.isFinite(entry.quantity) ? Math.min(Math.max(Math.round(entry.quantity), 1), 999) : 1;
      return [{ ...card(item), quantity, note: String(entry.note ?? "").trim().slice(0, 200) }];
    })
    .slice(0, MAX_LIST);

  let photo: ChatReply["photo"] = null;
  if (hadPhoto) {
    const said = answer.photo?.match ?? "unsure";
    // "found" needs an item to show; anything else would be a guess.
    const match: PhotoMatch = said === "found" ? (cards.length + list.length > 0 ? "found" : "unsure") : said === "not_found" ? "not_found" : "unsure";
    photo = { read: String(answer.photo?.read ?? "").trim().slice(0, 300), match };
  }
  return { answer: String(answer.answer ?? "").trim(), cards, list, photo };
}
