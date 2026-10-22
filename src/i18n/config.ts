import { LANGUAGES, type LanguageCode } from "./languages";

/** Every language the website knows (src/i18n/languages.ts); the admin switches each on or off (site_languages()). */
export const locales = LANGUAGES.map((l) => l.code) as readonly LanguageCode[];
export type Locale = LanguageCode;

/** Used when the browser asks for no language the website has switched on (update 40: Slovak). */
export const defaultLocale: Locale = "sk";

/** Cookie that remembers the visitor's language choice (functional: no consent needed). */
export const LOCALE_COOKIE = "ppi_lang";

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}
