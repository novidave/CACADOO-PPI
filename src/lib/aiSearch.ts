import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { callerHash } from "./apiHttp";
import { formatPrice } from "./format";
import { translatedName } from "./names";
import { apiItem, searchStock } from "./publicApi";
import { availabilityText, freshnessText } from "./stock";
import { createPublicClient } from "./supabase/public";

/**
 * AI search on the main page: an extra layer above the plain results. Claude Haiku works
 * out what the shopper needs and searches the stock several times with search_stock
 * (src/lib/publicApi.ts: the same data and rules as everywhere else). The result cards
 * are built only from what those searches returned, never from the model's own text.
 * No location is used.
 */

const MODEL = "claude-haiku-5-5";
/** Model turns that may still search; the turn after them must answer. */
const MAX_SEARCH_ROUNDS = 3;
const MAX_SEARCHES = 12;
const RESULTS_PER_SEARCH = 15;
const MAX_CARDS = 12;
/** After this, the next turn must answer with what was found. */
const TIME_BUDGET_MS = 30_000;
const DEFAULT_DAILY_LIMIT = 500;

type FoundItem = ReturnType<typeof apiItem>;

export interface AiCard {
  href: string;
  name: string;
  translated: string | null;
  brand: string | null;
  price: string;
  shop: string;
  shopHref: string;
  place: string;
  availability: string | null;
  freshness: string;
}

export interface AiSearchResult {
  language: string;
  answer: string;
  searched: string[];
  cards: AiCard[];
}

/** On when the Anthropic key is set on the server (Vercel), never in the browser. */
export function aiSearchEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function dailyLimit(): number {
  const value = Number(process.env.AI_DAILY_LIMIT);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_DAILY_LIMIT;
}

/** 10 AI searches per minute per caller and AI_DAILY_LIMIT per day for the site; false = plain results only. */
export async function aiSearchAllowed(request: Request): Promise<boolean> {
  const supabase = createPublicClient();
  if (!supabase) return false;
  const { data, error } = await supabase.rpc("ai_search_hit", {
    p_ip_hash: callerHash(request),
    p_daily_limit: dailyLimit(),
  });
  return !error && data === true;
}

const SYSTEM =
  "You are the search assistant of PPI, a website that shows which local shops have a product in stock right now.\n" +
  "A shopper asks in any language. Work out what they need, then find it with search_stock:\n" +
  "- Search for the product names and their synonyms in Slovak, Hungarian and English, the short forms shops use " +
  "in their stock lists, and related products that solve the need (a leaking pipe: sealing tape, silicone, pipe clamp).\n" +
  "- Each search is one short term of one to three words; every word must appear in the item.\n" +
  "- Make the searches you need at once, in parallel. Search again only when the results suggest a better term.\n" +
  "- Never ask for or use the shopper's location.\n" +
  "Then answer in the language the shopper wrote in:\n" +
  "- answer: one to three short sentences on what fits the need and why. Mention only items that search_stock " +
  "returned. Never invent items, prices, shops or stock, and do not state prices or availability: cards under your " +
  "answer show them. If nothing fitting was found, say so plainly.\n" +
  "- item_refs: the refs of the returned items that fit, best first, at most 12.\n" +
  "- language: the language of the shopper's question: sk, hu, en or other.";

const SEARCH_TOOL: Anthropic.Tool = {
  name: "search_stock",
  description:
    "Searches the stock of every shop on PPI by text: product names in Slovak, Hungarian or English, brand, EAN, " +
    "shop name, street or town. Accents and case are ignored; every word of the query must appear. Returns up to " +
    `${RESULTS_PER_SEARCH} items with a ref, the name as the shop wrote it, its translation, brand, price, shop and ` +
    "availability (null when the shop's data is too old to say). Call it for every search term you need.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "One short search term, one to three words." },
      only_available: { type: "boolean", description: "true: only items in stock with fresh data." },
    },
    required: ["query", "only_available"],
    additionalProperties: false,
  },
};

