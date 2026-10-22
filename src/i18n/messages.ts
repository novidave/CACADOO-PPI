/**
 * Interface texts as flat keys ("shop.open" → "Otvorené") and back (update 40). Shared by the server, the admin page
 * "Preklady rozhrania", the translation step and the tests (no imports).
 */

export type Messages = { [key: string]: string | Messages };

/** {"shop": {"open": "Otvorené"}} → {"shop.open": "Otvorené"} (strings only). */
export function flatten(tree: Messages, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[key] = v;
    else if (v && typeof v === "object") flatten(v, key, out);
  }
  return out;
}

/**
 * The texts of a language over its fallbacks: every key of `base` (Slovak, the source) is there; each layer replaces
 * only the keys it has (and only with text that is not empty). A key name is never shown: a key no layer has keeps
 * the Slovak text.
 */
export function layered<T extends Messages>(base: T, ...layers: (Record<string, string> | null | undefined)[]): T {
  const flat = flatten(base);
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) if (k in flat && typeof v === "string" && v.trim()) flat[k] = v;
  }
  return unflatten(base, flat) as T;
}

function unflatten(shape: Messages, flat: Record<string, string>, prefix = ""): Messages {
  const out: Messages = {};
  for (const [k, v] of Object.entries(shape)) {
    const key = prefix ? `${prefix}.${k}` : k;
    out[k] = typeof v === "string" ? flat[key] : unflatten(v, flat, key);
  }
  return out;
}

/** The {placeholders} of a text, sorted ("Zostáva {n} slotov" → ["n"]): a translation must keep exactly these. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

/** Keys whose texts are legal (privacy, deletion, terms): machine translations are marked until the admin checks them. */
export const LEGAL_PREFIXES = ["privacy.", "privacy_assistant.", "terms.", "legal."];
export const isLegalKey = (key: string) => LEGAL_PREFIXES.some((p) => key.startsWith(p));
