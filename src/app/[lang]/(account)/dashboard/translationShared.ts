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
