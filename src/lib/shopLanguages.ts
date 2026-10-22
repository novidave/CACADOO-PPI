import "server-only";
import { cache } from "react";
import type { Locale } from "@/i18n/config";
import { enabledLocales, indexedLocales } from "@/i18n/dictionaries";
import { isLocale } from "@/i18n/config";
import { createCachedPublicClient } from "@/lib/supabase/public";
import { siteLang } from "./customDomain";

/**
 * A shop's language settings (update 40, Môj obchod → Jazyky): the language it writes in (the translation source),
 * the languages of its stock files, its preferred languages (pre-translated, first in the picker, in its sitemap) and
 * the default language of its own domain.
 */
export interface ShopLanguages {
  main: Locale;
  inventory: Locale[];
  preferred: Locale[];
  /** "/" on the shop's own domain. */
  home: Locale;
  /** Pre-translated: hreflang and sitemap; the other switched-on languages get noindex on the shop's pages. */
  indexed: Locale[];
}

interface Row {
  main_lang: string;
  inventory_langs: string[] | null;
  preferred_langs: string[] | null;
  domain_lang: string | null;
}

/**
 * shop_languages(slug); before update 40 (or without settings): the shop's country language (SK → sk, HU → hu, else
 * en), preferred = the main site's pre-translated languages.
 */
export const getShopLanguages = cache(async (slug: string, country: string | null): Promise<ShopLanguages> => {
  const [enabled, mainIndexed] = await Promise.all([enabledLocales(), indexedLocales()]);
  const db = createCachedPublicClient();
  let row: Row | null = null;
  if (db) {
    const { data, error } = await db.rpc("shop_languages", { p_slug: slug });
    if (!error && data) row = (Array.isArray(data) ? data[0] : data) as Row | null;
  }
  const ok = (codes: (string | null | undefined)[] | null | undefined) =>
    (codes ?? []).filter((c): c is Locale => isLocale(c) && enabled.includes(c as Locale));
  const fallback = siteLang(country);
  const main = ok([row?.main_lang])[0] ?? fallback;
  const preferred = row ? ok(row.preferred_langs) : mainIndexed;
  const home = ok([row?.domain_lang])[0] ?? main;
  const indexed = [...new Set([main, home, ...preferred])].filter((l) => enabled.includes(l));
  return { main, inventory: ok(row?.inventory_langs).length ? ok(row?.inventory_langs) : [main], preferred, home, indexed };
});
