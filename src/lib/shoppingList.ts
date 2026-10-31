/**
 * The shop page's "Zoznam" (shopping list, 2026-10-29): the visitor's own list of a shop's products, kept only in this
 * browser (localStorage, one key per shop; nothing is sent anywhere). Each entry keeps the name and price as the page
 * showed them when it was added, so the list survives a reload and products from other pages of the list. The page
 * never changes shop data: the names and prices are the shop's own, the quantity is the visitor's.
 * No imports: used by client components and by `shoppingList_test.ts` (Deno).
 */

export interface ListEntry {
  id: string;
  /** The name in the page language (as the list shows it). */
  name: string;
  /** The name as the shop wrote it, when the page showed a translation. */
  original: string | null;
  price: number | null;
  currency: string;
  qty: number;
}

export type ListItem = Omit<ListEntry, "qty">;

/** Pieces per product never go above this (a typo in a stepper should not make a 10-digit line). */
export const MAX_QTY = 999;

export const storageKey = (shopId: string) => `ppi.list.${shopId}`;

const clampQty = (n: number) => Math.max(0, Math.min(MAX_QTY, Math.floor(n)));

/** The stored list, checked entry by entry (anything broken or edited by hand is dropped, never shown). */
export function parseList(raw: string | null): ListEntry[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: ListEntry[] = [];
  for (const e of data) {
    if (!e || typeof e !== "object") continue;
    const { id, name, original, price, currency, qty } = e as Record<string, unknown>;
    if (typeof id !== "string" || !id || seen.has(id) || typeof name !== "string" || !name) continue;
    if (typeof qty !== "number" || !Number.isFinite(qty) || clampQty(qty) < 1) continue;
    seen.add(id);
    out.push({
      id,
      name,
      original: typeof original === "string" && original ? original : null,
      price: typeof price === "number" && Number.isFinite(price) ? price : null,
      currency: typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : "EUR",
      qty: clampQty(qty),
    });
  }
  return out;
}

/** One more piece (a new product goes to the end of the list). */
export function addOne(list: readonly ListEntry[], item: ListItem): ListEntry[] {
  const at = list.findIndex((e) => e.id === item.id);
  if (at < 0) return [...list, { ...item, qty: 1 }];
  return list.map((e, i) => (i === at ? { ...e, qty: clampQty(e.qty + 1) } : e));
}

/** A product's quantity; 0 or less takes it off the list. */
export function setQty(list: readonly ListEntry[], id: string, qty: number): ListEntry[] {
  const n = clampQty(qty);
  return n < 1 ? list.filter((e) => e.id !== id) : list.map((e) => (e.id === id ? { ...e, qty: n } : e));
}

export const qtyOf = (list: readonly ListEntry[], id: string) => list.find((e) => e.id === id)?.qty ?? 0;

/** Every piece on the list (the Zoznam tab's counter). */
export const pieces = (list: readonly ListEntry[]) => list.reduce((n, e) => n + e.qty, 0);

/** A counter's text: "9+" above `max`. */
export const badgeText = (n: number, max = 9) => (n > max ? `${max}+` : String(n));

/** quantity × price, in cents to avoid 0.1 + 0.2 (null without a price). */
export function lineAmount(e: ListEntry): number | null {
  return e.price === null ? null : Math.round(e.price * 100 * e.qty) / 100;
}

/** "Spolu" per currency (a shop normally has one), in the order the currencies first appear. */
export function totals(list: readonly ListEntry[]): { currency: string; amount: number }[] {
  const sums = new Map<string, number>();
  for (const e of list) {
    const line = lineAmount(e);
    if (line === null) continue;
    sums.set(e.currency, Math.round(((sums.get(e.currency) ?? 0) + line) * 100) / 100);
  }
  return [...sums].map(([currency, amount]) => ({ currency, amount }));
}

/** Which plural form a count takes: Slovak 1 produkt · 2–4 produkty · 5+ produktov (also 0); other languages one/other. */
export function pluralForm(n: number, lang: string): "one" | "few" | "other" {
  let rule: string;
  try {
    rule = new Intl.PluralRules(lang).select(n);
  } catch {
    rule = n === 1 ? "one" : "other";
  }
  return rule === "one" ? "one" : rule === "few" ? "few" : "other";
}

/**
 * The text "Kopírovať zoznam" copies: the title with the shop's name, its address, one line per product, the total.
 *   Nákupný zoznam – Davide
 *   Hlavná 1, 040 01 Košice
 *
 *   2× Akrylová farba – 19,80 €
 *
 *   Spolu: 19,80 €
 * The shop's own name goes along in brackets when the list shows a translation (the shop knows its own names).
 */
export function listText(
  list: readonly ListEntry[],
  opts: { title: string; shopName: string; address: string | null; total: string; format: (amount: number, currency: string) => string },
): string {
  const head = [`${opts.title} – ${opts.shopName}`, ...(opts.address ? [opts.address] : [])];
  const lines = list.map((e) => {
    const name = e.original && e.original !== e.name ? `${e.name} (${e.original})` : e.name;
    const line = lineAmount(e);
    return `${e.qty}× ${name}${line === null ? "" : ` – ${opts.format(line, e.currency)}`}`;
  });
  const sum = totals(list);
  const out = [...head, "", ...lines];
  if (sum.length) out.push("", `${opts.total}: ${sum.map((s) => opts.format(s.amount, s.currency)).join(" + ")}`);
  return out.join("\n");
}

/**
 * One list per shop for the whole page (both tabs read the same store, so their counters never differ). Reads and
 * writes are wrapped: blocked storage (private mode, full quota, cookies off) keeps the list for this visit only. Another
 * browser tab of the same shop changes it too (the `storage` event). For React's useSyncExternalStore.
 */
export interface ListStore {
  subscribe(listener: () => void): () => void;
  get(): readonly ListEntry[];
  set(next: readonly ListEntry[]): void;
}

const EMPTY: readonly ListEntry[] = Object.freeze([]);
const stores = new Map<string, ListStore>();

/** What the server renders (and the first paint before the stored list is read). */
export const serverList = () => EMPTY;

export function listStore(shopId: string): ListStore {
  const known = stores.get(shopId);
  if (known) return known;
  const key = storageKey(shopId);
  const listeners = new Set<() => void>();
  let current: readonly ListEntry[] | null = null;
  const read = (): readonly ListEntry[] => {
    try {
      return parseList(globalThis.localStorage?.getItem(key) ?? null);
    } catch {
      return EMPTY;
    }
  };
  const notify = () => listeners.forEach((l) => l());
  const onStorage = (e: StorageEvent) => {
    if (e.key !== key) return;
    current = parseList(e.newValue);
    notify();
  };
  const store: ListStore = {
    subscribe(listener) {
      if (listeners.size === 0) globalThis.addEventListener?.("storage", onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) globalThis.removeEventListener?.("storage", onStorage);
      };
    },
    get() {
      if (current === null) current = read();
      return current;
    },
    set(next) {
      current = next.length ? next : EMPTY;
      try {
        if (next.length) globalThis.localStorage?.setItem(key, JSON.stringify(next));
        else globalThis.localStorage?.removeItem(key);
      } catch {
        // storage blocked or full: the list still works until the page is left
      }
      notify();
    },
  };
  stores.set(shopId, store);
  return store;
}
