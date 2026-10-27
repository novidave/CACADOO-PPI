import type { StatusInput } from "./hours";
import type { StockState } from "./stockDot";

/**
 * The main page's chat search (Prompt 10): what the browser and /api/ai-search say to each
 * other. The answer arrives as NDJSON — one JSON event per line — so the page can show the real
 * steps of the request, stream the answer word by word and add the cards built by the server.
 * Plain functions: used by the route, the page and the Deno tests (src/lib/chat_test.ts).
 */

/**
 * The real steps of a request, in order (the status line under the thinking dots): the question
 * reached the AI, it searches Cacaduu, its partners' feeds, shops nearby / the web (Prompt 11, only
 * when Cacaduu had too little), the results with availability and hours are back.
 */
export type ChatStep = "understand" | "search" | "partners" | "nearby" | "web" | "verify";

/** One result card: built by the server from search_stock results only, never from the AI's text. */
export interface ChatCard {
  id: string;
  href: string;
  /** As the shop wrote it. */
  name: string;
  /** In the question's language (sk/hu/en; else English), when it differs. */
  translated: string | null;
  translatedLang: string | null;
  brand: string | null;
  price: string;
  shopSlug: string;
  shop: string;
  shopHref: string;
  /** Street and town. */
  place: string;
  /** "12 ks na sklade" / "Vypredané"; null when the shop's data is stale. */
  availability: string | null;
  /** The stock dot before the price: available / sold_out / no_info (missing in older answers = no dot). */
  stock?: StockState;
  /** The freshness badge ("Aktualizované pred 8 min", or the stale text). */
  freshness: string;
  freshnessState: "current" | "recent" | "stale";
  /** "2,3 km od centra Košice" — only when the question named a town. */
  distance: string | null;
  /** Layer 1: verified stock from the shop's own file ("Cacaduu"). */
  source: "cacaduu";
  /** "overená zásoba" / "staršie údaje" / "bez aktuálnych údajov" (from the freshness). */
  confidence: string;
}

/**
 * Layer 2: a partner shop's product from its own feed (database update 35), as the partner sent it.
 * Never Cacaduu-verified stock: "skladom podľa partnera". Line: "Decathlon (partner) · 24,99 € ·
 * online skladom / predajňa Košice: skladom podľa partnera · údaje z 08:00".
 */
export interface PartnerCard {
  id: string;
  source: "partner";
  partner: string;
  logo: string | null;
  /** The product name as the partner's feed wrote it. */
  title: string;
  brand: string | null;
  /** The partner's product page; null when the feed has none. */
  href: string | null;
  /** The link is an affiliate link: marked "partnerský odkaz" (rel="sponsored"). Never changes the order. */
  affiliate: boolean;
  price: string | null;
  /** The regular price while the feed's sale price applies. */
  regularPrice: string | null;
  /** "online skladom"; null when the feed is older than 48 hours or says nothing. */
  online: string | null;
  /** "predajňa Košice: skladom podľa partnera" — only from the partner's local inventory feed. */
  stores: string[];
  /** "údaje z 08:00" / for old data "údaje z 12. 10. 2026". */
  checkedAt: string;
  stale: boolean;
  confidence: string;
}

/**
 * Layer 3: a shop of the right kind near the town's centre (OpenStreetMap). It may have the product;
 * its stock is never known ("zásoby neoverené").
 */
export interface NearbyCard {
  id: string;
  source: "osm";
  name: string;
  /** The kind of shop ("Železiarstvo"). */
  kind: string;
  place: string;
  /** "1,2 km od centra Michalovce". */
  distance: string;
  /** "otvorené do 17:00 (podľa OpenStreetMap)"; null when OpenStreetMap has no hours. */
  hours: string | null;
  phone: string | null;
  phoneHref: string | null;
  navigateHref: string;
  /** The shop on openstreetmap.org. */
  sourceHref: string;
  /** "údaje z OpenStreetMap pred 3 h". */
  checkedAt: string;
  confidence: string;
}

/** Layer 3 from Google Places: shown only in this list (never on our map, never to the AI). */
export interface GoogleCard {
  id: string;
  source: "google";
  name: string;
  place: string | null;
  distance: string;
  mapsHref: string | null;
  navigateHref: string;
  checkedAt: string;
  confidence: string;
}

