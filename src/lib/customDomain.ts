import type { Locale } from "@/i18n/config";

/**
 * Addresses on a shop's own domain (database update 25). The front page "/" is in the
 * shop's language (its country: SK → sk, HU → hu, else en — the same rule as the SQL
 * shop_site_lang()); "/hu", "/en" … are the other languages; items are "/{lang}/items/{id}".
 */
export function siteLang(country: string | null | undefined): Locale {
  const c = String(country ?? "").toUpperCase();
  return c === "SK" ? "sk" : c === "HU" ? "hu" : "en";
}

/** The shop's page in this language on its own domain: "/" or "/hu". */
export function sitePath(lang: string, defaultLang: string): string {
  return lang === defaultLang ? "/" : `/${lang}`;
}

export function siteShopUrl(host: string, lang: string, defaultLang: string): string {
  return `https://${host}${lang === defaultLang ? "/" : `/${lang}`}`;
}

export function siteItemUrl(host: string, lang: string, itemId: string): string {
  return `https://${host}/${lang}/items/${itemId}`;
}
