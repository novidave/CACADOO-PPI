export const locales = ["sk", "hu", "en"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "sk";

/** Cookie that remembers the visitor's language choice. */
export const LOCALE_COOKIE = "ppi_lang";

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}