/** Layer 4: a product page on a larger shop's website (an online offer, never store stock). */
export interface WebCard {
  id: string;
  source: "web";
  retailer: string;
  title: string;
  href: string;
  /** "cena podľa webu: 39,99 €" — only when the page's own text shows a price. */
  price: string | null;
  checkedAt: string;
  confidence: string;
}

/** The retailer's own search for the product (the admin's search address). */
export interface DeepLink {
  retailer: string;
  href: string;
}

/** The shops of the cards: their status dot (the same rule as everywhere) and the map pin. */
export interface ChatShop {
  name: string;
  href: string;
  lat: number | null;
  lng: number | null;
  status: StatusInput;
}

export interface ChatResults {
  /** Layer 1, Cacaduu: current, then recent, then stale. */
  cards: ChatCard[];
  /** Layer 2, partners' feeds ("Partneri"), in the database's order. */
  partners?: PartnerCard[];
  shops: Record<string, ChatShop>;
  /** What was searched for (shown when nothing was found). */
  searched: string[];
  /** Layer 3 (OpenStreetMap; "© OpenStreetMap contributors" with them). */
  nearby?: NearbyCard[];
  /** Layer 3 from Google Places (with Google's attribution). */
  google?: GoogleCard[];
  /** Layer 4. */
  web?: WebCard[];
  deepLinks?: DeepLink[];
  /** "only_cacaduu": the daily limit of outside searches was reached, only Cacaduu was searched. */
  notes?: ChatNote[];
}

export type ChatNote = "only_cacaduu";

export type ChatEvent =
  | { type: "step"; step: ChatStep }
  | { type: "language"; language: string }
  /** The next words of the answer. */
  | { type: "text"; text: string }
  /** Text streamed by a turn that then searched again: start the answer over. */
  | { type: "reset" }
  | ({ type: "results" } & ChatResults)
  /** The plain database search instead of the AI (no answer in 12 s, an error, a limit, no key). */
  | ({ type: "fallback"; limited: boolean; reason?: string } & ChatResults)
  /** Sent while an outside source is slow, so the page knows the answer is still coming. */
  | { type: "ping" }
  | { type: "done" };

/** One earlier turn the browser sends along (text only; the server keeps no conversation). */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export const MAX_QUESTION = 300;
/** The last turns sent with a question: three questions and their answers. */
export const MAX_HISTORY_TURNS = 6;
export const MAX_TURN_CHARS = 700;
/** Cards shown at once; "Zobraziť viac" shows the rest (at most MAX_CARDS). */
export const CARDS_SHOWN = 6;
export const MAX_CARDS = 12;

/**
 * The earlier turns as the browser sent them, cleaned: only user/assistant text, each cut to
 * MAX_TURN_CHARS, the last MAX_HISTORY_TURNS, starting with a question and alternating (the API
 * needs that). Anything else is dropped.
 */
export function cleanHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: ChatTurn[] = [];
  for (const entry of raw.slice(-40)) {
    const role = (entry as { role?: unknown })?.role;
    const text = (entry as { text?: unknown })?.text;
    if ((role !== "user" && role !== "assistant") || typeof text !== "string") continue;
    const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, MAX_TURN_CHARS);
    if (!clean) continue;
    // Two turns of the same role in a row: keep the newer one.
    if (turns.length && turns[turns.length - 1].role === role) turns.pop();
    turns.push({ role, text: clean });
  }
  let out = turns.slice(-MAX_HISTORY_TURNS);
  while (out.length && out[0].role !== "user") out = out.slice(1);
  // The new question follows: the history must end with an answer.
  while (out.length && out[out.length - 1].role !== "assistant") out = out.slice(0, -1);
  return out;
}

/** The item refs the AI chose, best first: only refs the searches returned, each once, at most `max`. */
export function chosenRefs(refs: unknown, known: (ref: string) => boolean, max = MAX_CARDS): string[] {
  if (!Array.isArray(refs)) return [];
  const out: string[] = [];
  for (const ref of refs) {
    if (typeof ref !== "string" || !known(ref) || out.includes(ref)) continue;
    out.push(ref);
    if (out.length >= max) break;
  }
  return out;
}

/** The answer's language as the AI gave it: a two-letter code, else null. */
export function answerLanguage(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z]{2}$/.test(code) ? code : null;
}

