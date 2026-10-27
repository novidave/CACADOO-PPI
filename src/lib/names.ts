import type { Locale } from "@/i18n/config";

/** An item's name in plain Slovak, Hungarian and English (shop_items.name_i18n). */
export type NameI18n = Partial<Record<Locale, string>>;

const plain = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * The item's name in the page language, shown under the name the shop wrote:
 * null when there is no translation yet or it reads the same as the original.
 */
export function translatedName(original: string, names: NameI18n | null | undefined, lang: Locale): string | null {
  const translated = names?.[lang]?.trim();
  return translated && plain(translated) !== plain(original) ? translated : null;
}

/**
 * How an item's name is shown in lists and on its page: the name in the page language first (dark), the name as the
 * shop wrote it under it (light). Without a translation (or the same words) only the shop's name.
 */
export function itemNames(original: string, names: NameI18n | null | undefined, lang: Locale): { primary: string; secondary: string | null } {
  const translated = translatedName(original, names, lang);
  return translated ? { primary: translated, secondary: original } : { primary: original, secondary: null };
}
