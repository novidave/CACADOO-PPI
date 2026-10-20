/**
 * The main chat's search in layers (Prompt 11): Cacaduu first (search_stock), then shops nearby
 * (OpenStreetMap, optionally Google Places) and the web (Claude's web search on allowed shop
 * websites), both through the product-sources Edge Function. Plain rules shared by the server, the
 * page and the Deno tests (src/lib/chat_test.ts, supabase/functions/product-sources/index_test.ts).
 */

/** The kinds of shop the AI may choose for a product (the function's CATEGORIES has the same keys). */
export const SHOP_CATEGORIES = [
  "fuel",
  "car_parts",
  "hardware",
  "paint",
  "garden",
  "electronics",
  "shoes",
  "sports",
  "clothes",
  "supermarket",
  "food",
  "chemist",
  "pharmacy",
  "bicycle",
  "books",
  "toys",
  "pets",
  "home",
  "department",
  "cosmetics",
  "optician",
  "florist",
  "jewelry",
  "drinks",
  "kiosk",
  "music",
] as const;
export type ShopCategory = (typeof SHOP_CATEGORIES)[number];

/** Layers 3 and 4 run only when Cacaduu gave fewer good results than this. */
export const GOOD_ENOUGH = 3;

/** Lower case, no accents, single spaces: "v Michalovciach" → "v michalovciach". */
export function plainWords(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Whether the shopper named this town in their own words: the AI may not invent one (the visitor's
 * location is never asked for or guessed). Slovak and Hungarian bend town names ("Michalovce" →
 * "v Michalovciach", "Košice" → "v Košiciach", "Budapest" → "Budapesten"), so the start of each
 * word of the town (all but its last letters) must begin a word the shopper wrote. Short words
 * ("nad", "pri", "Ves" → "Vsi") are skipped when the town has longer ones.
 */
export function townInWords(town: string, texts: string[]): boolean {
  const parts = plainWords(town).split(" ").filter(Boolean);
  if (!parts.length) return false;
  const long = parts.filter((w) => w.length >= 4);
  const check = long.length ? long : [parts.reduce((a, b) => (b.length > a.length ? b : a))];
  const written = new Set(texts.flatMap((text) => plainWords(text).split(" ")).filter(Boolean));
  return check.every((part) => {
    const stem = part.length < 4 ? part : part.length === 4 ? part.slice(0, 3) : part.slice(0, Math.max(4, Math.min(part.length - 2, 6)));
    for (const word of written) if (word.startsWith(stem)) return true;
    return false;
  });
}

/**
 * A good Cacaduu result: the shop's data is current or recent (not stale), the item is not sold out,
 * and — when the shopper named a town — the search really looked around that town (a town without
 * Cacaduu shops searches all shops, which does not answer "in Michalovce").
 */
export function isGoodResult(item: { freshness: { state: string }; quantity: number | null }, aroundTown: boolean | null): boolean {
  if (item.freshness.state !== "current" && item.freshness.state !== "recent") return false;
  if (item.quantity !== null && item.quantity <= 0) return false;
  return aroundTown !== false;
}

/** "18:30" or "8:00" from a wall-clock time (the town's own time). */
function hhmm(date: Date): string {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The wall-clock time of a moment in a time zone, as a Date whose local fields read that time (the
 * opening_hours library reads local fields). Times stay in UTC everywhere else.
 */
export function wallClock(at: Date, timeZone: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

export interface HoursState {
  open: boolean;
  /** The next change on the same or the next day, as "17:00", with whether it is tomorrow. */
  next: { time: string; tomorrow: boolean } | null;
}

/**
 * Open now and until when, from an OpenStreetMap opening_hours value already read by the
 * opening_hours library (passed in: it is a server-only dependency). null when unknown.
 */
export function hoursState(
  oh: { getState(date?: Date): boolean; getUnknown(date?: Date): boolean; getNextChange(date?: Date, maxdate?: Date): Date | undefined },
  now: Date,
): HoursState | null {
  if (oh.getUnknown(now)) return null;
  const open = oh.getState(now);
  const limit = new Date(now.getTime() + 2 * 86_400_000);
  const next = oh.getNextChange(now, limit);
  if (!next) return { open, next: null };
  const tomorrow = next.getDate() !== now.getDate() || next.getMonth() !== now.getMonth();
  const dayAfter = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  return { open, next: next < dayAfter ? { time: hhmm(next), tomorrow } : null };
}