/**
 * Reads a string field of a JSON object that is still arriving (the AI's structured answer while
 * it streams): {"language":"sk","answer":"Našiel som…  →  answer = "Našiel som…". Returns the
 * text so far and whether the string is complete; null while the field has not started. Only
 * top-level fields; escapes are decoded; a half-received escape waits for the next piece.
 */
export function partialStringField(json: string, field: string): { value: string; complete: boolean } | null {
  let i = json.indexOf("{");
  if (i < 0) return null;
  i++;
  const skipSpace = () => {
    while (i < json.length && /\s/.test(json[i])) i++;
  };
  /** Reads a string at i (on its opening quote); returns its text and whether it closed. */
  const readString = (): { value: string; complete: boolean } => {
    i++; // the opening quote
    let value = "";
    while (i < json.length) {
      const c = json[i];
      if (c === '"') {
        i++;
        return { value, complete: true };
      }
      if (c === "\\") {
        const next = json[i + 1];
        if (next === undefined) break;
        if (next === "u") {
          const hex = json.slice(i + 2, i + 6);
          if (hex.length < 4) break;
          value += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        value += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[next] ?? next;
        i += 2;
        continue;
      }
      value += c;
      i++;
    }
    return { value, complete: false };
  };
  /** Skips any other value (a number, true, an array, an object) at depth 0 of the field. */
  const skipValue = (): boolean => {
    let depth = 0;
    while (i < json.length) {
      const c = json[i];
      if (c === '"') {
        if (!readString().complete) return false;
        continue;
      }
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        if (depth === 0) return true;
        depth--;
      } else if (c === "," && depth === 0) return true;
      i++;
    }
    return false;
  };
  while (i < json.length) {
    skipSpace();
    if (json[i] === "," ) {
      i++;
      continue;
    }
    if (json[i] !== '"') return null;
    const key = readString();
    if (!key.complete) return null;
    skipSpace();
    if (json[i] !== ":") return null;
    i++;
    skipSpace();
    if (i >= json.length) return null;
    if (json[i] === '"') {
      const value = readString();
      if (key.value === field) return value;
      if (!value.complete) return null;
    } else if (!skipValue()) {
      return null;
    }
  }
  return null;
}

/** Splits a growing NDJSON text into complete events; returns them and the unfinished rest. */
export function readEvents(buffer: string): { events: ChatEvent[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: ChatEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as ChatEvent);
    } catch {
      // A broken line is skipped; the rest of the answer still arrives.
    }
  }
  return { events, rest };
}

/** What the browser sends back about an answer for the next question: its text and the cards it showed. */
export function answerForHistory(answer: string, cards: ChatCard[], more: Pick<ChatResults, "partners" | "nearby" | "web"> = {}): string {
  const shown = cards
    .slice(0, CARDS_SHOWN)
    .map((c) => `${c.name} – ${c.price} – ${c.shop}${c.place ? `, ${c.place}` : ""}`)
    .join("; ");
  const partners = (more.partners ?? []).slice(0, 3).map((p) => `${p.partner}: ${p.title}${p.price ? ` – ${p.price}` : ""}`).join("; ");
  const nearby = (more.nearby ?? []).slice(0, 4).map((n) => `${n.name} (${n.kind}, ${n.distance})`).join("; ");
  const web = (more.web ?? []).slice(0, 3).map((w) => `${w.retailer}: ${w.title}`).join("; ");
  const parts = [
    shown && `[Shown: ${shown}]`,
    partners && `[Partners' feeds, not verified by Cacaduu: ${partners}]`,
    nearby && `[Nearby, stock not verified: ${nearby}]`,
    web && `[On the web: ${web}]`,
  ].filter(Boolean);
  return `${answer.trim()}${parts.length ? `\n${parts.join("\n")}` : ""}`.slice(0, MAX_TURN_CHARS);
}

/** The refs the AI chose of one kind ("p" partners, "n" nearby, "w" web), in its order; null when it chose none of them. */
export function refsOfKind(refs: string[], prefix: "r" | "p" | "n" | "w"): string[] | null {
  const mine = refs.filter((ref) => new RegExp(`^${prefix}\\d+$`).test(ref));
  return mine.length ? mine : null;
}
