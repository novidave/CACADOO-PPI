export const locales = ["sk", "hu", "en"] as const;
export type Locale = (typeof locales)[number];

/** Used when the browser asks for a language PPI does not have yet. */
export const defaultLocale: Locale = "en";

/** Cookie that remembers the visitor's language choice. */
export const LOCALE_COOKIE = "ppi_lang";

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}
