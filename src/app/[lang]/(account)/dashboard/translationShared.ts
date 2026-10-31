import type { Dictionary } from "@/i18n/dictionaries";
import { languageOf } from "@/i18n/languages";

/** The languages as the owner picks them: each in its own name, alphabetically. */
export function languageList(codes: string[]) {
  return codes
    .map((code) => ({ code, native: languageOf(code)?.native ?? code }))
    .sort((a, b) => a.native.localeCompare(b.native));
}

/** The labels of the translation table, from the owner_tr texts. */
export function tableLabels(dict: Dictionary) {
  const o = dict.owner_tr;
  return {
    ...o.table,
    kinds: o.kinds,
    states: o.states,
  };
}

/** The labels of "Texty stránky" (update 62): the table's, the groups of "Čo" and the folded languages. */
export function pageTextLabels(dict: Dictionary) {
  const o = dict.owner_tr;
  return {
    ...tableLabels(dict),
    groups: o.texts.groups,
    show_langs: o.texts.show_langs,
    hide_langs: o.texts.hide_langs,
    langs_count: o.texts.langs_count,
    lacking: o.texts.lacking,
    unavailable: o.texts.unavailable,
  };
}
