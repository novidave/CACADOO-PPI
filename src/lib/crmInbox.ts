/**
 * CRM → Konverzácie, the two-pane inbox (2026-11-07; canvas "Cacaduu – webová aplikácia (Môj obchod)", artboards 8 and
 * 8b): the pure rules the list and the conversation draw with — the row's time words in the shop's time zone, the row's
 * tags, the draft's first words, the list's address, which conversation opens when none is chosen, the drafts' local
 * copy key. No imports (the Deno tests read it). SQL decides every value (owner_conversations_inbox: the masked phone,
 * waiting, the next booking, the caller's draft).
 */

/** The segmented filter: everything, waiting for an answer, with a booking. */
export const INBOX_FILTERS = ["", "waiting", "booked"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/** The calendar day of an instant in a time zone ("2026-11-07"). */
export function dayIn(iso: string | number | Date, timeZone: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The row's time: today "14:05", yesterday "včera", else the date ("5. 11." this year, "5. 11. 2025" before) — all in
 * the shop's time zone.
 */
export function timeWord(
  iso: string,
  now: number,
  timeZone: string,
  lang: string,
): { kind: "time"; text: string } | { kind: "yesterday" } | { kind: "date"; text: string } {
  const day = dayIn(iso, timeZone);
  const today = dayIn(now, timeZone);
  if (day === today) {
    return { kind: "time", text: new Intl.DateTimeFormat(lang, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)) };
  }
  // yesterday in the shop's calendar (noon of today minus a day avoids the clock changes)
  const [y, m, d] = today.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1, 12)).toISOString().slice(0, 10);
  if (day === yesterday) return { kind: "yesterday" };
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  const text = new Intl.DateTimeFormat(lang, {
    timeZone,
    day: "numeric",
    month: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(iso));
  return { kind: "date", text };
}

/** "pi 10:30": a booking's start, the weekday short and the time, in the shop's time zone. */
export function bookingWhen(iso: string, timeZone: string, lang: string): { day: string; time: string } {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat(lang, { timeZone, weekday: "short" }).format(date).replace(/\.$/, "");
  const time = new Intl.DateTimeFormat(lang, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return { day, time };
}

/** The draft's first words for line 2 of a row: spaces folded, cut at a word, "…" when longer. */
export function draftWords(text: string | null | undefined, max = 48): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : clean.slice(0, max)).replace(/[\s,.;:–-]+$/, "")}…`;
}

export interface InboxRowFacts {
  waiting: boolean;
  next_booking_at: string | null;
  shopper_lang: string | null;
  page_lang: string;
  starred: boolean;
  status: string;
  draft_text: string | null;
}

export type RowTag =
  | { kind: "waiting" }
  | { kind: "booking"; at: string }
  | { kind: "lang"; code: string }
  | { kind: "star" }
  | { kind: "new" }
  | { kind: "draft" };

/**
 * A row's tags in their order: "Čaká na odpoveď", "Rezervácia pi 10:30" (the next live booking), the shopper's
 * language when it differs from the shop's ("HU"), ★, "Nová", and the dashed "Koncept" while the caller has a draft.
 */
export function rowTags(row: InboxRowFacts, shopLang: string): RowTag[] {
  const tags: RowTag[] = [];
  if (row.waiting) tags.push({ kind: "waiting" });
  if (row.next_booking_at) tags.push({ kind: "booking", at: row.next_booking_at });
  const lang = (row.shopper_lang ?? row.page_lang ?? "").toLowerCase();
  if (lang && lang !== shopLang.toLowerCase()) tags.push({ kind: "lang", code: lang.toUpperCase() });
  if (row.starred) tags.push({ kind: "star" });
  if (row.status === "new") tags.push({ kind: "new" });
  if (row.draft_text && row.draft_text.trim()) tags.push({ kind: "draft" });
  return tags;
}

/** The shop's own language for the "HU" tag: its home language, else its country's (sk / hu / cs / en …). */
export function shopLanguage(country: string | null | undefined, preferred?: string | null): string {
  if (preferred) return preferred.toLowerCase();
  const byCountry: Record<string, string> = { SK: "sk", HU: "hu", CZ: "cs", AT: "de", DE: "de", PL: "pl", RO: "ro", SI: "sl", HR: "hr" };
  return byCountry[(country ?? "").toUpperCase()] ?? "en";
}

/**
 * The conversation that opens when the address names none (≥ 1024 px): the newest waiting one, else the newest one
 * (the list is newest first); none in an empty shop.
 */
export function defaultOpen<T extends { id: string; waiting: boolean }>(rows: T[]): string | null {
  return (rows.find((r) => r.waiting) ?? rows[0])?.id ?? null;
}

/** The list's query (filters, search, page) + the open conversation: every row is a real link with it. */
export function inboxHref(base: string, query: Record<string, string>, open?: string | null): string {
  const q = new URLSearchParams(Object.entries(query).filter(([k, v]) => k !== "c" && v !== ""));
  if (open) q.set("c", open);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/** The local copy of a draft that could not be saved (offline): one per conversation. */
export const draftKey = (conversationId: string) => `ppi.crm.draft.${conversationId}`;

/** Whether a reply text holds a variable ({meno} or {{shop_phone}}): only then "Náhľad" before sending. */
export function hasVariable(text: string): boolean {
  return /\{\{?\s*[a-z_]+\s*\}?\}/i.test(text);
}
