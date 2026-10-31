/**
 * The owner's translation table (Môj obchod → "Jazyky a inventár" and a product's "Preklady" tab, update 40): one cell
 * = one text (kind + ref) in one language, with its state as owner_translations() gives it. Shared by the server
 * actions and the browser.
 */

export interface Cell {
  kind: string;
  ref: string;
  lang: string;
}

/** shop = "Od obchodu", ai = "AI", manual = "Upravené ručne", stale = "Zastaraný", missing = "Chýba", none = "Neprekladať". */
export type CellState = "shop" | "ai" | "manual" | "stale" | "missing" | "none";

export interface CellRow extends Cell {
  source: string;
  text: string | null;
  state: CellState;
  updated_at: string | null;
}

export const STATES: CellState[] = ["shop", "ai", "manual", "stale", "missing", "none"];

/** Claude may replace only these (a shop's or the owner's own text only gets "Navrhnúť nový preklad"). */
export const replaceable = (state: CellState) => state === "ai" || state === "stale" || state === "missing" || state === "none";

export const cellKey = (c: Cell) => `${c.kind}:${c.ref}:${c.lang}`;

/** "Texty stránky" (update 62): one original of the page with its languages (owner_page_texts()). */
export interface PageTextRow {
  kind: string;
  ref: string;
  source: string;
  cells: { lang: string; text: string | null; state: CellState; updated_at: string | null }[];
}

/** The groups of the "Čo" filter of Texty stránky (page_text_group() in SQL). */
export const PAGE_TEXT_GROUPS = ["assistant", "hours", "content", "blog"] as const;

/** How many languages of an original still need a text ("Chýba" or "Zastaraný"). */
export const lacking = (row: PageTextRow) => row.cells.filter((c) => c.state === "missing" || c.state === "stale").length;
