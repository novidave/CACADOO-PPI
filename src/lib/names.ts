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
