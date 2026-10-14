import type { StatusInput } from "./hours";

/**
 * The main page's chat search (Prompt 10): what the browser and /api/ai-search say to each
 * other. The answer arrives as NDJSON — one JSON event per line — so the page can show the real
 * steps of the request, stream the answer word by word and add the cards built by the server.
 * Plain functions: used by the route, the page and the Deno tests (src/lib/chat_test.ts).
 */

/** The real steps of a request, in order (the status line under the thinking dots). */
export type ChatStep = "understand" | "search" | "verify";

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
  /** The freshness badge ("Aktualizované pred 8 min", or the stale text). */
  freshness: string;
  freshnessState: "current" | "recent" | "stale";
  /** "2,3 km od centra Košice" — only when the question named a town. */
  distance: string | null;
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
  cards: ChatCard[];
  shops: Record<string, ChatShop>;
  /** What was searched for (shown when nothing was found). */
  searched: string[];
}

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
export function answerForHistory(answer: string, cards: ChatCard[]): string {
  const shown = cards
    .slice(0, CARDS_SHOWN)
    .map((c) => `${c.name} – ${c.price} – ${c.shop}${c.place ? `, ${c.place}` : ""}`)
    .join("; ");
  return `${answer.trim()}${shown ? `\n[Shown: ${shown}]` : ""}`.slice(0, MAX_TURN_CHARS);
}