const ANSWER_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      language: { type: "string", enum: ["sk", "hu", "en", "other"] },
      answer: { type: "string" },
      item_refs: { type: "array", items: { type: "string" } },
    },
    required: ["language", "answer", "item_refs"],
    additionalProperties: false,
  },
};

/** Runs one shopper question. Throws on any problem: the caller then shows the plain results only. */
export async function runAiSearch(question: string, lang: Locale, onlyAvailable: boolean): Promise<AiSearchResult> {
  const client = new Anthropic({ maxRetries: 1, timeout: 15_000 });
  const started = Date.now();
  const found = new Map<string, FoundItem>(); // ref → item
  const refOf = new Map<string, string>(); // item id → ref
  const searched: string[] = [];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];

  async function search(call: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
    const input = call.input as { query?: unknown; only_available?: unknown };
    const query = typeof input.query === "string" ? input.query.trim().slice(0, 100) : "";
    if (!query || searched.length >= MAX_SEARCHES) {
      return { type: "tool_result", tool_use_id: call.id, is_error: true, content: "No more searches: answer with what you have." };
    }
    searched.push(query);
    const { results } = await searchStock({ q: query, onlyAvailable: onlyAvailable || input.only_available === true, lang });
    const items = results.slice(0, RESULTS_PER_SEARCH).map((item) => {
      let ref = refOf.get(item.id);
      if (!ref) {
        ref = `r${refOf.size + 1}`;
        refOf.set(item.id, ref);
        found.set(ref, item);
      }
      return {
        ref,
        name: item.name,
        name_translated: item.name_translated,
        brand: item.brand,
        price: item.price === null ? null : `${item.price} ${item.currency}`,
        shop: [item.shop.name, item.shop.city].filter(Boolean).join(", "),
        availability: item.availability_text,
      };
    });
    return { type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ query, items }) };
  }

  for (let round = 0; ; round++) {
    const mustAnswer = round >= MAX_SEARCH_ROUNDS || searched.length >= MAX_SEARCHES || Date.now() - started > TIME_BUDGET_MS;
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM,
      tools: [SEARCH_TOOL],
      tool_choice: { type: mustAnswer ? "none" : "auto" },
      output_config: { effort: "low", format: ANSWER_FORMAT },
      cache_control: { type: "ephemeral" },
      messages,
    });

    if (response.stop_reason === "tool_use" && !mustAnswer) {
      const calls = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: await Promise.all(calls.map(search)) });
      continue;
    }
    if (response.stop_reason !== "end_turn") throw new Error(`AI search stopped: ${response.stop_reason}`);

    const text = response.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") throw new Error("AI search gave no answer");
    const answer = JSON.parse(text.text) as { language: string; answer: string; item_refs: string[] };
    const items = [...new Set(answer.item_refs)]
      .map((ref) => found.get(ref))
      .filter((item): item is FoundItem => Boolean(item))
      .slice(0, MAX_CARDS);
    return {
      language: answer.language,
      answer: answer.answer.trim(),
      searched,
      cards: await toCards(items, lang),
    };
  }
}

/** The result cards, in the page language, from the search results only. */
async function toCards(items: FoundItem[], lang: Locale): Promise<AiCard[]> {
  const dict = await getDictionary(lang);
  return items.map((item) => ({
    href: `/${lang}/items/${item.id}`,
    name: item.name,
    translated: translatedName(item.name, { [lang]: item.name_translated ?? undefined }, lang),
    brand: item.brand,
    price: formatPrice(item.price, lang, item.currency),
    shop: item.shop.name,
    shopHref: `/${lang}/shops/${item.shop.slug}`,
    place: [item.shop.address, item.shop.city].filter(Boolean).join(", "),
    availability: availabilityText(dict, item.availability, item.quantity),
    freshness: freshnessText(dict, item.freshness.state, item.freshness.age_minutes, item.freshness.updated_at, item.shop.timezone),
  }));
}
