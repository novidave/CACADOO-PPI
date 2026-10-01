import "server-only";
import type { Locale } from "./config";
import sk from "./messages/sk.json";

export type Dictionary = typeof sk;

const dictionaries: Record<Locale, () => Promise<Dictionary>> = {
  sk: () => import("./messages/sk.json").then((m) => m.default),
  hu: () => import("./messages/hu.json").then((m) => m.default),
  en: () => import("./messages/en.json").then((m) => m.default),
};

export function getDictionary(locale: Locale): Promise<Dictionary> {
  return dictionaries[locale]();
}

/** Fill "{n}"-style placeholders: t("Updated {n} min ago", { n: 5 }). */
export function t(text: string, values: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
}
