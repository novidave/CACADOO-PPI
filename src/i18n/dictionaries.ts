import "server-only";
import { cache } from "react";
import { createPublicClient } from "@/lib/supabase/public";
import type { Locale } from "./config";
import { HANDWRITTEN, LANGUAGES } from "./languages";
import { flatten, layered } from "./messages";
import sk from "./messages/sk.json";

export type Dictionary = typeof sk;

const files: Record<(typeof HANDWRITTEN)[number], () => Promise<Record<string, unknown>>> = {
  sk: () => import("./messages/sk.json").then((m) => m.default),
  hu: () => import("./messages/hu.json").then((m) => m.default),
  en: () => import("./messages/en.json").then((m) => m.default),
};

/** A few minutes per server instance: the admin's edits show up soon, pages do not ask the database each time. */
const TTL = 5 * 60_000;
const stored = new Map<string, { at: number; value: Record<string, string> | null }>();

/**
 * The interface texts of a language from the database (update 40: "Admin → Preklady rozhrania" and the translation
 * step): {"shop.open": "…"}; null before update 40 or on any error.
 */
async function databaseTexts(lang: string): Promise<Record<string, string> | null> {
  const known = stored.get(lang);
  if (known && Date.now() - known.at < TTL) return known.value;
  const db = createPublicClient();
  let value: Record<string, string> | null = null;
  if (db) {
    const { data, error } = await db.rpc("ui_messages", { p_lang: lang });
    if (!error && data && typeof data === "object") value = data as Record<string, string>;
  }
  stored.set(lang, { at: Date.now(), value });
  return value;
}

/** After the admin saved texts: this server instance reads them again at once. */
export function forgetDatabaseTexts(lang?: string) {
  if (lang) stored.delete(lang);
  else stored.clear();
}

const flatFile = async (lang: string) => {
  const load = (files as Record<string, (() => Promise<Record<string, unknown>>) | undefined>)[lang];
  if (!load) return null;
  return flatten((await load()) as never);
};

/**
 * The texts of a language: Slovak (the source) ← English ← the language's own file (sk, hu, en) ← the database's
 * texts of that language. So a missing key falls back to English, then Slovak; a key name is never shown.
 */
export const getDictionary = cache(async (locale: Locale): Promise<Dictionary> => {
  const [en, own, db] = await Promise.all([locale === "sk" ? null : flatFile("en"), flatFile(locale), databaseTexts(locale)]);
  return layered(sk as unknown as Dictionary, en, own, db) as Dictionary;
});

/**
 * Whether the legal texts (privacy, terms) of a language are machine translations nobody checked yet: then their
 * pages say "Strojový preklad – záväzná je slovenská verzia". Never for sk, hu, en (written by hand).
 */
export async function legalUnchecked(lang: string, prefixes: readonly string[]): Promise<boolean> {
  if ((HANDWRITTEN as readonly string[]).includes(lang)) return false;
  const keys = Object.keys(flatten(sk as never)).filter((k) => prefixes.some((p) => k.startsWith(p)));
  const stored = await databaseTexts(lang);
  if (!stored || keys.some((k) => !stored[k])) return true;
  const db = createPublicClient();
  if (!db) return true;
  const { data, error } = await db.rpc("ui_unchecked", { p_lang: lang });
  if (error || !Array.isArray(data)) return true;
  const unchecked = new Set(data as string[]);
  return keys.some((k) => unchecked.has(k));
}

/** Fill "{n}"-style placeholders: t("Updated {n} min ago", { n: 5 }). */
export { t } from "./messages";

// ---------------------------------------------------------------- which languages are switched on

export interface SiteLanguage {
  code: Locale;
  enabled: boolean;
  /** Pre-translated for PPI's own pages: in the sitemap and hreflang (the others get noindex). */
  indexed: boolean;
}

const languagesAt = { at: 0, value: null as SiteLanguage[] | null };

/**
 * The admin's language settings (site_languages()). Before update 40 (or on an error): only the hand-written
 * languages (sk, hu, en), all indexed.
 */
export const siteLanguages = cache(async (): Promise<SiteLanguage[]> => {
  if (languagesAt.value && Date.now() - languagesAt.at < TTL) return languagesAt.value;
  const db = createPublicClient();
  let rows: SiteLanguage[] | null = null;
  if (db) {
    const { data, error } = await db.rpc("site_languages");
    if (!error && Array.isArray(data)) {
      const known = new Set(LANGUAGES.map((l) => l.code as string));
      rows = (data as SiteLanguage[]).filter((r) => known.has(r.code));
    }
  }
  const value = rows?.some((r) => r.enabled) ? rows : HANDWRITTEN.map((code) => ({ code, enabled: true, indexed: true }));
  languagesAt.at = Date.now();
  languagesAt.value = value;
  return value;
});

export async function enabledLocales(): Promise<Locale[]> {
  return (await siteLanguages()).filter((l) => l.enabled).map((l) => l.code);
}

export async function indexedLocales(): Promise<Locale[]> {
  return (await siteLanguages()).filter((l) => l.enabled && l.indexed).map((l) => l.code);
}
