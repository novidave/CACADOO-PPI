import "server-only";
import { after } from "next/server";
import { supabaseEnv } from "./supabase/env";
import { createPublicClient } from "./supabase/public";
import type { ShopLanguages } from "./shopLanguages";

/**
 * The shops' own content in the visitor's language (database update 40). The original always stays as the shop wrote
 * it; a translation is shown in its place with "Preložené automaticky" (status ai) and the page's "Zobraziť
 * originál" link (?original=1). The database decides what may be shown (shop_translations(): only shown things,
 * never a stale AI text). Item names come with every stock row as name_i18n and are shown under the original.
 */

export type TranslationKind =
  | "item_name"
  | "item_description"
  | "item_category"
  | "assistant_label"
  | "assistant_welcome"
  | "special_note"
  | "content_title"
  | "section_title"
  | "section_alt"
  | "blog_title"
  | "blog_body";

export interface Translation {
  text: string;
  /** 'shop' = from the shop's own file, 'ai' = Claude, 'manual' = the owner. */
  status: "shop" | "ai" | "manual";
}

export interface ShopTexts {
  lang: string;
  /** The shop's own language: nothing is translated. */
  same: boolean;
  /** "Zobraziť originál": the visitor asked for the shop's own words. */
  original: boolean;
  get(kind: TranslationKind, ref: string): Translation | null;
  /** The text to show: the translation, else the original. Notes when something had to stay in the original. */
  text(kind: TranslationKind, ref: string, original: string): string;
  text(kind: TranslationKind, ref: string, original: string | null): string | null;
  /** Something shown is an automatic translation (the page shows the note). */
  readonly machine: boolean;
  /** Something shown has no translation yet (the page shows "Prekladáme…" while the translate function works). */
  readonly missing: boolean;
}

class Texts implements ShopTexts {
  machine = false;
  missing = false;
  constructor(
    readonly lang: string,
    readonly same: boolean,
    readonly original: boolean,
    private readonly rows: Map<string, Translation>,
  ) {}
  get(kind: TranslationKind, ref: string) {
    return this.rows.get(`${kind}:${ref}`) ?? null;
  }
  text(kind: TranslationKind, ref: string, original: string): string;
  text(kind: TranslationKind, ref: string, original: string | null): string | null;
  text(kind: TranslationKind, ref: string, original: string | null) {
    if (!original || this.same) return original;
    const found = this.get(kind, ref);
    if (!found) {
      this.missing = true;
      return original;
    }
    if (found.status === "ai") this.machine = true;
    return this.original ? original : found.text;
  }
}

/** No translations (the shop's own language, before update 40, or on an error). */
export function noTexts(lang: string, same = true): ShopTexts {
  return new Texts(lang, same, false, new Map());
}

/** What a page asks for: some kinds, optionally only some things (an item, the posts in the slider). */
export interface TextsWanted {
  kinds: TranslationKind[];
  refs?: string[];
}

/**
 * A shop's translations in one language, for what the page shows. The shop's own language → nothing is asked. A
 * language that is not pre-translated starts the translate function (once in 10 minutes per shop and language, after
 * the page was sent; the database decides).
 */
export async function getShopTexts(slug: string, lang: string, langs: ShopLanguages, original: boolean, wanted: TextsWanted[]): Promise<ShopTexts> {
  if (lang === langs.main) return noTexts(lang);
  const db = createPublicClient();
  const rows = new Map<string, Translation>();
  if (db) {
    const answers = await Promise.all(
      wanted
        .filter((w) => w.kinds.length && (!w.refs || w.refs.length))
        .map((w) => Promise.resolve(db.rpc("shop_translations", { p_slug: slug, p_lang: lang, p_kinds: w.kinds, p_refs: w.refs ?? null })).catch(() => null)),
    );
    for (const answer of answers) {
      if (!answer || answer.error || !Array.isArray(answer.data)) continue;
      for (const r of answer.data as { kind: string; ref: string; text: string; status: Translation["status"] }[]) {
        rows.set(`${r.kind}:${r.ref}`, { text: r.text, status: r.status });
      }
    }
  }
  if (!langs.preferred.includes(lang as never)) requestTranslation(slug, lang);
  return new Texts(lang, false, original, rows);
}

/** Asks the translate function to translate a shop into a language, after the response (never delays the page). */
export function requestTranslation(slug: string, lang: string): void {
  const env = supabaseEnv();
  if (!env) return;
  try {
    after(async () => {
      await fetch(`${env.url}/functions/v1/translate`, {
        method: "POST",
        headers: { apikey: env.key, Authorization: `Bearer ${env.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "kick", slug, lang }),
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null);
    });
  } catch {
    // outside a request (tests, build): nothing to ask
  }
}

/** An item's description and category as the page shows them (update 40; none before it). */
export async function getItemTexts(itemId: string): Promise<{ description: string | null; source: "shop" | "cacaduu" | null; category: string | null } | null> {
  const db = createPublicClient();
  if (!db) return null;
  const { data, error } = await db.rpc("item_texts", { p_item_id: itemId });
  if (error || !data) return null;
  const row = (Array.isArray(data) ? data[0] : data) as { description: string | null; description_source: "shop" | "cacaduu" | null; category: string | null } | undefined;
  return row ? { description: row.description, source: row.description_source, category: row.category } : null;
}
