/**
 * "Ignorované produkty" (update 88, 2026-11-07): the screen's rules, no imports, so `ignoredItems_test.ts`
 * (`npm run test:items`) runs them as they are. Every decision about which products go is SQL's
 * (`owner_ignore_items`); these only say how the screen words it.
 */

/** One product of "Produkty zo súboru" as owner_ignore_candidates() answers it. */
export interface IgnoreCandidate {
  id: string;
  name: string;
  code: string;
  ean: string | null;
  quantity: number | null;
}

/** One line of "Ignorované (n)" as owner_ignored_items() answers it. */
export interface IgnoredEntry {
  key: string;
  name: string | null;
  created_at: string;
  by: string | null;
  by_me: boolean;
}

/** The three plural forms the texts have ("1 produkt", "3 produkty", "5 produktov"). */
export function pluralKey(n: number, lang: string): "one" | "few" | "other" {
  let cat: string;
  try {
    cat = new Intl.PluralRules(lang).select(n);
  } catch {
    cat = n === 1 ? "one" : "other";
  }
  return cat === "one" ? "one" : cat === "few" ? "few" : "other";
}

/** The stock word of a row: what visitors saw ("12 ks", "Vypredané") or "Skryté" when the shop's data are stale. */
export function stockWord(quantity: number | null, stale: boolean): { key: "stock_n" | "sold_out" | "stale"; n: number } {
  if (stale) return { key: "stale", n: 0 };
  const n = Number(quantity ?? 0);
  return n > 0 ? { key: "stock_n", n } : { key: "sold_out", n: 0 };
}

/** "Kód A1 · EAN 858…": the code always, the EAN when the product has one. */
export function codeLine(code: string, ean: string | null, labels: { code: string; ean: string }): string {
  const fill = (t: string, v: string) => t.replace("{code}", v).replace("{ean}", v);
  const parts = [fill(labels.code, code)];
  if (ean) parts.push(fill(labels.ean, ean));
  return parts.join(" · ");
}

/**
 * The delete button in edit mode: "Vymazať (n)" with ticks, else "Vymazať všetko (n)" = every product the list shows
 * (never the "similar" rows of a search without a real hit: then n = 0 and the button is disabled).
 */
export function deleteButton(selected: number, matched: number): { all: boolean; n: number; disabled: boolean } {
  if (selected > 0) return { all: false, n: selected, disabled: false };
  return { all: true, n: matched, disabled: matched <= 0 };
}

/** "Vybrať všetko" while something on the page is not ticked, else "Zrušiť výber". */
export function selectAllLabel(shownIds: string[], selected: Set<string>): "select_all" | "select_none" {
  return shownIds.length > 0 && shownIds.every((id) => selected.has(id)) ? "select_none" : "select_all";
}

/** Ticking a row: on → off, off → on (a new set; the old one stays as it was). */
export function toggle(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** "Vymazať všetko" asks for the shop's name, the same rule as update 43's "Vymazať celý sklad". */
export function nameConfirmed(typed: string, shopName: string): boolean {
  return typed.trim().toLocaleLowerCase() === shopName.trim().toLocaleLowerCase() && shopName.trim() !== "";
}

/** After "Obnoviť": which line tells when the products come back (the next file, the till's or the program's sync). */
export function restoredKey(source: string | null | undefined): "restored" | "restored_agent" | "restored_api" {
  return source === "agent" ? "restored_agent" : source === "api" ? "restored_api" : "restored";
}

/** The database's refusals as the screen's text keys (anything else = "err_failed"). */
export function errorKey(message: string | null | undefined): string {
  const m = String(message ?? "");
  if (m === "changed") return "err_changed";
  if (m === "too_many") return "err_too_many";
  if (m === "nothing_to_remove" || m === "nothing_to_restore") return "err_nothing";
  if (m === "sklad_source") return "sklad_note";
  if (m.startsWith("restore_")) return "err_undo";
  if (m === "name") return "err_name";
  return "err_failed";
}

/** How long the toast with "Späť" stays. */
export const TOAST_MS = 8000;
